import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import type { VoiceFactory } from "../azure-realtime.js";
import { decodeMuLaw } from "../call-audio.js";
import type { CallRecordEvent, CallRecordStore } from "../call-records.js";
import { AppError, errorCode } from "../errors.js";
import { decodeAudio } from "../protocol.js";
import { ProsperClient } from "../prosper.js";
import { createVoiceServer } from "../server.js";
import { createConfiguredVoiceFactory } from "../voice-provider.js";
import type { DashboardConfig } from "./config.js";
import { projectCallTranscript } from "./records.js";

export const demoWebSocketPath = "/api/dashboard/demo-call/ws";
const ticketLifetimeMs = 30_000;
const maxDurationSeconds = 180;
const maxClientBuffer = 1024 * 1024;
const clientPacket = z.discriminatedUnion("event", [
  z.strictObject({ event: z.literal("media"), media: z.strictObject({ payload: z.string().length(216) }) }),
  z.strictObject({ event: z.literal("stop") }),
]);
const bridgePacket = z.discriminatedUnion("event", [
  z.object({ event: z.literal("media"), streamSid: z.string(), media: z.object({ payload: z.string().length(216) }) }),
  z.object({ event: z.literal("clear"), streamSid: z.string() }),
]);
const safeCode = z.string().max(100).regex(/^[A-Za-z0-9_.-]+$/);

export function dashboardRequestHost(request: IncomingMessage): string {
  try {
    const host = request.headers.host;
    if (!host) throw new Error();
    const url = new URL(`http://${host}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.host;
  } catch { throw new AppError("dashboard_invalid_request_host"); }
}

export function dashboardRequestOrigin(request: IncomingMessage): string {
  try {
    const value = request.headers.origin;
    if (!value) throw new Error();
    const origin = new URL(value);
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== value ||
        origin.host !== dashboardRequestHost(request)) throw new Error();
    return origin.origin;
  } catch { throw new AppError("dashboard_demo_origin_denied"); }
}

export function readOnlyDemoClinicFetch(origin: string, request: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method.toUpperCase() !== "GET" || url.origin !== new URL(origin).origin ||
        /^\/api\/v1\/(?:submit|runs)(?:\/|$)/.test(url.pathname)) {
      throw new AppError("dashboard_demo_write_forbidden", "The browser voice demo cannot submit clinic actions or start runs.");
    }
    return request(input, { ...init, redirect: "error" });
  };
}

interface DemoSlot {
  id: string;
  streamId: string;
  ticket: string;
  origin: string;
  expiresAt: number;
  claimed: boolean;
  ready: boolean;
  stopping: boolean;
  finished: boolean;
  startedAt?: Date;
  client?: WebSocket;
  bridge?: WebSocket;
  inputFrames: number;
  transcriptEntries: number;
  transcriptBytes: number;
}

export class DashboardDemoCalls {
  private readonly sockets = new WebSocketServer({
    noServer: true, maxPayload: 2048, perMessageDeflate: false,
    handleProtocols: (protocols) => protocols.has("maio-demo") ? "maio-demo" : false,
  });
  private readonly bridgeToken = randomBytes(32).toString("hex");
  private readonly bridge: ReturnType<typeof createVoiceServer>;
  private readonly now: () => number;
  private slot: DemoSlot | undefined;
  private bridgeListening: Promise<number> | undefined;
  private ticketTimer: NodeJS.Timeout | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly config: DashboardConfig,
    dependencies: { voiceFactory?: VoiceFactory; request?: typeof fetch; now?: () => number } = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    const voice = dependencies.voiceFactory ?? createConfiguredVoiceFactory(config.voice,
      new ProsperClient(config.voice, readOnlyDemoClinicFetch(config.voice.PROSPER_API_BASE_URL, dependencies.request)));
    const records: CallRecordStore = {
      start: (id, startedAt) => {
        const slot = this.slot;
        if (!slot || slot.id !== id || !slot.claimed || slot.stopping) throw new AppError("dashboard_demo_closed");
        slot.startedAt = startedAt;
        return {
          append: (event) => this.record(slot, event),
          appendAudio() {},
          finish: (summary) => this.finish(slot, summary.reason),
        };
      },
    };
    this.bridge = createVoiceServer({
      ...config.voice, HOST: "127.0.0.1", PORT: 0, MAX_CONCURRENT_CALLS: 1,
      VOICE_ENDPOINT_TOKEN: this.bridgeToken, CALL_RECORDING_ENABLED: false, CALL_AUDIO_RECORDING_ENABLED: false,
    }, async (call) => {
      const slot = this.slot;
      if (!slot || slot.id !== call.callId || slot.stopping) throw new AppError("dashboard_demo_closed");
      const session = await voice({
        ...call,
        allowSubmissions: false,
      });
      if (!call.signal.aborted && !slot.stopping) {
        slot.ready = true;
        this.send(slot, { event: "ready", callId: slot.id, submissionsAllowed: false, maxDurationSeconds });
      }
      return session;
    }, "console", records, { sendClearOnInterrupt: true });
  }

  status() {
    this.expireTicket();
    return {
      enabled: !this.closed, activeCalls: this.slot ? 1 : 0,
      maxConcurrentCalls: 1, maxDurationSeconds, submissionsAllowed: false,
    };
  }

  async issueTicket(origin: string) {
    if (this.closed) throw new AppError("dashboard_demo_closed");
    this.expireTicket();
    if (this.slot) throw new AppError("dashboard_demo_busy", "There is already a browser voice demo in progress.");
    this.bridgeListening ??= this.bridge.listen();
    await this.bridgeListening;
    if (this.closed) throw new AppError("dashboard_demo_closed");
    if (this.slot) throw new AppError("dashboard_demo_busy");
    const slot: DemoSlot = {
      id: `demo-${randomUUID()}`, streamId: `demo-stream-${randomUUID()}`, ticket: randomBytes(32).toString("hex"),
      origin, expiresAt: this.now() + ticketLifetimeMs, claimed: false, ready: false, stopping: false,
      finished: false, inputFrames: 0, transcriptEntries: 0, transcriptBytes: 0,
    };
    this.slot = slot;
    this.ticketTimer = setTimeout(() => this.expireTicket(), ticketLifetimeMs);
    this.ticketTimer.unref();
    return {
      callId: slot.id, ticket: slot.ticket, websocketPath: demoWebSocketPath,
      expiresAt: new Date(slot.expiresAt).toISOString(), maxDurationSeconds, submissionsAllowed: false,
      codec: "audio/x-mulaw", sampleRate: 8000, frameBytes: 160,
      decodeTable: Array.from({ length: 256 }, (_, value) => decodeMuLaw(value)),
    };
  }

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: string) => socket.end(
      `HTTP/1.1 ${status}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`,
    );
    if (this.closed) { reject("503 Service Unavailable"); return; }
    let origin: string;
    try { origin = dashboardRequestOrigin(request); }
    catch { reject("403 Forbidden"); return; }
    this.expireTicket();
    const protocols = request.headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim());
    const slot = this.slot;
    if (!slot || slot.claimed || slot.origin !== origin || protocols?.length !== 2 ||
        protocols[0] !== "maio-demo" || protocols[1] !== slot.ticket) {
      reject("401 Unauthorized");
      return;
    }
    this.sockets.handleUpgrade(request, socket, head, (client) => {
      slot.claimed = true;
      clearTimeout(this.ticketTimer);
      slot.client = client;
      client.on("message", (raw, binary) => {
        try {
          if (binary) throw new AppError("dashboard_demo_invalid_packet");
          let data: unknown;
          try { data = JSON.parse(raw.toString()); }
          catch { throw new AppError("dashboard_demo_invalid_packet"); }
          const packet = clientPacket.safeParse(data);
          if (!packet.success) throw new AppError("dashboard_demo_invalid_packet");
          if (packet.data.event === "stop") { this.stop(slot); return; }
          if (!slot.ready || slot.stopping || slot.bridge?.readyState !== WebSocket.OPEN) {
            throw new AppError("dashboard_demo_not_ready");
          }
          const audio = decodeAudio(packet.data.media.payload);
          if (audio.length !== 160) throw new AppError("unsupported_audio_frame_size");
          slot.inputFrames += 1;
          const elapsed = Date.now() - (slot.startedAt?.getTime() ?? Date.now());
          if (slot.inputFrames > Math.max(0, elapsed) / 20 + 100) throw new AppError("dashboard_demo_audio_rate_limit");
          if (slot.bridge.bufferedAmount > maxClientBuffer) throw new AppError("dashboard_demo_backpressure");
          slot.bridge.send(JSON.stringify({ event: "media", streamSid: slot.streamId, media: packet.data.media }));
        } catch (error) { this.fail(slot, errorCode(error)); }
      });
      client.on("close", () => this.stop(slot));
      client.on("error", () => this.fail(slot, "dashboard_demo_socket_error"));
      void this.connect(slot).catch((error: unknown) => this.fail(slot, errorCode(error)));
    });
  }

  private expireTicket(): void {
    if (this.slot && !this.slot.claimed && this.now() >= this.slot.expiresAt) {
      this.slot = undefined;
      clearTimeout(this.ticketTimer);
    }
  }

  private async connect(slot: DemoSlot): Promise<void> {
    const port = await this.bridgeListening;
    if (!port || this.closed || slot.stopping || slot !== this.slot) { this.finish(slot, "demo_stopped"); return; }
    const bridge = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: `Bearer ${this.bridgeToken}` }, handshakeTimeout: 5000,
      maxPayload: 4096, perMessageDeflate: false, followRedirects: false,
    });
    slot.bridge = bridge;
    bridge.on("open", () => {
      if (slot.stopping || slot.client?.readyState !== WebSocket.OPEN) { bridge.close(); return; }
      bridge.send(JSON.stringify({
        event: "start", start: {
          callSid: slot.id, streamSid: slot.streamId,
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
          customParameters: { call_id: slot.id },
        },
      }));
    });
    bridge.on("message", (raw, binary) => {
      try {
        if (binary) throw new AppError("dashboard_demo_bridge_protocol");
        const parsed = bridgePacket.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success || parsed.data.streamSid !== slot.streamId) throw new AppError("dashboard_demo_bridge_protocol");
        if (parsed.data.event === "clear") this.send(slot, { event: "clear" });
        else {
          if (decodeAudio(parsed.data.media.payload).length !== 160) throw new AppError("dashboard_demo_bridge_protocol");
          this.send(slot, { event: "media", media: parsed.data.media });
        }
      } catch (error) { this.fail(slot, errorCode(error)); }
    });
    bridge.on("error", () => this.fail(slot, "dashboard_demo_bridge_error"));
    bridge.on("close", () => {
      if (!slot.startedAt) this.finish(slot, slot.stopping ? "demo_stopped" : "demo_connection_failed");
    });
  }

  private record(slot: DemoSlot, event: CallRecordEvent): void {
    if (slot.finished) return;
    if (event.type === "transcript") {
      const envelope = { schemaVersion: 1, callId: slot.id };
      const text = [
        { ...envelope, type: "start", timestamp: slot.startedAt!.toISOString() },
        { ...envelope, ...event, timestamp: new Date().toISOString() },
      ].map((item) => JSON.stringify(item)).join("\n") + "\n";
      const projected = projectCallTranscript(text, slot.id, [
        this.config.DASHBOARD_TOKEN, this.config.voice.VOICE_ENDPOINT_TOKEN, this.bridgeToken, slot.ticket,
        this.config.voice.PROSPER_API_KEY, this.config.voice.AZURE_OPENAI_API_KEY ?? "",
        this.config.voice.APPLICATIONINSIGHTS_CONNECTION_STRING ?? "",
      ]);
      const entry = projected.entries[0];
      if (!entry) throw new AppError("dashboard_demo_invalid_transcript");
      slot.transcriptEntries += 1;
      slot.transcriptBytes += Buffer.byteLength(JSON.stringify(entry));
      if (slot.transcriptEntries > 500 || slot.transcriptBytes > 256 * 1024) {
        throw new AppError("dashboard_demo_transcript_limit");
      }
      this.send(slot, { event: "transcript", entry });
    } else if (event.type === "tool") {
      this.send(slot, {
        event: "tool", name: safeCode.parse(event.name), status: event.status,
        ...(event.code ? { code: safeCode.parse(event.code) } : {}),
      });
    } else if (event.type === "error") {
      this.send(slot, { event: "error", code: safeCode.parse(event.code) });
    }
  }

  private send(slot: DemoSlot, message: object): void {
    const client = slot.client;
    if (slot.finished || client?.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > maxClientBuffer) {
      client.close(1013, "demo_backpressure");
      this.stop(slot);
      return;
    }
    client.send(JSON.stringify(message), (error) => {
      if (error) this.stop(slot);
    });
  }

  private fail(slot: DemoSlot, code: string): void {
    if (slot.finished || slot.stopping) return;
    this.send(slot, { event: "error", code: safeCode.safeParse(code).success ? code : "dashboard_demo_error" });
    this.stop(slot);
  }

  private stop(slot: DemoSlot): void {
    if (slot.stopping || slot.finished) return;
    slot.stopping = true;
    if (slot.bridge?.readyState === WebSocket.OPEN) {
      if (slot.startedAt) slot.bridge.send(JSON.stringify({ event: "stop", streamSid: slot.streamId }));
      else slot.bridge.close();
    } else if (slot.bridge?.readyState === WebSocket.CONNECTING) slot.bridge.terminate();
    else if (!slot.startedAt) this.finish(slot, "demo_stopped");
  }

  private finish(slot: DemoSlot, reason: string): void {
    if (slot.finished) return;
    this.send(slot, { event: "ended", reason: reason === "prosper_stop" ? "demo_stopped" : reason });
    slot.finished = true;
    slot.ready = false;
    clearTimeout(this.ticketTimer);
    if (this.slot === slot) this.slot = undefined;
    if (slot.client && slot.client.readyState !== WebSocket.CLOSED) {
      if (slot.client.readyState === WebSocket.OPEN) slot.client.close(1000);
      const client = slot.client;
      const forceClose = setTimeout(() => client.terminate(), 1000);
      forceClose.unref();
      client.once("close", () => clearTimeout(forceClose));
    }
    if (slot.bridge?.readyState === WebSocket.OPEN) slot.bridge.close(1000);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.ticketTimer);
    if (this.slot) this.stop(this.slot);
    this.closing = (async () => {
      try {
        if (this.bridgeListening) {
          await this.bridgeListening;
          await this.bridge.close();
        }
      } finally {
        await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
      }
    })();
    return this.closing;
  }
}
