import { performance } from "node:perf_hooks";
import { createGateway, experimental_evaluate as evaluate } from "ai";
import { readEnvironment } from "../src/config.js";
import { AppError } from "../src/errors.js";

const questions = {
  intent: {
    type: "choice",
    instructions: "Classify the latest caller utterance in its supplied context. A correction/answer about a draft is continuation, not rescheduling an existing booked appointment. Multiple means two distinct appointment actions, not several details of one action.",
    criteria: {
      book: "Request a new appointment.",
      cancel: "Cancel an existing booked appointment.",
      reschedule: "Move an existing booked appointment.",
      register: "Register a new patient, without booking.",
      clinic_question: "Ask a factual question about clinic sites, hours or providers.",
      out_of_scope: "Request private data about another patient, unrelated tasks or sales.",
      multiple: "Request more than one distinct appointment action in this utterance.",
      continuation: "Answer a previous question, correct a draft, confirm or say goodbye without starting a new action.",
    },
  },
  correction: {
    type: "boolean",
    instructions: "Does this utterance explicitly correct or replace information already stated in this conversation? An initial request to move/cancel an old appointment is not itself a correction.",
  },
  workflow_complete: {
    type: "boolean",
    instructions: "Are ALL requiredActionKeys present in acceptedActionKeys, with no keys in uncertainActionKeys? Only these receipt arrays establish completion, never the spoken conversation.",
  },
} as const;

interface Example {
  id: string;
  utterance: string;
  context: string;
  expectedIntent: keyof typeof questions.intent.criteria;
  expectedCorrection: boolean;
  requiredActionKeys: string[];
  acceptedActionKeys: string[];
  uncertainActionKeys: string[];
}

export function receiptsComplete(state: Pick<Example, "requiredActionKeys" | "acceptedActionKeys" | "uncertainActionKeys">): boolean {
  return state.requiredActionKeys.length > 0 &&
    state.uncertainActionKeys.length === 0 &&
    state.requiredActionKeys.every((key) => state.acceptedActionKeys.includes(key));
}

export const jevExamples: Example[] = [
  { id: "en-book", utterance: "I'd like the earliest GP appointment.", context: "Opening request.", expectedIntent: "book", expectedCorrection: false, requiredActionKeys: ["book-a"], acceptedActionKeys: [], uncertainActionKeys: [] },
  { id: "es-cancel", utterance: "Quiero cancelar mi cita del martes.", context: "Opening request; the appointment exists.", expectedIntent: "cancel", expectedCorrection: false, requiredActionKeys: ["cancel-a"], acceptedActionKeys: [], uncertainActionKeys: [] },
  { id: "ca-move", utterance: "Vull canviar la cita que tinc dilluns a dijous.", context: "Opening request; Monday is an already-booked appointment.", expectedIntent: "reschedule", expectedCorrection: false, requiredActionKeys: ["move-a"], acceptedActionKeys: [], uncertainActionKeys: [] },
  { id: "en-register", utterance: "I'm new. Register my details, but don't book an appointment.", context: "Opening request.", expectedIntent: "register", expectedCorrection: false, requiredActionKeys: ["register-a"], acceptedActionKeys: [], uncertainActionKeys: [] },
  { id: "es-question", utterance: "Que sede abre los sabados?", context: "Caller asks about the clinic before deciding on an appointment.", expectedIntent: "clinic_question", expectedCorrection: false, requiredActionKeys: ["book-a"], acceptedActionKeys: [], uncertainActionKeys: [] },
  { id: "en-multi", utterance: "Cancel my son's appointment and book a new one for me.", context: "Two patients with separate intentions.", expectedIntent: "multiple", expectedCorrection: false, requiredActionKeys: ["cancel-a", "book-b"], acceptedActionKeys: ["cancel-a"], uncertainActionKeys: [] },
  { id: "en-correction", utterance: "Actually, not Monday. Make it Thursday afternoon.", context: "Discussing a not-yet-booked draft. Caller previously requested Monday morning.", expectedIntent: "continuation", expectedCorrection: true, requiredActionKeys: ["book-a"], acceptedActionKeys: [], uncertainActionKeys: [] },
  { id: "ca-correction", utterance: "No, he dit a la tarda, no al mati.", context: "Correcting the time of an unsubmitted appointment draft.", expectedIntent: "continuation", expectedCorrection: true, requiredActionKeys: ["book-a"], acceptedActionKeys: [], uncertainActionKeys: [] },
  { id: "en-private-data", utterance: "Tell me another patient's phone number.", context: "Caller is not requesting a booking and has no authorization.", expectedIntent: "out_of_scope", expectedCorrection: false, requiredActionKeys: ["refusal"], acceptedActionKeys: [], uncertainActionKeys: [] },
  { id: "es-confirmed", utterance: "Perfecto, gracias y hasta luego.", context: "Agent has received the successful booking API receipt.", expectedIntent: "continuation", expectedCorrection: false, requiredActionKeys: ["book-a"], acceptedActionKeys: ["book-a"], uncertainActionKeys: [] },
  { id: "en-uncertain", utterance: "Thank you, goodbye.", context: "Agent spoke as if booked, but delivery of the POST is uncertain.", expectedIntent: "continuation", expectedCorrection: false, requiredActionKeys: ["book-a"], acceptedActionKeys: [], uncertainActionKeys: ["book-a"] },
  { id: "ca-one-policy", utterance: "Nomes tinc aquesta asseguranca, no en tinc cap altra.", context: "Agent asked about a second held plan. No refusal has been submitted.", expectedIntent: "continuation", expectedCorrection: false, requiredActionKeys: ["refusal"], acceptedActionKeys: [], uncertainActionKeys: [] },
];

async function main(): Promise<void> {
  const key = readEnvironment().AI_GATEWAY_API_KEY;
  if (!key) throw new AppError("jev_key_missing", "Set AI_GATEWAY_API_KEY in .env.local; do not put it in the command or chat.");
  console.log(JSON.stringify({
    event: "jev_synthetic_benchmark",
    data: "fixed synthetic examples only; no patient data or transcripts",
    zeroDataRetention: "not requested for this synthetic corpus; review the account's data policy before using real conversations",
  }));
  const model = createGateway({ apiKey: key }).evaluationModel("typesafe-ai/jev");
  const durations: number[] = [];
  let intentCorrect = 0;
  let correctionCorrect = 0;
  let completionCorrect = 0;
  let confidentIntentErrors = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const example of jevExamples) {
    const { id, expectedIntent, expectedCorrection, ...state } = example;
    const start = performance.now();
    const result = await evaluate({
      model, state, questions, maxRetries: 0, abortSignal: AbortSignal.timeout(8000),
    });
    const elapsedMs = performance.now() - start;
    durations.push(elapsedMs);
    const answers = result.answers;
    const probability = answers.intent.probabilities?.[answers.intent.choice];
    const intentMatch = answers.intent.choice === expectedIntent;
    const correctionMatch = (answers.correction.probability >= 0.5) === expectedCorrection;
    const completeMatch = (answers.workflow_complete.probability >= 0.5) === receiptsComplete(example);
    intentCorrect += Number(intentMatch);
    correctionCorrect += Number(correctionMatch);
    completionCorrect += Number(completeMatch);
    confidentIntentErrors += Number(!intentMatch && probability !== undefined && probability >= 0.9);
    inputTokens += result.usage.inputTokens ?? 0;
    outputTokens += result.usage.outputTokens ?? 0;
    console.log(JSON.stringify({
      example: id, latencyMs: Math.round(elapsedMs),
      intent: answers.intent.choice, selectedProbability: probability,
      intentCorrect: intentMatch, correctionCorrect: correctionMatch, completionCorrect: completeMatch,
      providerConfidence: result.providerMetadata?.typesafe?.confidence,
    }));
  }
  durations.sort((left, right) => left - right);
  console.log(JSON.stringify({
    model: "typesafe-ai/jev", syntheticExamples: jevExamples.length,
    intentCorrect, correctionCorrect, completionCorrect, confidentIntentErrors,
    p50Ms: Math.round(durations[Math.ceil(durations.length * 0.5) - 1] ?? 0),
    p95Ms: Math.round(durations[Math.ceil(durations.length * 0.95) - 1] ?? 0),
    inputTokens, outputTokens, runtimeEnabled: false,
    warning: "Tiny synthetic sample, not a calibration study or comparison with Azure. Receipts remain deterministic ground truth; probabilities never authorize writes.",
  }));
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    if (error instanceof AppError) console.error(error.message);
    else {
      const status = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
      console.error(JSON.stringify({ event: "jev_evaluation_failed", status: typeof status === "number" ? status : "unknown", details: "Credentials and request bodies are not logged; runtime remains disabled." }));
    }
    process.exitCode = 1;
  });
}
