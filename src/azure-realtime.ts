import { DefaultAzureCredential } from "@azure/identity";
import { SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api";
import WebSocket from "ws";
import { z } from "zod";
import type { AudioChunk, PlayedAudio } from "./audio.js";
import type { Config } from "./config.js";
import type { CallRecordEvent } from "./call-records.js";
import { AppError, errorCode } from "./errors.js";
import { decodeAudio } from "./protocol.js";
import type { ProsperClient } from "./prosper.js";
import { Receptionist, receptionistInstructions, receptionistTools } from "./receptionist.js";
import { log, withSpan } from "./telemetry.js";
import { ConfirmationGate } from "./confirmation.js";

export interface VoiceContext {
  callId: string;
  parent: Context;
  signal: AbortSignal;
  greet: boolean;
  onAudio: (chunk: AudioChunk) => void;
  onAudioDone: (itemId: string) => void;
  onInterrupt: () => readonly PlayedAudio[] | undefined;
  onFailure: (error: AppError) => void;
  onTurnDone: () => void;
  startedAt?: Date;
  allowSubmissions?: boolean;
  onRecord?: (event: CallRecordEvent) => void;
}

export interface VoiceSession {
  sendAudio: (payload: string) => void;
  sendText: (text: string) => void;
  close: () => Promise<void>;
}

export type VoiceFactory = (call: VoiceContext) => Promise<VoiceSession>;

export interface AzureRealtimeDependencies {
  createWebSocket?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  getToken?: (signal: AbortSignal) => Promise<{ token: string } | null>;
}

interface ResponseTurn {
  span: Span;
  generation: number;
  interrupted: boolean;
  done: boolean;
  jobs: Promise<void>[];
  transcripts: Map<string, string>;
  cancelEventId?: string;
}

const eventSchema = z.object({ type: z.string() }).passthrough();
const audioSchema = z.object({
  response_id: z.string(),
  delta: z.string().max(1_000_000),
  item_id: z.string(),
  content_index: z.number().int().nonnegative(),
});
const functionSchema = z.object({
  response_id: z.string(),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string().max(8192),
});
const responseSchema = z.object({
  response: z.object({
    id: z.string(),
    status: z.enum(["in_progress", "completed", "cancelled", "failed", "incomplete"]),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
    }).nullish(),
  }),
});

export function azureRealtimeUrl(config: Config): string {
  const url = new URL("/openai/realtime", config.AZURE_OPENAI_ENDPOINT);
  url.protocol = "wss:";
  url.searchParams.set("api-version", config.AZURE_OPENAI_API_VERSION);
  url.searchParams.set("deployment", config.AZURE_OPENAI_DEPLOYMENT);
  return url.toString();
}

export function createAzureVoiceFactory(
  config: Config,
  prosper: ProsperClient,
  dependencies: AzureRealtimeDependencies = {},
): VoiceFactory {
  let credential: DefaultAzureCredential | undefined;
  const getToken = dependencies.getToken ?? ((signal: AbortSignal) => {
    credential ??= new DefaultAzureCredential(
      config.AZURE_CLIENT_ID ? { managedIdentityClientId: config.AZURE_CLIENT_ID } : {},
    );
    return credential.getToken("https://cognitiveservices.azure.com/.default", { abortSignal: signal });
  });
  const createWebSocket = dependencies.createWebSocket ?? ((url, options) => new WebSocket(url, options));
  return (call) => withSpan("azure.realtime.connect", {
    "gen_ai.system": "azure.ai.openai",
    "gen_ai.request.model": config.AZURE_OPENAI_DEPLOYMENT,
    "server.address": new URL(config.AZURE_OPENAI_ENDPOINT).hostname,
  }, call.parent, async () => {
    if (call.signal.aborted) throw new AppError("call_cancelled");
    let headers: Record<string, string>;
    if (config.AZURE_OPENAI_API_KEY) {
      headers = { "api-key": config.AZURE_OPENAI_API_KEY };
    } else {
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
      const socket = createWebSocket(azureRealtimeUrl(config), {
        headers,
        handshakeTimeout: 10_000,
        maxPayload: 2 * 1024 * 1024,
        followRedirects: false,
      });
      const turns = new Map<string, ResponseTurn>();
      const toolCallIds = new Set<string>();
      const cancelEvents = new Set<string>();
      const operations = new AbortController();
      const overflowRecoveryGenerations = new Set<number>();
      let ready = false;
      let closed = false;
      let generation = 0;
      let userSpeaking = false;
      let pendingResponse: number | undefined;
      let pendingTools = 0;
      let pendingRecovery: { generation: number; instructions: string } | undefined;
      let cancelSequence = 0;
      let greetingPending = call.greet;
      let greetingInputSeen = false;
      let greetingTimer: NodeJS.Timeout | undefined;
      let closePromise: Promise<void> | undefined;
      let toolQueue = Promise.resolve();
      const startedAt = call.startedAt ?? new Date();
      const instructions = receptionistInstructions(startedAt, call.allowSubmissions === true);
      const record = (event: CallRecordEvent) => call.onRecord?.(event);
      const callerItemTurns = new Map<string, number>();
      const confirmation = new ConfirmationGate(() => generation, AbortSignal.any([call.signal, operations.signal]));
      const tools = new Receptionist(prosper, {
        callId: call.callId, startedAt, parent: call.parent,
        signal: AbortSignal.any([call.signal, operations.signal]),
        allowSubmissions: call.allowSubmissions === true,
        generation: () => generation, record, beforeConfirmation: (turn) => confirmation.review(turn),
        beforeOutcome: (turn, reason) => confirmation.reviewOutcome(turn, reason),
      });
      const deadline = setTimeout(() => fail(new AppError("azure_session_timeout")), 15_000);

      function send(event: Record<string, unknown>): void {
        if (closed || socket.readyState !== WebSocket.OPEN) throw new AppError("azure_not_connected");
        const payload = JSON.stringify(event);
        if (socket.bufferedAmount + Buffer.byteLength(payload) > 1024 * 1024) {
          throw new AppError("azure_input_backpressure");
        }
        socket.send(payload);
      }

      function dismissGreeting(): void {
        greetingPending = false;
        clearTimeout(greetingTimer);
      }

      function scheduleGreeting(waitMs = 0): void {
        clearTimeout(greetingTimer);
        greetingTimer = setTimeout(() => {
          if (!greetingPending) return;
          dismissGreeting();
          try {
            createResponse("Start in English. Give one short greeting identifying yourself as Clinica Arenal's virtual assistant and ask: How can I help you today? Then wait for the caller. Ask no additional questions in this opening.");
          } catch (error) {
            fail(new AppError(errorCode(error)));
          }
        }, waitMs);
      }

      function hasActiveResponse(): boolean {
        return [...turns.values()].some((turn) => !turn.done);
      }

      function createResponse(instructions?: string): boolean {
        if (closed || !ready || userSpeaking || pendingResponse !== undefined ||
            hasActiveResponse() || pendingTools) return false;
        pendingResponse = generation;
        send({ type: "response.create", ...(instructions ? { response: { instructions } } : {}) });
        return true;
      }

      function resumeRecovery(): void {
        if (!pendingRecovery) return;
        if (pendingRecovery.generation !== generation) {
          pendingRecovery = undefined;
          return;
        }
        if (createResponse(pendingRecovery.instructions)) pendingRecovery = undefined;
      }

      function cancelResponse(id: string, turn: ResponseTurn): void {
        turn.interrupted = true;
        turn.span.setAttribute("voice.response.interrupted", true);
        if (turn.done || turn.cancelEventId) return;
        turn.cancelEventId = `cancel-${++cancelSequence}`;
        cancelEvents.add(turn.cancelEventId);
        send({ type: "response.cancel", response_id: id, event_id: turn.cancelEventId });
      }

      function interruptPlayback(
        reason: "caller" | "output_limit" | "provider_cancelled",
        unheard?: PlayedAudio,
      ): void {
        const discarded = [...(call.onInterrupt() ?? [])];
        if (unheard && !discarded.some((item) =>
          item.itemId === unheard.itemId && item.contentIndex === unheard.contentIndex)) discarded.push(unheard);
        if (!discarded.length) record({ type: "interruption", reason });
        for (const played of discarded) {
          record({ type: "interruption", itemId: played.itemId, audioEndMs: played.audioEndMs, reason });
          send({
            type: "conversation.item.truncate",
            item_id: played.itemId,
            content_index: played.contentIndex,
            audio_end_ms: played.audioEndMs,
          });
        }
      }

      function recordPartialTranscripts(turn: ResponseTurn): void {
        for (const [itemId, text] of turn.transcripts) {
          if (text) record({ type: "transcript", speaker: "assistant", itemId, text, partial: true });
        }
        turn.transcripts.clear();
      }

      function audibleTurn(responseId: string): boolean {
        const turn = turns.get(responseId);
        if (!turn) throw new AppError("azure_unknown_response");
        return !turn.done && !turn.interrupted && turn.generation === generation && !userSpeaking;
      }

      function cleanup(): void {
        clearTimeout(deadline);
        dismissGreeting();
        pendingRecovery = undefined;
        call.signal.removeEventListener("abort", onAbort);
        for (const { span, done } of turns.values()) {
          if (done) continue;
          span.setAttribute("voice.response.interrupted", true);
          span.end();
        }
        turns.clear();
      }

      function fail(error: AppError): void {
        if (closed) return;
        reject(error);
        void session.close().catch(() => log("error", "azure.close_failed", { callId: call.callId }));
        call.onFailure(error);
      }

      const session: VoiceSession = {
        sendAudio(payload) {
          if (!ready) throw new AppError("azure_not_ready");
          const audio = decodeAudio(payload);
          if (audio.length !== 160) throw new AppError("unsupported_audio_frame_size");
          // Give buffered speech time to reach VAD, without letting ambient noise suppress the greeting.
          if (greetingPending && !greetingInputSeen &&
              audio.some((sample) => sample !== 0xff && sample !== 0x7f)) {
            greetingInputSeen = true;
            scheduleGreeting(500);
          }
          send({ type: "input_audio_buffer.append", audio: payload });
        },
        sendText(text) {
          if (closed) throw new AppError("azure_not_connected");
          if (!ready || pendingResponse !== undefined || hasActiveResponse() || pendingTools || userSpeaking) {
            throw new AppError("azure_response_busy");
          }
          dismissGreeting();
          generation += 1;
          confirmation.observe(generation, text);
          record({ type: "transcript", speaker: "user", itemId: `text-${generation}`, text });
          send({
            type: "conversation.item.create",
            item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
          });
          createResponse();
        },
        close() {
          if (closePromise) return closePromise;
          closed = true;
          operations.abort();
          cleanup();
          reject(new AppError("call_cancelled"));
          const disconnected = new Promise<void>((done) => {
            if (socket.readyState === WebSocket.CLOSED) { done(); return; }
            const timeout = setTimeout(() => socket.terminate(), 1000);
            socket.once("close", () => { clearTimeout(timeout); done(); });
            if (socket.readyState === WebSocket.OPEN) socket.close(1000);
            else socket.terminate();
          });
          closePromise = Promise.allSettled([disconnected, tools.close(), toolQueue]).then((results) => {
            const failed = results.find((result) => result.status === "rejected");
            if (failed?.status === "rejected") throw failed.reason;
          });
          return closePromise;
        },
      };
      function onAbort(): void {
        void session.close().catch(() => log("error", "azure.close_failed", { callId: call.callId }));
      }
      call.signal.addEventListener("abort", onAbort, { once: true });
      if (call.signal.aborted) onAbort();

      async function runTool(event: z.infer<typeof functionSchema>, turn: ResponseTurn): Promise<void> {
        if (closed || call.signal.aborted) return;
        const stale = () => turn.interrupted || turn.generation !== generation;
        let output: unknown;
        try {
          if (!stale()) output = await tools.execute(event.name, event.arguments, turn.generation);
        } catch (error) {
          if (closed || call.signal.aborted) return;
          if (!(error instanceof AppError) || error.code.startsWith("call_record")) throw error;
          const code = error.code;
          log("error", "voice.tool_failed", { callId: call.callId, code });
          output = {
            error: code,
            instruction: code === "prosper_submission_unknown"
              ? "The action may already have been accepted. Retry confirm_action for the SAME proposal only; never submit a replacement or claim success yet."
              : error.message,
          };
        }
        if (!closed && !call.signal.aborted) {
          if (stale()) {
            output = {
              error: "stale_turn",
              instruction: "This response was interrupted. Follow the latest caller request. Use get_call_state to check any already-confirmed actions before proceeding.",
            };
          }
          send({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: event.call_id, output: JSON.stringify(output) },
          });
        }
      }

      async function handle(text: string): Promise<void> {
        if (closed) return;
        const event = eventSchema.parse(JSON.parse(text));
        switch (event.type) {
          case "session.updated":
            if (ready) break;
            ready = true;
            clearTimeout(deadline);
            resolve(session);
            if (greetingPending) scheduleGreeting();
            break;
          case "error": {
            const details = z.object({ error: z.object({
              code: z.string().nullable().optional(),
              event_id: z.string().nullable().optional(),
            }) }).parse(event);
            const code = details.error.code;
            if (code === "response_cancel_not_active" && details.error.event_id &&
                cancelEvents.delete(details.error.event_id)) break;
            throw new AppError(code && /^[a-zA-Z0-9_]{1,64}$/.test(code) ? `azure_${code}` : "azure_service_error");
          }
          case "response.audio.delta": {
            const audio = audioSchema.parse(event);
            if (!audibleTurn(audio.response_id)) break;
            try {
              call.onAudio({
                audio: decodeAudio(audio.delta),
                itemId: audio.item_id,
                contentIndex: audio.content_index,
              });
            } catch (error) {
              if (!(error instanceof AppError) || error.code !== "audio_output_backpressure" ||
                  overflowRecoveryGenerations.has(generation)) throw error;
              overflowRecoveryGenerations.add(generation);
              const turn = turns.get(audio.response_id)!;
              record({ type: "error", code: "audio_output_recovery" });
              log("warn", "voice.audio_output_recovery", { callId: call.callId });
              recordPartialTranscripts(turn);
              pendingRecovery = {
                generation,
                instructions: `${instructions}\nThe previous spoken response exceeded the bounded playback queue and was interrupted. Recover with at most 40 spoken words: give only the selected final offer or one short necessary question, then wait. Use get_call_state if needed; preserve already accepted actions and continue only unresolved requests. Never resubmit a different payload, infer consent, or skip validation to recover.`,
              };
              cancelResponse(audio.response_id, turn);
              interruptPlayback("output_limit", {
                itemId: audio.item_id, contentIndex: audio.content_index, audioEndMs: 0,
              });
            }
            break;
          }
          case "response.audio.done": {
            const audio = z.object({ response_id: z.string(), item_id: z.string() }).parse(event);
            if (audibleTurn(audio.response_id)) call.onAudioDone(audio.item_id);
            break;
          }
          case "conversation.item.input_audio_transcription.completed": {
            const transcript = z.object({ item_id: z.string(), transcript: z.string() }).parse(event);
            const turn = callerItemTurns.get(transcript.item_id);
            if (turn !== undefined) confirmation.observe(turn, transcript.transcript);
            record({ type: "transcript", speaker: "user", itemId: transcript.item_id, text: transcript.transcript });
            break;
          }
          case "response.audio_transcript.delta": {
            const transcript = z.object({
              response_id: z.string(), item_id: z.string(), delta: z.string().max(32_000),
            }).parse(event);
            const turn = turns.get(transcript.response_id);
            if (turn && !turn.done && !turn.interrupted) {
              turn.transcripts.set(transcript.item_id,
                ((turn.transcripts.get(transcript.item_id) ?? "") + transcript.delta).slice(0, 8000));
            }
            break;
          }
          case "response.audio_transcript.done": {
            const transcript = z.object({ item_id: z.string(), transcript: z.string() }).parse(event);
            for (const turn of turns.values()) turn.transcripts.delete(transcript.item_id);
            record({ type: "transcript", speaker: "assistant", itemId: transcript.item_id, text: transcript.transcript });
            break;
          }
          case "response.text.done": {
            const transcript = z.object({ item_id: z.string(), text: z.string() }).parse(event);
            record({ type: "transcript", speaker: "assistant", itemId: transcript.item_id, text: transcript.text });
            break;
          }
          case "conversation.item.input_audio_transcription.failed":
            record({ type: "error", code: "input_transcription_failed" });
            log("warn", "voice.transcription_failed", { callId: call.callId });
            break;
          case "input_audio_buffer.speech_started": {
            if (userSpeaking) break;
            generation += 1;
            pendingRecovery = undefined;
            if (typeof event.item_id === "string") callerItemTurns.set(event.item_id, generation);
            for (const [item, turn] of callerItemTurns) if (turn < generation - 2) callerItemTurns.delete(item);
            userSpeaking = true;
            dismissGreeting();
            for (const [id, turn] of turns) cancelResponse(id, turn);
            interruptPlayback("caller");
            break;
          }
          case "input_audio_buffer.speech_stopped":
            userSpeaking = false;
            break;
          case "response.created": {
            const response = responseSchema.parse(event).response;
            if (turns.has(response.id)) break;
            if (turns.size >= 512) throw new AppError("azure_response_limit");
            const version = pendingResponse ?? generation;
            pendingResponse = undefined;
            dismissGreeting();
            const span = trace.getTracer("hackspain-cachopo").startSpan("chat", {
              attributes: {
                "gen_ai.operation.name": "chat",
                "gen_ai.system": "azure.ai.openai",
                "gen_ai.request.model": config.AZURE_OPENAI_DEPLOYMENT,
              },
            }, call.parent);
            const turn: ResponseTurn = {
              span, generation: version, interrupted: false, done: false, jobs: [], transcripts: new Map(),
            };
            turns.set(response.id, turn);
            if (version !== generation || userSpeaking) cancelResponse(response.id, turn);
            break;
          }
          case "response.function_call_arguments.done": {
            const tool = functionSchema.parse(event);
            if (toolCallIds.has(tool.call_id)) break;
            const turn = turns.get(tool.response_id);
            if (!turn) throw new AppError("azure_unknown_response");
            if (turn.done) {
              if (turn.interrupted) break;
              throw new AppError("azure_tool_after_response");
            }
            if (toolCallIds.size >= 64) throw new AppError("tool_call_limit");
            toolCallIds.add(tool.call_id);
            pendingTools += 1;
            const job = toolQueue.then(() => runTool(tool, turn)).finally(() => {
              pendingTools -= 1;
              resumeRecovery();
            });
            toolQueue = job;
            turn.jobs.push(job);
            // Observe rejection immediately, even before response.done arrives.
            void job.catch(() => fail(new AppError("tool_execution_failed")));
            break;
          }
          case "response.done": {
            const response = responseSchema.parse(event).response;
            const turn = turns.get(response.id);
            if (!turn) throw new AppError("azure_unknown_response");
            if (turn.done) break;
            if (response.status === "in_progress") throw new AppError("azure_invalid_event");
            if (response.status === "cancelled" && !turn.interrupted && turn.generation === generation) {
              turn.interrupted = true;
              interruptPlayback("provider_cancelled");
            }
            turn.done = true;
            const { span, generation: version } = turn;
            if (response.usage) {
              span.setAttributes({
                "gen_ai.usage.input_tokens": response.usage.input_tokens,
                "gen_ai.usage.output_tokens": response.usage.output_tokens,
              });
            }
            span.setAttribute("voice.response.status", response.status);
            span.setStatus({
              code: response.status === "failed" || response.status === "incomplete"
                ? SpanStatusCode.ERROR : SpanStatusCode.OK,
            });
            span.end();
            recordPartialTranscripts(turn);
            if (response.status === "failed" || response.status === "incomplete") {
              throw new AppError(`azure_response_${response.status}`);
            }
            if (turn.jobs.length) await Promise.all(turn.jobs);
            resumeRecovery();
            if (closed || userSpeaking || turn.interrupted || generation !== version ||
                response.status !== "completed") break;
            if (turn.jobs.length) {
              createResponse();
            } else if (!hasActiveResponse() && pendingResponse === undefined) {
              call.onTurnDone();
            }
            break;
          }
        }
      }

      socket.on("open", () => {
        try {
          send({ type: "session.update", session: {
            modalities: ["text", "audio"],
            voice: config.AZURE_OPENAI_VOICE,
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            input_audio_transcription: { model: config.AZURE_OPENAI_TRANSCRIPTION_MODEL },
            turn_detection: { type: "semantic_vad", eagerness: "auto" },
            instructions,
            tools: receptionistTools,
            tool_choice: "auto",
            temperature: 0.8,
          } });
        } catch (error) {
          fail(new AppError(errorCode(error)));
        }
      });
      socket.on("message", (data, isBinary) => {
        if (isBinary) return fail(new AppError("azure_unexpected_binary"));
        void handle(data.toString()).catch((error: unknown) => {
          fail(error instanceof AppError ? error : new AppError("azure_invalid_event"));
        });
      });
      socket.on("unexpected-response", (_request, response) => {
        response.resume();
        fail(new AppError(`azure_http_${response.statusCode ?? 0}`));
      });
      socket.on("error", () => fail(new AppError("azure_websocket_error")));
      socket.on("close", () => {
        if (!closed) fail(new AppError("azure_disconnected"));
      });
    });
  });
}
