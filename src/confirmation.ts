import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "./errors.js";
import { normalizeHumanText } from "./prosper-types.js";

const priceTopic = /\b(?:costs?|prices?|fees?|charges?|pay|payment|co[- ]?pay(?:ment)?s?|precio|coste|costo|cuesta|costar|costaria|costara|copago|tarifa|pagar|pagare|cobran|cobrar(?:an|ia|ian|ien)?|preu|costa|copagament)\b/;
const priceQuestion = /^(?:how much|what|do i|does|will i|would i|is there|is that|cuanto|cual|hay|tengo que|quant|quin|quina|que|hi ha|cal)\b|\b(?:can|could|would)\s+you\s+(?:please\s+)?(?:tell|explain|confirm|quote)\b|\b(?:puedes|puede|podrias|podria)\s+(?:decirme|decir|explicar|confirmar)\b|\b(?:pots|podeu|podries)\s+(?:dir|explicar|confirmar)\b|^(?:i (?:need|want) to|i'd like to|i would like to)\s+(?:know|check|confirm|understand)\b|^(?:necesito|quiero|quisiera|vull|necessito|voldria)\s+(?:saber|comprobar|comprovar|confirmar)\b/;
const beforeAgreement = /\b(?:before (?:i )?(?:agree|accept|confirm|book)|antes de (?:aceptar|confirmar|reservar)|abans (?:de |d')(?:acceptar|confirmar|reservar))\b/;
const bookingPause = /\b(?:hold off|put off|postpone|defer)\s+(?:on\s+)?(?:booking|reserving|scheduling|the booking|the appointment)\b|\bhold off for now\b|\b(?:don't|do not)\s+(?:book|reserve|schedule)\b[^.!?;]{0,60}\b(?:yet|for now|until)\b|\bno\s+(?:reserves|reserve|reservis)\b[^.!?;]{0,40}\b(?:todavia|aun|encara|por ahora|de momento|per ara|de moment)\b|\b(?:todavia|aun|encara|por ahora|de momento|per ara|de moment)\s+no\s+(?:reserves|reserve|reservis)\b/;
const selfWaiting = /\bi(?:'ll| will| would| prefer to| want to|'d rather|'d prefer to)\s+(?:wait|hold off|call back)\b|\b(?:esperare|prefiero esperar|quiero esperar|volvere a llamar|prefereixo esperar|vull esperar|trucare mes tard)\b/;
const selfPriceCheck = /\b(?:i(?:'ll| will| need to| want to| have to)|let me)\s+(?:check|confirm|find out)\b|\b(?:quiero|necesito|voy a|vull|necessito|he de)\s+(?:consultar|comprobar|comprovar|confirmar|saber)\b|\b(?:consultare|comprobare|confirmare)\b/;
const permissionTopic = String.raw`(?:permission|consent|authori[sz]ation|permiso|autorizacion|consentimiento|permis|autoritzacio|consentiment)`;
const permissionUnavailable = new RegExp(
  String.raw`\b(?:don't have|do not have|haven't got|have not got|have not received|haven't received|without|no tengo|no tenemos|no tinc|no tenim|sense|sin)\b[^.!?;]{0,65}\b${permissionTopic}\b|\b(?:hasn't|has not|haven't|have not|didn't|did not)\s+(?:given|give)\b[^.!?;]{0,50}\b${permissionTopic}\b|\b(?:not|hasn't|has not)\s+(?:been\s+)?authori[sz]ed\b|\bno\s+(?:estoy|esta|estic|estan)\s+autori(?:zad[oa]|tzat|tzada)\b|\bno\s+(?:me|nos)\s+(?:ha|han)\s+(?:autorizado|dado (?:su )?permiso)\b|\bno\s+(?:m'ha|m'han)\s+(?:autoritzat|donat (?:el seu )?permis)\b|\b(?:need to|have to|must)\s+(?:ask|get|obtain)\b[^.!?;]{0,60}\b${permissionTopic}\b|\b(?:tengo que|he de|haig de)\s+(?:pedir|pedirle|demanar)\b[^.!?;]{0,50}\b${permissionTopic}\b`,
);
const waitingForPermission = new RegExp(
  String.raw`\bwait(?:ing)?\s+(?:for|until (?:i|we) (?:have|get|receive))\s+(?:(?:his|her|their|the patient's)\s+)?${permissionTopic}\b|\b(?:esperar|esperare)\s+(?:hasta|fins(?: a)?)\s+(?:tener|recibir|tenir|rebre)\b[^.!?;,]{0,30}\b${permissionTopic}\b`,
);

function normalizeTranscript(text: string): string {
  return normalizeHumanText(text).replace(/[’‘]/g, "'");
}

function hasPriceQuestion(normalized: string): boolean {
  return normalized.split(/[.!?;,\n]+/).some((part) => {
    const clause = part.trim().replace(/^[¿¡]+/, "").replace(/^(?:(?:yes|okay|ok|well|so|si|d'acord)\s+)+/, "");
    return /^(?:how much (?:is|would|will|do|does)|cuanto (?:es|seria)|quant (?:es|seria))\b/.test(clause) ||
      priceTopic.test(clause) && (priceQuestion.test(clause) || beforeAgreement.test(clause));
  });
}

function hasAffirmativeCue(normalized: string, cue: RegExp): boolean {
  return [...normalized.matchAll(new RegExp(cue.source, "g"))].some((match) =>
    !/\b(?:no|not|never|don't|do not|won't|will not)(?:\s+(?:want|need|wish)(?:\s+to)?)?\s+$/.test(
      normalized.slice(0, match.index),
    ));
}

function hasBookingDeferral(normalized: string): boolean {
  if (hasAffirmativeCue(normalized, bookingPause)) return true;
  if (hasAffirmativeCue(normalized, selfWaiting) &&
      (priceTopic.test(normalized) || /\b(?:booking|appointment|for now|before booking|cita|reserva|por ahora|de momento|per ara|de moment)\b/.test(normalized))) return true;
  return hasAffirmativeCue(normalized, selfPriceCheck) && priceTopic.test(normalized) &&
    (/\b(?:first|primero|primer)\b/.test(normalized) || beforeAgreement.test(normalized));
}

/** Deferring an otherwise voluntary booking is not evidence of missing authority. */
export function hasVoluntarySelfDeferral(text: string): boolean {
  const normalized = normalizeTranscript(text);
  return hasBookingDeferral(normalized) && !permissionUnavailable.test(normalized) && !waitingForPermission.test(normalized);
}

export function hasUnresolvedQualification(text: string): boolean {
  const normalized = normalizeTranscript(text);
  if (hasPriceQuestion(normalized) || hasBookingDeferral(normalized)) return true;
  if (/\b(?:but|however|except|instead|actually|pero|sin embargo|en realidad|en vez|en canvi|en lloc)\b/.test(normalized)) return true;
  if (/\b(?:can|could|would|may)\s+(?:you|we|i)\s+(?:check|look|find|see|try|change|move)\b/.test(normalized)) return true;
  if (/\b(?:puedes|podrias|puede|podria|podries|pots)\s+(?:mirar|comprobar|buscar|canviar|cambiar|revisar|comprovar)\b/.test(normalized)) return true;
  if (/\b(?:don't|do not|no)\s+(?:book|cancel|move|proceed|register|reserve|reserves|canceles|reservis)\b/.test(normalized)) return true;
  return /^(?:no|not|wait|stop|espera|esperi)\b/.test(normalized) &&
    !/^(?:no problem|no worries|no hay problema|no tengo inconveniente)\b/.test(normalized);
}

const schedulingSubject = String.raw`(?:doctors?|providers?|physicians?|specialists?|dermatologists?|orthopaedists?|physiotherapists?|medicos?|medicas?|doctores?|doctoras?|especialistas?|dermatolog[oa]s?|traumatolog[oa]s?|fisioterapeut[ae]s?|metges?|metgesses?|dermatolegs?|especialistes?|sites?|locations?|clinics?|cent(?:er|re)s?|sedes?|centros?|cliniques?|llocs?|seus?|appointments?|slots?|times?|dates?|days?|mornings?|afternoons?|citas?|horas?|horarios?|fechas?|dias?|mananas?|tard[ae]s?|cites?|hores?|horaris?|dates?|dies?|mati(?:ns)?)`;
const alternativeSubject = new RegExp(
  String.raw`\b(?:another|other|different|any(?: other)?|otro|otra|otros|otras|cualquier|cualquiera|algun|alguna|un altre|una altra|altres?|altra|qualsevol|diferente|distinto|distinta|diferent)\s+(?:(?:available|eligible|covered|disponible)\s+)?${schedulingSubject}\b`,
);
const schedulingDetail = new RegExp(
  String.raw`\b(?:${schedulingSubject}|physiotherapy|dermatology|orthopaedics|orthopedics|paediatrics|pediatrics|gynaecology|gynecology|general practice|fisioterapia|dermatologia|traumatologia|pediatria|ginecologia|medicina general|monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|miercoles|jueves|viernes|sabado|domingo|dilluns|dimarts|dimecres|dijous|divendres|dissabte|diumenge)\b`,
);
const alternativeIntent = /\b(?:want|need|prefer|accept|try|check|look|find|search|book|see|please|can|could|would|is there|are there|fine|okay|ok|works?|will do|quiero|necesito|prefiero|acepto|busca|buscar|mira|mirar|prueba|puedes|podrias|puede|sirve|vale|bien|hay|vull|necessito|prefereixo|accepto|busquis|cerca|miri|pots|podries|podeu|be|hi ha)\b/;
const searchRequest = /^(?:(?:please|then|just|now|entonces|pues|por favor|doncs|si us plau)\s+)*(?:search|check|look|try|find|keep (?:looking|searching)|busca|busque|buscad|mira|mire|comprueba|revisa|prueba|cerqui|cerca|comprova|prova)\b|\b(?:can|could|would|will)\s+(?:you|we)\s+(?:please\s+)?(?:check|look|find|search|try|change|move)\b|\b(?:puedes|podrias|puede|podria|podemos|pots|podries|podeu|podem)\s+(?:mirar|buscar|comprobar|revisar|probar|cambiar|cercar|comprovar|provar|canviar)\b|\b(?:i (?:want|need)|i'd like|i would like)\s+(?:you\s+)?to\s+(?:check|look|find|search|try)\b/;
const registrationRequest = /\b(?:register|registering|registration|sign up|registrarme|registrar(?:-me)?|registreu-me|inscribirme|inscriure'm|inscriure-me|darme de alta|donar-me d'alta|donar-me de alta)\b/;
const correctionRequest = /\b(?:i meant|i asked for|i said|actually|rather than|me referia|he pedido|pedi|en realidad|queria decir|he demanat|volia dir|vull dir|en lloc de)\b/;
const negatedRequest = /\b(?:don't|do not|wouldn't|would not|will not|won't|cannot|can't|no longer)\s+(?:(?:really|actually)\s+)?(?:want|need|prefer|accept|wish|plan|check|look|find|search|try|register|book|see|choose)\b|\b(?:not interested|not willing|not looking|prefer not to|decline|reject)\b|\bno\s+(?:(?:me|em|nos|ens)\s+)?(?:quiero|necesito|prefiero|acepto|deseo|busques|busque|busquis|busqui|mires|mire|miris|miri|vull|cal|m'interessa|hay|queda)\b|\b(?:not (?:acceptable|okay|ok|fine|an option)|doesn't work|won't work|no me (?:sirve|va bien|interesa)|no em (?:serveix|va be|interessa))\b/;
const negatedAlternative = new RegExp(
  String.raw`\b(?:no|not|neither|nor|ningun|ninguna|cap)\s+(?:another|other|different|otro|otra|otros|otras|altre|altra|altres)\s+${schedulingSubject}\b`,
);
const clinicOutcomeReasons = new Set([
  "not_eligible_age", "referral_required", "provider_not_in_network", "specialty_not_covered",
  "location_not_covered", "insurer_referral_required", "allowance_exhausted", "provider_on_leave",
  "location_hours", "type_not_offered", "patient_history", "no_availability", "clinic_closed",
  "patient_not_found", "provider_not_found",
]);

/** Recognizes unresolved requests, never consent or the reason for a refusal. */
export function hasUnresolvedOutcomeRequest(text: string): boolean {
  const normalized = normalizeTranscript(text)
    .replace(/\b(?:don't|do not) mind\b/g, "accept")
    .replace(/\bno,\s*(?=(?:i need|i want|necesito|quiero|vull|necessito)\b)/g, "actually ");
  const clauses = normalized.split(
    /[.!?;:,\n]+|\b(?:but|however|pero|sino|en canvi)\b|\b(?:and|y|i)\s+(?=(?:please|can you|could you|i want|i need|i'd like|quiero|necesito|vull|necessito|pots|puedes)\b)/,
  );
  return clauses.some((part) => {
    const clause = part.trim();
    if (!clause || negatedRequest.test(clause) || negatedAlternative.test(clause)) return false;
    if (registrationRequest.test(clause) || searchRequest.test(clause)) return true;
    if (correctionRequest.test(clause) && schedulingDetail.test(clause)) return true;
    if (/\b(?:what(?:'s| is)|when(?:'s| is))\s+(?:the\s+)?(?:earliest|soonest|next)\b|\b(?:cual|quan|quina)\s+(?:es\s+)?(?:la\s+)?(?:primera|proxima)\s+cita\b/.test(clause)) return true;
    const alternative = alternativeSubject.exec(clause);
    if (alternative && (alternative.index === 0 || alternativeIntent.test(clause))) return true;
    return /\b(?:whoever|any (?:doctor|provider|specialist)|cualquiera|qualsevol)\b/.test(clause) &&
      /\b(?:accepts?|takes?|covered|insurance|plan|policy|acepte|acepta|seguro|aseguradora|accepti|accepta|asseguranca|mutua)\b/.test(clause);
  });
}

/** A rejection guard, not a classifier that grants consent or authorizes a write. */
export class ConfirmationGate {
  private readonly transcripts = new Map<number, { text: string; receivedAt: number }>();

  constructor(
    private readonly currentTurn: () => number,
    private readonly signal: AbortSignal,
  ) {}

  observe(turn: number, text: string): void {
    if (!Number.isSafeInteger(turn) || turn < 1 || text.length > 32_000) throw new AppError("invalid_confirmation_transcript");
    this.transcripts.set(turn, { text, receivedAt: performance.now() });
    for (const known of this.transcripts.keys()) if (known < this.currentTurn() - 2) this.transcripts.delete(known);
  }

  async review(turn: number): Promise<void> {
    await this.reviewTranscript(turn, {
      pendingCode: "confirmation_transcript_pending",
      pendingMessage: "The current caller turn has not been transcribed yet. Nothing was submitted. Wait for the completed turn or ask a short confirmation of the final details.",
      reject: hasUnresolvedQualification,
      rejectionCode: "confirmation_needs_clarification",
      rejectionMessage: "The caller's confirmation contains a condition, correction, unresolved price question or request to check an alternative. Do not submit it. Resolve that condition and obtain unqualified confirmation of the final details.",
    });
  }

  /** For a fresh NO_ACTION, not emergency escalation or an identical accepted-action retry. */
  async reviewOutcome(turn: number, reason: string): Promise<void> {
    if (reason === "medical_emergency") return;
    const checkVoluntaryDeferral = reason === "caller_not_authorised";
    await this.reviewTranscript(turn, {
      pendingCode: "outcome_transcript_pending",
      pendingMessage: "The current caller turn has not been fully transcribed yet. Nothing was submitted. Wait for that turn; do not ask for an extra refusal confirmation.",
      reject: (text) => checkVoluntaryDeferral
        ? hasVoluntarySelfDeferral(text)
        : clinicOutcomeReasons.has(reason) && hasUnresolvedOutcomeRequest(text),
      rejectionCode: checkVoluntaryDeferral ? "outcome_reason_not_supported" : "outcome_request_unresolved",
      rejectionMessage: checkVoluntaryDeferral
        ? "The caller explicitly chose to defer booking; this is not evidence that they lack permission. Do not submit caller_not_authorised or substitute another refusal reason. Keep the action unconfirmed and respect the caller's condition."
        : "The current caller turn still requests an alternative, a correction, a search or registration. Do not submit NO_ACTION. Resolve the latest request first; having no second policy does not mean acceptable alternatives are exhausted.",
    });
  }

  private async reviewTranscript(turn: number, rule: {
    pendingCode: string;
    pendingMessage: string;
    reject: (text: string) => boolean;
    rejectionCode: string;
    rejectionMessage: string;
  }): Promise<void> {
    const deadline = performance.now() + 2000;
    const current = () => {
      if (this.signal.aborted) throw new AppError("call_cancelled");
      if (turn !== this.currentTurn()) throw new AppError("stale_turn", "The caller spoke again; review their latest request before submitting.");
    };
    current();
    while (!this.transcripts.get(turn)?.text.trim()) {
      if (performance.now() >= deadline) {
        throw new AppError(rule.pendingCode, rule.pendingMessage);
      }
      await delay(25);
      current();
    }
    for (;;) {
      current();
      const transcript = this.transcripts.get(turn);
      if (!transcript?.text.trim()) throw new AppError(rule.pendingCode, rule.pendingMessage);
      if (rule.reject(transcript.text)) throw new AppError(rule.rejectionCode, rule.rejectionMessage);
      const remaining = transcript.receivedAt + 500 - performance.now();
      if (remaining <= 0) return;
      await delay(remaining);
    }
  }
}
