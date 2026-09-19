import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ROOT_CONTEXT, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import WebSocket, { WebSocketServer } from "ws";
import { AudioQueue } from "./audio.js";
import { createCallRecordStore } from "./call-records.js";
import type { VoiceFactory, VoiceSession } from "./azure-realtime.js";
import type { Config } from "./config.js";
import { AppError, errorCode } from "./errors.js";
import { decodeAudio, parsePacket } from "./protocol.js";
import { log } from "./telemetry.js";

type CallRecordStore = ReturnType<typeof createCallRecordStore>;
type CallRecorder = ReturnType<CallRecordStore["start"]>;

export function validAuthorization(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const value = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return value.length === expected.length && timingSafeEqual(value, expected);
}

export function createVoiceServer(
  config: Config,
  openVoice: VoiceFactory,
  telemetryMode: "azure" | "console",
  recordStore?: CallRecordStore,
) {
  const records = recordStore ?? (config.CALL_RECORDING_ENABLED ? createCallRecordStore({
    directory: resolve(".local/calls"),
    retentionDays: config.CALL_RECORDING_RETENTION_DAYS,
    recordAudio: config.CALL_AUDIO_RECORDING_ENABLED,
    secrets: [
      config.PROSPER_API_KEY, config.AZURE_OPENAI_API_KEY ?? "", config.VOICE_ENDPOINT_TOKEN,
      config.APPLICATIONINSIGHTS_CONNECTION_STRING ?? "",
    ],
  }) : undefined);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const calls = new Map<string, () => Promise<void>>();
  const disconnects = new Map<WebSocket, () => Promise<void>>();
  let shuttingDown = false;
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(shuttingDown ? 503 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        status: shuttingDown ? "stopping" : "ok",
        activeCalls: calls.size,
        telemetry: telemetryMode,
        capabilities: ["voice", "clinic", "book", "reschedule", "cancel", "register", "outcomes"],
        localRecording: Boolean(records),
        localAudioRecording: Boolean(records && config.CALL_AUDIO_RECORDING_ENABLED),
      }));
      return;
    }
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket, head) => {
    const reject = (status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (request.url !== "/ws") return reject("404 Not Found");
    if (!validAuthorization(request.headers.authorization, config.VOICE_ENDPOINT_TOKEN)) {
      log("warn", "websocket.unauthorized");
      return reject("401 Unauthorized");
    }
    if (shuttingDown || sockets.clients.size >= config.MAX_CONCURRENT_CALLS) {
      log("warn", "websocket.capacity_reached");
      return reject("503 Service Unavailable");
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client));
  });

  sockets.on("connection", (client) => {
    const controller = new AbortController();
    // A bounded 1.2 s tail lets the remote VAD finish a completed speech item.
    const audio = new AudioQueue(1500, 60);
    let voice: VoiceSession | undefined;
    let opening: Promise<void> | undefined;
    let streamId: string | undefined;
    let callId: string | undefined;
    let closed = false;
    let stopPromise: Promise<void> | undefined;
    let span: Span | undefined;
    let recorder: CallRecorder | undefined;
    let recordingStartedAt: number | undefined;
    let endReason = "socket_closed";
    const pending: string[] = [];
    let inputBytes = 0;
    let outputBytes = 0;
    let playback: NodeJS.Timeout | undefined;
    let callDeadline: NodeJS.Timeout | undefined;
    const startDeadline = setTimeout(() => fail(new AppError("missing_start")), 10_000);

    function stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      closed = true;
      clearTimeout(startDeadline);
      clearTimeout(callDeadline);
      clearInterval(playback);
      controller.abort();
      pending.length = 0;
      audio.interrupt();
      if (client.readyState === WebSocket.OPEN) client.close(1000);
      const forceClose = setTimeout(() => client.terminate(), 1000);
      forceClose.unref();
      client.once("close", () => clearTimeout(forceClose));
      stopPromise = (async () => {
        try {
          if (opening) await opening;
          await voice?.close();
        } finally {
          try { recorder?.finish({ reason: endReason, inputBytes, outputBytes }); }
          finally {
            if (callId) calls.delete(callId);
            disconnects.delete(client);
            span?.setAttributes({ "voice.input_bytes": inputBytes, "voice.output_bytes": outputBytes });
            span?.end();
            log("info", "call.closed", { callId: callId ?? "not-started", inputBytes, outputBytes, reason: endReason });
          }
        }
      })();
      return stopPromise;
    }

    function fail(error: unknown): void {
      if (closed) return;
      const code = errorCode(error);
      endReason = code;
      span?.setStatus({ code: SpanStatusCode.ERROR, message: code });
      log("error", "call.failed", { callId: callId ?? "not-started", code });
      try { recorder?.append({ type: "error", code }); }
      catch { log("error", "call.recording_failed", { callId: callId ?? "not-started" }); }
      void stop().catch(() => log("error", "call.cleanup_failed", { callId: callId ?? "not-started" }));
    }
    disconnects.set(client, () => { endReason = "server_shutdown"; return stop(); });

    client.on("message", (raw, binary) => {
      if (closed) return;
      try {
        if (binary) throw new AppError("unexpected_binary_packet");
        const packet = parsePacket(raw.toString());
        if (packet.event === "connected") return;
        if (packet.event === "start") {
          if (callId) throw new AppError("duplicate_start");
          if (calls.has(packet.start.callSid)) throw new AppError("duplicate_call_id");
          clearTimeout(startDeadline);
          callId = packet.start.callSid;
          streamId = packet.start.streamSid;
          calls.set(callId, stop);
          const startedAt = new Date();
          recordingStartedAt = performance.now();
          recorder = records?.start(callId, startedAt);
          span = trace.getTracer("hackspain-cachopo").startSpan("invoke_agent cachopo", {
            attributes: {
              "gen_ai.operation.name": "invoke_agent",
              "gen_ai.agent.name": "cachopo",
              "gen_ai.system": "azure.ai.openai",
              "gen_ai.request.model": config.AZURE_OPENAI_DEPLOYMENT,
              "prosper.call_id": callId,
            },
          }, ROOT_CONTEXT);
          callDeadline = setTimeout(() => fail(new AppError("call_time_limit")), 180_000);
          playback = setInterval(() => {
            try {
              const frame = audio.next();
              if (!frame || client.readyState !== WebSocket.OPEN) return;
              if (client.bufferedAmount > 1024 * 1024) throw new AppError("client_backpressure");
              client.send(JSON.stringify({ event: "media", streamSid: streamId, media: {
                payload: frame.toString("base64"),
              } }));
              outputBytes += frame.length;
              if (recordingStartedAt !== undefined) {
                recorder?.appendAudio("agent", frame, performance.now() - recordingStartedAt);
              }
            } catch (error) { fail(error); }
          }, 20);
          log("info", "call.started", { callId });
          opening = openVoice({
            callId,
            startedAt,
            allowSubmissions: true,
            onRecord: (event) => recorder?.append(event),
            parent: trace.setSpan(ROOT_CONTEXT, span),
            signal: controller.signal,
            greet: true,
            onAudio: (chunk) => { if (!closed) audio.push(chunk); },
            onAudioDone: (item) => { if (!closed) audio.finish(item); },
            onInterrupt: () => {
              span?.addEvent("voice.interrupted");
              return audio.interrupt();
            },
            onFailure: fail,
            onTurnDone: () => span?.addEvent("voice.turn_completed"),
          }).then(async (session) => {
            voice = session;
            if (closed) { await session.close(); return; }
            for (const payload of pending) session.sendAudio(payload);
            pending.length = 0;
          }).catch((error: unknown) => { if (!closed) fail(error); });
          return;
        }
        if (!streamId || packet.streamSid !== streamId) throw new AppError("stream_id_mismatch");
        if (packet.event === "stop") {
          endReason = "prosper_stop";
          void stop().catch(() => log("error", "call.cleanup_failed", { callId: callId ?? "not-started" }));
        } else if (packet.event === "media") {
          const bytes = decodeAudio(packet.media.payload);
          if (bytes.length !== 160) throw new AppError("unsupported_audio_frame_size");
          inputBytes += bytes.length;
          if (recordingStartedAt !== undefined) {
            recorder?.appendAudio("caller", bytes, performance.now() - recordingStartedAt);
          }
          if (voice) voice.sendAudio(packet.media.payload);
          else {
            if (pending.length >= 500) throw new AppError("audio_input_backpressure");
            pending.push(packet.media.payload);
          }
        }
      } catch (error) { fail(error); }
    });
    client.on("error", () => fail(new AppError("client_websocket_error")));
    client.on("close", () => {
      void stop().catch(() => log("error", "call.cleanup_failed", { callId: callId ?? "not-started" }));
    });
  });

  return {
    async listen(): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.PORT, config.HOST, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new AppError("invalid_listen_address");
      return address.port;
    },
    close(): Promise<void> {
      if (closing) return closing;
      shuttingDown = true;
      closing = (async () => {
        const stopped = [...disconnects.values()].map((stop) => stop());
        await Promise.all(stopped);
        await new Promise<void>((resolve) => sockets.close(() => resolve()));
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      })();
      return closing;
    },
  };
}
