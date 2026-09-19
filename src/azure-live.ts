import { DefaultAzureCredential } from "@azure/identity";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import WebSocket from "ws";
import { z } from "zod";
import type { VoiceContext, VoiceFactory, VoiceSession } from "./azure-realtime.js";
import type { Config } from "./config.js";
import type { CallRecordEvent } from "./call-records.js";
import { AppError, errorCode } from "./errors.js";
import { LiveTranscriptState } from "./live-transcript.js";
import { decodeAudio } from "./protocol.js";
import type { ProsperClient } from "./prosper.js";
import { Receptionist, receptionistInstructions, receptionistTools } from "./receptionist.js";
import { log, withSpan } from "./telemetry.js";

export interface AzureLiveDependencies {
  createWebSocket?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  getToken?: (signal: AbortSignal) => Promise<{ token: string } | null>;
  transcriptSettleMs?: number;
  closeTimeoutMs?: number;
}

interface BackendResponse {
  id: string;
  delegation: string;
  generation: number;
  span: Span;
  done: boolean;
  toolCalls: number;
  continuationNeeded: boolean;
}

const eventSchema = z.object({
  type: z.string(),
  event_id: z.string().min(1).max(256).optional(),
}).passthrough();
const transcriptSchema = z.object({
  event_id: z.string().min(1).max(256).optional(),
  delta: z.string().max(32_000),
  start_ms: z.number().nonnegative(),
  end_ms: z.number().nonnegative(),
}).refine((event) => event.end_ms >= event.start_ms);
const functionItemSchema = z.object({
  type: z.literal("function_call"),
  call_id: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
  arguments: z.string().max(8192),
});
const responseSchema = z.object({
  id: z.string().min(1).max(256),
  status: z.string().optional(),
  usage: z.object({ input_tokens: z.number().nonnegative(), output_tokens: z.number().nonnegative() }).nullish(),
});
const idsSchema = z.object({
  proposal_id: z.string().optional(),
  proposal_ids: z.array(z.string()).optional(),
});

export function azureLiveUrl(config: Config): string {
  const url = new URL("/openai/v1/live/sessions", config.AZURE_OPENAI_ENDPOINT);
  url.protocol = "wss:";
  return url.toString();
}

export function liveInstructions(): string {
  return [
    "You are Clinica Arenal's live voice receptionist. Start in English, then follow the caller's English, Spanish or Catalan.",
    "Listen while speaking. Use one short question at a time; let fragmented names, numbers, corrections and long pauses finish. A backchannel is not booking consent.",
    "Delegate ALL patient identification, clinic facts, dates, insurance checks, availability, registration and appointment actions to the configured backend. Never invent facts, IDs, prices or a completed action.",
    "An ordinary booking is not registration. Ask the backend to look up the patient using their full name plus ONE supplied identifier (birth date, phone or DNI/NIE). Do not start registration merely because the caller dictates demographics. Registration requires an explicit new-patient/registration request.",
    "Keep the actual patient separate from a relative calling. Ask only missing details; never read stored national IDs, phone numbers, private records or internal tool names aloud.",
    "Use the backend's verified result. When it prepares a proposal, read the exact human details, ask for explicit approval and wait. After the caller agrees, create a NEW delegation to confirm the proposal. Preparing an offer is not submitting it.",
    "If the caller corrects anything or asks an unresolved question, delegate the change rather than confirming the old proposal. Say booked, cancelled or registered only after an accepted/duplicate receipt.",
    "Refusals also require a backend report before the final goodbye, but not another booking-style consent question. Do not substitute a fabricated reason or fee for a missing fact.",
    "For a published medical-emergency red flag, delegate urgent escalation immediately; do not wait for identity or offer an appointment. Give no diagnosis or treatment advice.",
    "Keep answers concise. Default to one earliest eligible matching offer rather than a menu; honor explicit alternatives. For registration, ask the next missing-field group, not the whole insurer catalogue.",
    "Interrupting speech does not undo a backend action. Use the backend's authoritative state before repeating or replacing any work.",
  ].join("\n");
}

export function liveSessionConfiguration(config: Config, call: Pick<VoiceContext, "startedAt" | "allowSubmissions">) {
  return {
    model: config.AZURE_OPENAI_LIVE_DEPLOYMENT,
    instructions: liveInstructions(),
    audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: config.AZURE_OPENAI_LIVE_VOICE } },
    delegation: {
      type: "responses",
      responses: {
        model: config.AZURE_OPENAI_LIVE_BACKEND_DEPLOYMENT,
        instructions: [
          receptionistInstructions(call.startedAt ?? new Date(), call.allowSubmissions === true),
          "You are the tool/reasoning backend for a separate full-duplex voice model, not the speaker. Return concise verified facts, current action status and the next necessary question. The voice model may paraphrase them.",
          "Transcripts are partial and can be corrected. Follow the latest caller request. Tools and this application, not your prose, own identity, constraints and receipts.",
          "An ordinary booking is not registration: use find_patient with the caller's full name and one supplied corroborating field first. A birth date already supplies that field; do not ask for DNI as well. Use collect_registration only when the caller explicitly requests registration or identifies themselves as a new patient. Dictating demographics alone does not authorize changing workflows.",
          "After preparing any proposal, return its exact human-readable readback and request confirmation, then STOP this delegation. Never call confirm_action/confirm_actions in the same Live delegation that prepared those proposals. A NEW delegation after a later explicit caller approval is required.",
          "A stale/pending/qualification error means no new action was approved. Use get_call_state and the latest caller context, resolve the question or correction, and never invent consent or an outcome to work around the guard.",
        ].join("\n"),
        tools: receptionistTools.map((tool) => ({ ...tool, strict: false })),
        tool_choice: "auto",
        parallel_tool_calls: false,
        max_output_tokens: 2048,
        reasoning: { effort: "low" },
        text: { verbosity: "low" },
      },
    },
  };
}

export function createAzureLiveVoiceFactory(
  config: Config,
  prosper: ProsperClient,
  dependencies: AzureLiveDependencies = {},
): VoiceFactory {
  let credential: DefaultAzureCredential | undefined;
  const getToken = dependencies.getToken ?? ((signal: AbortSignal) => {
    credential ??= new DefaultAzureCredential(
      config.AZURE_CLIENT_ID ? { managedIdentityClientId: config.AZURE_CLIENT_ID } : {},
    );
    return credential.getToken("https://cognitiveservices.azure.com/.default", { abortSignal: signal });
  });
  const createWebSocket = dependencies.createWebSocket ?? ((url, options) => new WebSocket(url, options));
  return (call) => withSpan("azure.live.connect", {
    "gen_ai.system": "azure.ai.openai",
    "gen_ai.request.model": config.AZURE_OPENAI_LIVE_DEPLOYMENT,
    "server.address": new URL(config.AZURE_OPENAI_ENDPOINT).hostname,
  }, call.parent, async () => {
    if (call.signal.aborted) throw new AppError("call_cancelled");
    let headers: Record<string, string>;
    if (config.AZURE_OPENAI_API_KEY) headers = { "api-key": config.AZURE_OPENAI_API_KEY };
    else {
      try {
        const token = await getToken(call.signal);
        if (!token) throw new AppError("azure_authentication_failed");
        headers = { Authorization: `Bearer ${token.token}` };
      } catch {
        throw new AppError(call.signal.aborted ? "call_cancelled" : "azure_authentication_failed");
      }
    }
    if (call.signal.aborted) throw new AppError("call_cancelled");

    return new Promise<VoiceSession>((resolve, reject) => {
      const socket = createWebSocket(azureLiveUrl(config), {
        headers, handshakeTimeout: 10_000, maxPayload: 2 * 1024 * 1024, followRedirects: false,
      });
      const operations = new AbortController();
      const signal = AbortSignal.any([call.signal, operations.signal]);
      const transcripts = new LiveTranscriptState(signal, dependencies.transcriptSettleMs);
      const events = new Set<string>();
      const calls = new Set<string>();
      const responses = new Map<string, BackendResponse>();
      const currentResponses = new Map<string, string>();
      const delegationGenerations = new Map<string, number>();
      const proposalDelegations = new Map<string, string>();
      const confirmedProposals = new Set<string>();
      const inputFrames: Buffer[] = [];
      const silence = Buffer.alloc(160, 0xff).toString("base64");
      const transportClosed = Promise.withResolvers<void>();
      let ready = false;
      let closing = false;
      let finalized = false;
      let failed = false;
      let closePromise: Promise<void> | undefined;
      let toolQueue = Promise.resolve();
      let runningTools = 0;
      let pendingCreate: { generation: number } | undefined;
      let typedPending = false;
      let contextVersion = 0;
      let sequence = 0;
      let outputId: string | undefined;
      let outputStartMs: number | undefined;
      let outputIdle: NodeJS.Timeout | undefined;
      let inputClock: NodeJS.Timeout | undefined;
      let greeting: NodeJS.Timeout | undefined;
      let executingDelegation: string | undefined;

      const record = (event: CallRecordEvent) => {
        if (event.type === "action") {
          if (event.stage === "proposed" && executingDelegation) {
            proposalDelegations.set(event.proposalId, executingDelegation);
          }
          if (["confirmed", "accepted", "duplicate", "unknown"].includes(event.stage)) {
            confirmedProposals.add(event.proposalId);
          }
        }
        call.onRecord?.(event);
      };
      const tools = new Receptionist(prosper, {
        callId: call.callId, startedAt: call.startedAt ?? new Date(), parent: call.parent,
        signal, allowSubmissions: call.allowSubmissions === true, generation: () => transcripts.generation, record,
        beforeConfirmation: (turn) => transcripts.reviewConfirmation(turn),
        beforeOutcome: (turn, reason, context) => transcripts.reviewOutcome(turn, reason, context),
      });
      const startup = setTimeout(() => fail(new AppError("azure_live_session_timeout")), 15_000);

      function send(event: Record<string, unknown>, duringClose = false): void {
        if ((!duringClose && closing) || socket.readyState !== WebSocket.OPEN) throw new AppError("azure_live_not_connected");
        const payload = JSON.stringify(event);
        if (socket.bufferedAmount + Buffer.byteLength(payload) > 1024 * 1024) throw new AppError("azure_live_input_backpressure");
        socket.send(payload);
      }

      function finishOutput(): void {
        clearTimeout(outputIdle);
        if (outputId) call.onAudioDone(outputId);
        outputId = undefined;
        outputStartMs = undefined;
      }

      function interruptOutput(): void {
        clearTimeout(outputIdle);
        outputId = undefined;
        outputStartMs = undefined;
        const discarded = call.onInterrupt() ?? [];
        if (!discarded.length) record({ type: "interruption", reason: "caller" });
        for (const item of discarded) {
          record({ type: "interruption", reason: "caller", itemId: item.itemId, audioEndMs: item.audioEndMs });
        }
        if (discarded.length) {
          send({
            type: "session.thinking.append", event_id: `playback-${++sequence}`, delegation_id: null,
            content: "Local playback was interrupted. Do not assume the caller heard all prior speech. Re-state necessary offer details before seeking consent; already accepted backend actions remain unchanged.",
          });
        }
      }

      function activeBackend(): boolean {
        return [...responses.values()].some((response) => !response.done);
      }

      function maybeContinue(): void {
        if (!ready || closing || runningTools || pendingCreate || activeBackend()) return;
        const continuing = [...responses.values()].filter((response) => response.continuationNeeded);
        if (!typedPending && !continuing.length) return;
        if (!typedPending && transcripts.generation > contextVersion && transcripts.text) {
          send({
            type: "response.item.create", event_id: `context-${++sequence}`,
            item: { type: "message", role: "user", content: [{ type: "input_text", text: transcripts.text }] },
          });
          contextVersion = transcripts.generation;
        }
        typedPending = false;
        for (const response of continuing) response.continuationNeeded = false;
        pendingCreate = { generation: transcripts.generation };
        send({ type: "response.create", event_id: `response-${++sequence}` });
      }

      function enforceDelegationBoundary(name: string, argumentsJson: string, delegation: string): void {
        if (name !== "confirm_action" && name !== "confirm_actions") return;
        let decoded: unknown;
        try { decoded = JSON.parse(argumentsJson); }
        catch { throw new AppError("invalid_tool_arguments", "Use a valid tool argument object."); }
        const parsed = idsSchema.safeParse(decoded);
        if (!parsed.success) throw new AppError("invalid_tool_arguments");
        const ids = parsed.data.proposal_ids ?? (parsed.data.proposal_id ? [parsed.data.proposal_id] : []);
        if (ids.some((id) => !confirmedProposals.has(id) &&
            (!delegationGenerations.has(delegation) || proposalDelegations.get(id) === delegation))) {
          throw new AppError("live_confirmation_requires_new_delegation",
            "Return the prepared offer to the voice model and end this delegation. It must read back the details and wait for explicit caller consent; a NEW delegation can confirm. No action was submitted.");
        }
      }

      async function executeTool(item: z.infer<typeof functionItemSchema>, response: BackendResponse): Promise<void> {
        if (closing) return;
        let result: unknown;
        executingDelegation = response.delegation;
        try {
          if (response.generation !== transcripts.generation) throw new AppError("stale_turn");
          enforceDelegationBoundary(item.name, item.arguments, response.delegation);
          result = await tools.execute(item.name, item.arguments, response.generation);
        } catch (error) {
          if (closing) return;
          if (!(error instanceof AppError) || error.code.startsWith("call_record")) throw error;
          log("warn", "voice.live_tool_rejected", { callId: call.callId, code: error.code });
          result = { error: error.code, instruction: error.message };
        } finally {
          executingDelegation = undefined;
        }
        if (closing) return;
        if (response.generation !== transcripts.generation) {
          result = {
            error: "stale_turn",
            instruction: "Caller captions changed while this work ran. Follow the latest caller context and get_call_state. Do not repeat or replace an already confirmed action.",
          };
        }
        send({
          type: "response.item.create", event_id: `tool-${++sequence}`,
          item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify(result) },
        });
        response.continuationNeeded = true;
      }

      async function handleBackend(envelope: Record<string, unknown>): Promise<void> {
        const parsed = z.object({
          delegation_id: z.string().nullable().optional(),
          event: z.object({ type: z.string() }).passthrough(),
        }).parse(envelope);
        const key = parsed.delegation_id ?? "manual";
        const event = parsed.event;
        if (event.type === "response.created" || event.type === "response.in_progress") {
          const response = responseSchema.parse(event.response);
          if (responses.has(response.id)) return;
          if (responses.size >= 256) throw new AppError("azure_live_response_limit");
          const version = pendingCreate?.generation ?? delegationGenerations.get(key) ?? transcripts.generation;
          pendingCreate = undefined;
          contextVersion = Math.max(contextVersion, version);
          const span = trace.getTracer("hackspain-cachopo").startSpan("chat live_backend", {
            attributes: {
              "gen_ai.operation.name": "chat", "gen_ai.system": "azure.ai.openai",
              "gen_ai.request.model": config.AZURE_OPENAI_LIVE_BACKEND_DEPLOYMENT,
            },
          }, call.parent);
          responses.set(response.id, {
            id: response.id, delegation: key, generation: version, span, done: false,
            toolCalls: 0, continuationNeeded: false,
          });
          currentResponses.set(key, response.id);
          return;
        }
        if (event.type === "response.output_item.done") {
          const kind = z.object({ item: z.object({ type: z.string() }).passthrough() }).parse(event);
          if (kind.item.type !== "function_call") return;
          const item = functionItemSchema.parse(kind.item);
          if (calls.has(item.call_id)) return;
          if (calls.size >= 64) throw new AppError("tool_call_limit");
          const id = currentResponses.get(key);
          const response = id ? responses.get(id) : undefined;
          if (!response || response.done) throw new AppError("azure_live_unknown_response");
          calls.add(item.call_id);
          response.toolCalls += 1;
          runningTools += 1;
          const job = toolQueue.then(() => executeTool(item, response)).finally(() => {
            runningTools -= 1;
            maybeContinue();
          });
          toolQueue = job;
          void job.catch((error: unknown) => fail(error instanceof AppError ? error : new AppError("tool_execution_failed")));
          return;
        }
        if (["response.completed", "response.failed", "response.incomplete", "response.cancelled"].includes(event.type)) {
          const payload = responseSchema.parse(event.response);
          const response = responses.get(payload.id);
          if (!response) throw new AppError("azure_live_unknown_response");
          if (response.done) return;
          response.done = true;
          if (payload.usage) response.span.setAttributes({
            "gen_ai.usage.input_tokens": payload.usage.input_tokens,
            "gen_ai.usage.output_tokens": payload.usage.output_tokens,
          });
          const successful = event.type === "response.completed" && payload.status !== "failed" && payload.status !== "incomplete";
          response.span.setStatus({ code: successful ? SpanStatusCode.OK : SpanStatusCode.ERROR });
          response.span.end();
          if (!successful) throw new AppError("azure_live_backend_failed");
          if (response.toolCalls) response.continuationNeeded = true;
          maybeContinue();
          if (!response.toolCalls && !activeBackend() && !pendingCreate && !runningTools) call.onTurnDone();
          return;
        }
        if (event.type === "error") throw new AppError("azure_live_backend_error");
      }

      async function handle(raw: string): Promise<void> {
        const event = eventSchema.parse(JSON.parse(raw));
        if (event.event_id) {
          if (events.has(event.event_id)) return;
          if (events.size >= 8192) throw new AppError("azure_live_event_limit");
          events.add(event.event_id);
        }
        if (event.type === "session.closed") {
          const value = z.object({
            reason: z.string().max(128),
            usage: z.object({ seconds: z.number().nonnegative() }),
          }).parse(event);
          finalized = true;
          log("info", "azure.live.closed", {
            callId: call.callId, seconds: value.usage.seconds,
            reason: /^[a-zA-Z0-9_]{1,64}$/.test(value.reason) ? value.reason : "remote_close",
          });
          if (!closing) fail(new AppError("azure_live_remote_close"));
          if (socket.readyState === WebSocket.OPEN) socket.close(1000);
          return;
        }
        if (closing) return;
        switch (event.type) {
          case "session.started": {
            if (ready) return;
            const started = z.object({ session: z.object({
              model: z.string(),
              audio: z.object({ format: z.object({ type: z.literal("audio/pcmu"), rate: z.literal(8000) }) }),
              delegation: z.object({ type: z.literal("responses") }),
            }) }).safeParse(event);
            if (!started.success || started.data.session.model !== config.AZURE_OPENAI_LIVE_DEPLOYMENT) {
              throw new AppError("azure_live_session_mismatch");
            }
            ready = true;
            clearTimeout(startup);
            inputClock = setInterval(() => {
              try {
                const audio = inputFrames.shift()?.toString("base64") ?? silence;
                send({ type: "session.input_audio.append", audio });
              } catch (error) { fail(new AppError(errorCode(error))); }
            }, 20);
            resolve(session);
            if (call.greet) greeting = setTimeout(() => {
              try {
                send({
                  type: "session.instructions.append", event_id: `greet-${++sequence}`, delegation_id: null,
                  content: "Greet the caller now in English. Identify yourself as Clinica Arenal's virtual assistant and ask how you can help. Then pause and listen. If they already started a request, listen and address it rather than repeating the greeting.",
                });
              } catch (error) { fail(new AppError(errorCode(error))); }
            }, 0);
            break;
          }
          case "session.input_transcript.delta":
          case "session.output_transcript.delta": {
            const fragment = transcriptSchema.parse(event);
            const input = event.type === "session.input_transcript.delta";
            const value = {
              ...(fragment.event_id ? { eventId: fragment.event_id } : {}),
              startMs: fragment.start_ms, endMs: fragment.end_ms, text: fragment.delta,
            };
            if (input) {
              const observation = transcripts.input(value);
              if (observation.newUtterance && (outputStartMs === undefined || outputStartMs < fragment.end_ms)) {
                interruptOutput();
              }
            } else {
              transcripts.output(value);
              outputStartMs ??= fragment.start_ms;
            }
            if (fragment.delta) record({
              type: "transcript", speaker: input ? "user" : "assistant",
              itemId: fragment.event_id ?? `live-transcript-${++sequence}`,
              text: fragment.delta, partial: true,
              startMs: fragment.start_ms, endMs: fragment.end_ms,
            });
            break;
          }
          case "session.output_audio.delta": {
            const audio = z.object({
              delta: z.string().max(1_000_000),
              start_ms: z.number().nonnegative().optional(),
              end_ms: z.number().nonnegative().optional(),
            }).parse(event);
            if (audio.start_ms !== undefined && audio.end_ms !== undefined && audio.end_ms < audio.start_ms) {
              throw new AppError("azure_live_invalid_audio_range");
            }
            const bytes = decodeAudio(audio.delta);
            const hasSignal = bytes.some((value) => value !== 0xff && value !== 0x7f);
            if (!hasSignal && !outputId) break;
            outputId ??= `live-audio-${++sequence}`;
            outputStartMs ??= audio.start_ms;
            call.onAudio({ audio: bytes, itemId: outputId, contentIndex: 0 });
            if (hasSignal) {
              clearTimeout(outputIdle);
              outputIdle = setTimeout(() => {
                try { finishOutput(); } catch (error) { fail(new AppError(errorCode(error))); }
              }, 200);
            }
            break;
          }
          case "session.delegation.created": {
            const item = z.object({ delegation: z.object({
              id: z.string().min(1).max(256), target: z.literal("responses"),
            }) }).parse(event).delegation;
            if (delegationGenerations.size >= 128 && !delegationGenerations.has(item.id)) throw new AppError("azure_live_delegation_limit");
            delegationGenerations.set(item.id, transcripts.generation);
            break;
          }
          case "response.event":
            await handleBackend(event);
            break;
          case "error": {
            const error = z.object({ error: z.object({ code: z.string().nullish() }) }).parse(event).error;
            throw new AppError(error.code && /^[a-zA-Z0-9_]{1,64}$/.test(error.code)
              ? `azure_live_${error.code}` : "azure_live_service_error");
          }
        }
      }

      const session: VoiceSession = {
        sendAudio(payload) {
          if (!ready || closing) throw new AppError("azure_live_not_connected");
          const bytes = decodeAudio(payload);
          if (bytes.length !== 160) throw new AppError("unsupported_audio_frame_size");
          if (!inputFrames.length && bytes.every((value) => value === 0xff || value === 0x7f)) return;
          if (inputFrames.length >= 500) throw new AppError("audio_input_backpressure");
          inputFrames.push(bytes);
        },
        sendText(text) {
          if (!ready || closing) throw new AppError("azure_live_not_connected");
          if (call.allowSubmissions === true) {
            throw new AppError("azure_live_text_read_only", "Live text injection is diagnostic-only. Use caller audio and a new Live delegation to authorize actions.");
          }
          if (activeBackend() || pendingCreate || runningTools || typedPending) throw new AppError("azure_live_backend_busy");
          const version = transcripts.typed(text);
          record({ type: "transcript", speaker: "user", itemId: `live-text-${++sequence}`, text });
          contextVersion = version;
          send({
            type: "response.item.create", event_id: `input-${++sequence}`,
            item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
          });
          typedPending = true;
          maybeContinue();
        },
        close() {
          if (closePromise) return closePromise;
          const completion = Promise.withResolvers<void>();
          closePromise = completion.promise;
          closing = true;
          clearTimeout(startup);
          clearTimeout(greeting);
          clearTimeout(outputIdle);
          clearInterval(inputClock);
          inputFrames.length = 0;
          operations.abort();
          call.signal.removeEventListener("abort", onAbort);
          if (!ready) reject(new AppError("call_cancelled"));
          const disconnect = async () => {
            const timeout = setTimeout(() => socket.terminate(), dependencies.closeTimeoutMs ?? 15_000);
            try {
              if (socket.readyState === WebSocket.OPEN && ready) {
                send({ type: "session.close", event_id: `close-${++sequence}` }, true);
              } else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
              if (socket.readyState !== WebSocket.CLOSED) await transportClosed.promise;
              if (ready && !finalized) {
                record({ type: "error", code: "azure_live_close_unconfirmed" });
                throw new AppError("azure_live_close_unconfirmed");
              }
            } finally { clearTimeout(timeout); }
          };
          void Promise.allSettled([disconnect(), tools.close(), toolQueue]).then((results) => {
            for (const response of responses.values()) if (!response.done) {
              response.done = true;
              response.span.setStatus({ code: SpanStatusCode.ERROR, message: "session_closed" });
              response.span.end();
            }
            const failure = results.find((result) => result.status === "rejected");
            if (failure?.status === "rejected") completion.reject(failure.reason);
            else completion.resolve();
          });
          return closePromise;
        },
      };

      function onAbort(): void {
        void session.close().catch(() => log("warn", "azure.live.close_incomplete", { callId: call.callId }));
      }
      function fail(error: AppError): void {
        if (failed || closing) return;
        failed = true;
        reject(error);
        call.onFailure(error);
        void session.close().catch(() => log("warn", "azure.live.close_incomplete", { callId: call.callId }));
      }
      call.signal.addEventListener("abort", onAbort, { once: true });
      if (call.signal.aborted) onAbort();
      socket.on("open", () => {
        if (closing) return;
        try {
          send({ type: "session.start", event_id: "live-start", session: liveSessionConfiguration(config, call) });
        } catch (error) { fail(new AppError(errorCode(error))); }
      });
      socket.on("message", (data, binary) => {
        if (binary) { fail(new AppError("azure_live_unexpected_binary")); return; }
        void handle(data.toString()).catch((error: unknown) =>
          fail(error instanceof AppError ? error : new AppError("azure_live_invalid_event")));
      });
      socket.on("unexpected-response", (_request, response) => {
        response.resume();
        fail(new AppError(`azure_live_http_${response.statusCode ?? 0}`));
      });
      socket.on("error", () => fail(new AppError("azure_live_socket_error")));
      socket.on("close", () => {
        transportClosed.resolve();
        if (!closing) fail(new AppError("azure_live_disconnected"));
      });
    });
  });
}
