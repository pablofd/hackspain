import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as settle } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import WebSocket from "ws";
import { z } from "zod";
import { AudioQueue, type AudioChunk } from "../src/audio.js";
import {
  createAzureVoiceFactory, type AzureRealtimeDependencies, type VoiceSession,
} from "../src/azure-realtime.js";
import type { CallRecordEvent } from "../src/call-records.js";
import { parseConfig } from "../src/config.js";
import { AppError } from "../src/errors.js";
import { ProsperClient } from "../src/prosper.js";
import { receptionistTools } from "../src/receptionist.js";

const clinic = {
  clinic_name: "Offline Clinic", patient_count: 0,
  calendar: {
    starts: "2026-09-07", ends: "2026-10-16", max_span_days: 14, slot_minutes: 15, closure_days: [],
  },
  providers: [], locations: [], specialties: [], appointment_types: [], plans: [], restrictions: [],
};
const frame = (sample = 0x80) => Buffer.alloc(160, sample).toString("base64");
const messageSchema = z.object({ type: z.string() }).passthrough();

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  readonly sent: z.infer<typeof messageSchema>[] = [];
  readonly closeCodes: (number | undefined)[] = [];
  terminated = false;

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  receive(event: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(event)), false);
  }

  send(payload: string): void {
    assert.equal(this.readyState, WebSocket.OPEN);
    this.sent.push(messageSchema.parse(JSON.parse(payload)));
  }

  close(code?: number): void {
    this.closeCodes.push(code);
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  terminate(): void {
    this.terminated = true;
    this.close();
  }

  events(type: string): z.infer<typeof messageSchema>[] {
    return this.sent.filter((event) => event.type === type);
  }

  created(id: string): void {
    this.receive({ type: "response.created", response: { id, status: "in_progress" } });
  }

  done(id: string, status = "completed"): void {
    this.receive({ type: "response.done", response: {
      id, status, usage: { input_tokens: 10, output_tokens: 5 },
    } });
  }

  tool(responseId: string, callId: string, name: string, args: unknown): void {
    this.receive({
      type: "response.function_call_arguments.done",
      response_id: responseId, call_id: callId, name, arguments: JSON.stringify(args),
    });
  }

  audio(responseId: string, itemId: string, bytes = Buffer.alloc(320, 0x80)): void {
    this.receive({
      type: "response.audio.delta", response_id: responseId, item_id: itemId,
      content_index: 0, delta: bytes.toString("base64"),
    });
  }

  outputs(): { call_id: string; output: Record<string, unknown> }[] {
    return this.events("conversation.item.create").flatMap((event) => {
      const parsed = z.object({
        type: z.literal("function_call_output"), call_id: z.string(), output: z.string(),
      }).safeParse(event.item);
      return parsed.success ? [{
        call_id: parsed.data.call_id,
        output: z.record(z.string(), z.unknown()).parse(JSON.parse(parsed.data.output)),
      }] : [];
    });
  }
}

function harness(t: TestContext, options: {
  greet?: boolean;
  token?: boolean;
  getToken?: AzureRealtimeDependencies["getToken"];
  request?: typeof fetch;
  maxFrames?: number;
  onRecord?: (event: CallRecordEvent) => void;
} = {}) {
  const config = parseConfig({
    AZURE_OPENAI_ENDPOINT: "https://offline.openai.azure.com",
    AZURE_OPENAI_DEPLOYMENT: "offline-realtime",
    AZURE_OPENAI_API_VERSION: "2024-10-01-preview",
    ...(options.token ? {} : { AZURE_OPENAI_API_KEY: "offline-key" }),
    PROSPER_API_BASE_URL: "https://clinic.example",
    PROSPER_API_KEY: "offline-key",
    VOICE_ENDPOINT_TOKEN: "offline-endpoint-token-000000000000",
  });
  const socket = new FakeSocket();
  const controller = new AbortController();
  const queue = new AudioQueue(options.maxFrames);
  const audio: AudioChunk[] = [];
  const finished: string[] = [];
  const failures: AppError[] = [];
  const records: CallRecordEvent[] = [];
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const connections: { url: URL; options: WebSocket.ClientOptions }[] = [];
  let completed = 0;
  const api = new ProsperClient(config, async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (options.request) return options.request(input, init);
    assert.notEqual(init?.method, "POST", "No default fixture may submit an action");
    if (url.pathname.endsWith("/clinic")) return Response.json(clinic);
    if (url.pathname.endsWith("/directory")) return Response.json({ matches: [] });
    throw new Error("Unexpected offline endpoint");
  });
  const factory = createAzureVoiceFactory(config, api, {
    createWebSocket: (url, settings) => {
      connections.push({ url: new URL(url), options: settings });
      return socket as unknown as WebSocket;
    },
    getToken: options.getToken ?? (async () => ({ token: "offline-token" })),
  });
  const connecting = factory({
    callId: "offline-transport-call", startedAt: new Date("2026-09-18T18:00:00Z"),
    parent: ROOT_CONTEXT, signal: controller.signal, greet: options.greet ?? false,
    allowSubmissions: true,
    onAudio: (chunk) => { queue.push(chunk); audio.push(chunk); },
    onAudioDone: (itemId) => { queue.finish(itemId); finished.push(itemId); },
    onInterrupt: () => queue.interrupt(),
    onFailure: (error) => failures.push(error),
    onTurnDone: () => { completed += 1; },
    onRecord: (event) => { records.push(event); options.onRecord?.(event); },
  });
  void connecting.catch(() => {});
  t.after(async () => {
    controller.abort();
    const session = await connecting.catch(() => undefined);
    await session?.close();
  });
  async function connect(): Promise<VoiceSession> {
    await settle();
    socket.open();
    socket.receive({ type: "session.updated" });
    return connecting;
  }
  return {
    socket, controller, queue, audio, finished, failures, records, requests, connections, api,
    connecting, connect, completed: () => completed,
  };
}

test("offline session init keeps the preview protocol, mu-law, semantic VAD and complete tool schemas", async (t) => {
  const h = harness(t);
  const session = await h.connect();
  const connection = h.connections[0]!;
  assert.equal(connection.url.protocol, "wss:");
  assert.equal(connection.url.pathname, "/openai/realtime");
  assert.equal(connection.url.searchParams.get("api-version"), "2024-10-01-preview");
  assert.equal(connection.url.searchParams.get("deployment"), "offline-realtime");
  assert.equal(connection.options.followRedirects, false);
  assert.equal(connection.options.handshakeTimeout, 10_000);
  assert.equal(connection.options.maxPayload, 2 * 1024 * 1024);
  assert.deepEqual(connection.options.headers, { "api-key": "offline-key" });
  const update = z.object({ session: z.record(z.string(), z.unknown()) }).parse(h.socket.sent[0]).session;
  assert.deepEqual(update.modalities, ["text", "audio"]);
  assert.equal(update.input_audio_format, "g711_ulaw");
  assert.equal(update.output_audio_format, "g711_ulaw");
  assert.deepEqual(update.input_audio_transcription, { model: "whisper-1" });
  assert.deepEqual(update.turn_detection, { type: "semantic_vad", eagerness: "auto" });
  assert.deepEqual(update.tools, receptionistTools);
  assert.equal(h.socket.events("response.create").length, 0);
  session.sendAudio(frame());
  assert.deepEqual(h.socket.events("input_audio_buffer.append"), [{
    type: "input_audio_buffer.append", audio: frame(),
  }]);
  assert.throws(() => session.sendAudio(Buffer.alloc(161).toString("base64")),
    { code: "unsupported_audio_frame_size" });
  assert.throws(() => session.sendAudio("%%%"));
  h.socket.bufferedAmount = 1024 * 1024 - 1;
  assert.throws(() => session.sendAudio(frame()), { code: "azure_input_backpressure" });
});

test("queued caller audio gets the first turn instead of racing the greeting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t, { greet: true });
  const session = await h.connect();
  assert.equal(h.socket.events("response.create").length, 0);
  session.sendAudio(frame());
  t.mock.timers.tick(1);
  assert.equal(h.socket.events("response.create").length, 0);
  h.socket.receive({ type: "input_audio_buffer.speech_started" });
  h.socket.receive({ type: "input_audio_buffer.speech_stopped" });
  h.socket.created("caller-first");
  h.socket.done("caller-first");
  h.socket.receive({ type: "session.updated" });
  t.mock.timers.tick(9000);
  assert.equal(h.socket.events("response.create").length, 0);
  assert.deepEqual(h.failures, []);
});

test("silent startup gets just one concise greeting and pauses longer than eight seconds stay open", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t, { greet: true });
  const session = await h.connect();
  session.sendAudio(frame(0xff));
  session.sendAudio(frame(0x7f));
  t.mock.timers.tick(1);
  const requests = h.socket.events("response.create");
  assert.equal(requests.length, 1);
  const greeting = z.object({ response: z.object({ instructions: z.string() }) }).parse(requests[0]);
  assert.match(greeting.response.instructions, /one short greeting/);
  assert.match(greeting.response.instructions, /Start in English/);
  assert.match(greeting.response.instructions, /How can I help you today\?/);
  assert.throws(() => session.sendText("Do not create a second response"), { code: "azure_response_busy" });
  h.socket.created("greeting");
  h.socket.done("greeting");
  h.socket.receive({ type: "session.updated" });
  t.mock.timers.tick(9000);
  assert.equal(h.socket.events("response.create").length, 1);
  assert.equal(h.completed(), 1);
  assert.equal(h.socket.readyState, WebSocket.OPEN);
  assert.deepEqual(h.failures, []);
});

test("tools serialize and duplicate arguments/done events produce one output and one continuation", async (t) => {
  const lookup = Promise.withResolvers<Response>();
  const h = harness(t, {
    request: async (input) => new URL(String(input)).pathname.endsWith("/directory")
      ? lookup.promise : Response.json(clinic),
  });
  const session = await h.connect();
  session.sendText("Look up the patient and clinic.");
  assert.throws(() => session.sendText("Second response"), { code: "azure_response_busy" });
  h.socket.created("tools");
  const args = { name: "Luz Ejemplo Prueba", date_of_birth: "1980-05-10" };
  h.socket.tool("tools", "lookup", "find_patient", args);
  h.socket.tool("tools", "lookup", "find_patient", args);
  h.socket.tool("tools", "catalogue", "get_clinic", {});
  h.socket.done("tools");
  h.socket.done("tools");
  await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.socket.outputs().length, 0);
  assert.throws(() => session.sendText("Still waiting for tools"), { code: "azure_response_busy" });
  lookup.resolve(Response.json({ matches: [] }));
  await settle();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.socket.outputs().map((item) => item.call_id), ["lookup", "catalogue"]);
  assert.equal(h.socket.events("response.create").length, 2);
  h.socket.done("tools");
  await settle();
  assert.equal(h.socket.events("response.create").length, 2);
  assert.throws(() => session.sendText("Continuation is pending"), { code: "azure_response_busy" });
  h.socket.created("answer");
  h.socket.created("answer");
  h.socket.done("answer");
  h.socket.done("answer");
  assert.equal(h.completed(), 1);
  assert.deepEqual(h.failures, []);
});

test("interruption during a lookup skips queued tools and cannot resume an old spoken continuation", async (t) => {
  const lookup = Promise.withResolvers<Response>();
  const h = harness(t, { request: async () => lookup.promise });
  const session = await h.connect();
  session.sendText("Find the first request.");
  h.socket.created("old-lookup");
  h.socket.tool("old-lookup", "old-find", "find_patient", {
    name: "Luz Ejemplo Prueba", date_of_birth: "1980-05-10",
  });
  h.socket.tool("old-lookup", "old-catalogue", "get_clinic", {});
  h.socket.done("old-lookup");
  await settle();
  assert.equal(h.requests.length, 1);
  h.socket.receive({ type: "input_audio_buffer.speech_started" });
  h.socket.receive({ type: "input_audio_buffer.speech_stopped" });
  h.socket.created("latest-request");
  h.socket.audio("latest-request", "latest-audio");
  lookup.resolve(Response.json({ matches: [] }));
  await settle();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.socket.outputs().map((item) => item.output.error), ["stale_turn", "stale_turn"]);
  assert.equal(h.socket.events("response.create").length, 1);
  assert.deepEqual(h.audio.map((chunk) => chunk.itemId), ["latest-audio"]);
  h.socket.done("latest-request");
  assert.equal(h.completed(), 1);
  assert.deepEqual(h.failures, []);
});

test("cancelled response audio, including unseen late items, stays discarded after new playback starts", async (t) => {
  const h = harness(t);
  const session = await h.connect();
  session.sendText("Begin a response.");
  h.socket.created("old");
  h.socket.audio("old", "old-audio");
  assert.equal(h.queue.next()?.length, 160);
  h.socket.receive({ type: "input_audio_buffer.speech_started" });
  assert.deepEqual(h.socket.events("conversation.item.truncate"), [{
    type: "conversation.item.truncate", item_id: "old-audio", content_index: 0, audio_end_ms: 20,
  }]);
  assert.ok(h.records.some((event) => event.type === "interruption" &&
    event.itemId === "old-audio" && event.audioEndMs === 20));
  const cancel = h.socket.events("response.cancel")[0]!;
  assert.equal(cancel.response_id, "old");
  h.socket.done("old", "cancelled");
  h.socket.audio("old", "old-audio");
  h.socket.audio("old", "unseen-old-audio");
  h.socket.receive({ type: "response.audio.done", response_id: "old", item_id: "old-audio" });
  assert.equal(h.queue.next(), undefined);
  h.socket.receive({
    type: "error", error: { code: "response_cancel_not_active", event_id: cancel.event_id },
  });
  h.socket.receive({ type: "input_audio_buffer.speech_stopped" });
  h.socket.created("new");
  h.socket.audio("new", "new-audio", Buffer.alloc(160, 0x82));
  h.socket.audio("old", "another-old-item");
  assert.equal(h.queue.next()?.[0], 0x82);
  assert.equal(h.queue.next(), undefined);
  assert.deepEqual(h.audio.map((chunk) => chunk.itemId), ["old-audio", "new-audio"]);
  assert.deepEqual(h.finished, []);
  h.socket.done("new");
  assert.equal(h.completed(), 1);
  assert.deepEqual(h.failures, []);
});

test("a requested response created after interruption keeps its original generation", async (t) => {
  const h = harness(t);
  const session = await h.connect();
  session.sendText("A response that has not started yet.");
  h.socket.receive({ type: "input_audio_buffer.speech_started" });
  h.socket.receive({ type: "input_audio_buffer.speech_stopped" });
  h.socket.created("delayed-old-response");
  h.socket.audio("delayed-old-response", "delayed-audio");
  h.socket.done("delayed-old-response");
  assert.equal(h.audio.length, 0);
  assert.equal(h.completed(), 0);
  assert.equal(h.socket.events("response.cancel").length, 1);
  h.socket.created("latest");
  h.socket.audio("latest", "latest-audio");
  h.socket.done("latest");
  assert.deepEqual(h.audio.map((chunk) => chunk.itemId), ["latest-audio"]);
  assert.equal(h.completed(), 1);
  assert.deepEqual(h.failures, []);
});

test("audio.done flushes a partial tail as a 20 ms frame without replaying late completed output", async (t) => {
  const h = harness(t);
  await h.connect();
  h.socket.created("finished");
  h.socket.audio("finished", "tail", Buffer.alloc(161, 0x82));
  assert.equal(h.queue.next()?.length, 160);
  assert.equal(h.queue.next(), undefined);
  h.socket.receive({ type: "response.audio.done", response_id: "finished", item_id: "tail" });
  h.socket.done("finished");
  const tail = h.queue.next();
  assert.equal(tail?.length, 160);
  assert.equal(tail?.[0], 0x82);
  assert.deepEqual(tail?.subarray(1), Buffer.alloc(159, 0xff));
  h.socket.audio("finished", "late-completed-item");
  h.socket.receive({ type: "response.audio.done", response_id: "finished", item_id: "tail" });
  assert.equal(h.queue.next(), undefined);
  assert.deepEqual(h.finished, ["tail"]);
  assert.equal(h.completed(), 1);
  assert.deepEqual(h.failures, []);
});

test("barge-in truncates completed generation to played audio, not all generated frames", async (t) => {
  const h = harness(t);
  await h.connect();
  h.socket.created("generated");
  h.socket.audio("generated", "buffered", Buffer.alloc(800));
  h.socket.receive({ type: "response.audio.done", response_id: "generated", item_id: "buffered" });
  h.socket.done("generated");
  h.queue.next();
  h.queue.next();
  h.socket.receive({ type: "input_audio_buffer.speech_started" });
  assert.deepEqual(h.socket.events("conversation.item.truncate"), [{
    type: "conversation.item.truncate", item_id: "buffered", content_index: 0, audio_end_ms: 40,
  }]);
  assert.equal(h.queue.next(), undefined);
  assert.equal(h.socket.events("response.cancel").length, 0);
  assert.deepEqual(h.failures, []);
});

test("cancellation without a speech event also clears unheard queued audio", async (t) => {
  const h = harness(t);
  await h.connect();
  h.socket.created("cancelled");
  h.socket.audio("cancelled", "unheard");
  h.socket.done("cancelled", "cancelled");
  h.socket.audio("cancelled", "late");
  assert.equal(h.queue.next(), undefined);
  assert.equal(h.socket.events("conversation.item.truncate")[0]?.audio_end_ms, 0);
  assert.equal(h.completed(), 0);
  assert.deepEqual(h.failures, []);
});

test("final input, audio and text transcripts go only to private records, including interrupted output", async (t) => {
  const logged: unknown[][] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logged.push(args); });
  t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args); });
  const h = harness(t);
  await h.connect();
  const userText = "Synthetic private caller transcript.";
  const assistantText = "Synthetic generated assistant transcript.";
  h.socket.created("recorded");
  h.socket.receive({ type: "input_audio_buffer.speech_started" });
  h.socket.receive({
    type: "conversation.item.input_audio_transcription.completed", item_id: "input", transcript: userText,
  });
  h.socket.receive({
    type: "response.audio_transcript.done", item_id: "output", transcript: assistantText,
  });
  h.socket.receive({ type: "response.text.done", item_id: "text", text: "Synthetic text-only answer." });
  h.socket.receive({
    type: "conversation.item.input_audio_transcription.failed", error: { message: userText },
  });
  assert.deepEqual(h.records.filter((event) => event.type === "transcript"), [
    { type: "transcript", speaker: "user", itemId: "input", text: userText },
    { type: "transcript", speaker: "assistant", itemId: "output", text: assistantText },
    { type: "transcript", speaker: "assistant", itemId: "text", text: "Synthetic text-only answer." },
  ]);
  assert.ok(h.records.some((event) => event.type === "error" && event.code === "input_transcription_failed"));
  assert.doesNotMatch(JSON.stringify(logged), /Synthetic|private caller|generated assistant/);
  assert.deepEqual(h.failures, []);
});

test("credential acquisition is injectable, lazy for API keys, and fails closed without a socket", async (t) => {
  const apiKey = harness(t, { getToken: async () => { throw new Error("Must not read credentials"); } });
  await apiKey.connect();
  assert.deepEqual(apiKey.failures, []);
  const token = harness(t, { token: true });
  await token.connect();
  assert.deepEqual(token.connections[0]?.options.headers, { Authorization: "Bearer offline-token" });
  const failed = harness(t, { token: true, getToken: async () => null });
  await assert.rejects(failed.connecting, { code: "azure_authentication_failed" });
  assert.equal(failed.connections.length, 0);
  const waiting = Promise.withResolvers<{ token: string }>();
  const aborted = harness(t, { token: true, getToken: async () => waiting.promise });
  aborted.controller.abort();
  waiting.resolve({ token: "offline-token" });
  await assert.rejects(aborted.connecting, { code: "call_cancelled" });
  assert.equal(aborted.connections.length, 0);
});

test("unrecognized upstream errors, malformed events and unexpected disconnects remain explicit failures", async (t) => {
  const cases: { code: string; trigger: (socket: FakeSocket) => void }[] = [
    { code: "azure_rate_limit_exceeded", trigger: (s) => s.receive({
      type: "error", error: { code: "rate_limit_exceeded", message: "Never expose this upstream detail" },
    }) },
    { code: "azure_response_cancel_not_active", trigger: (s) => s.receive({
      type: "error", error: { code: "response_cancel_not_active", event_id: "not-our-cancel" },
    }) },
    { code: "azure_service_error", trigger: (s) => s.receive({ type: "error", error: { code: "unsafe code!" } }) },
    { code: "azure_invalid_event", trigger: (s) => s.emit("message", Buffer.from("{"), false) },
    { code: "azure_unexpected_binary", trigger: (s) => s.emit("message", Buffer.alloc(1), true) },
    { code: "azure_unknown_response", trigger: (s) => s.audio("unknown-response", "unknown-item") },
    { code: "azure_websocket_error", trigger: (s) => s.emit("error", new Error("Private socket detail")) },
    { code: "azure_disconnected", trigger: (s) => s.close() },
  ];
  for (const entry of cases) {
    await t.test(entry.code, async (subtest) => {
      const h = harness(subtest);
      await h.connect();
      entry.trigger(h.socket);
      await settle();
      assert.deepEqual(h.failures.map((error) => error.code), [entry.code]);
      assert.equal(h.completed(), 0);
      assert.equal(h.socket.readyState, WebSocket.CLOSED);
      assert.equal(h.requests.length, 0);
    });
  }
});

test("failed or incomplete responses cannot report a successful turn", async (t) => {
  for (const status of ["failed", "incomplete"]) {
    await t.test(status, async (subtest) => {
      const h = harness(subtest);
      await h.connect();
      h.socket.created("failed-response");
      h.socket.done("failed-response", status);
      await settle();
      assert.deepEqual(h.failures.map((error) => error.code), [`azure_response_${status}`]);
      assert.equal(h.completed(), 0);
    });
  }
});

test("HTTP handshake failure and session initialization timeout reject the connection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const denied = harness(t);
  let drained = false;
  denied.socket.emit("unexpected-response", {}, { statusCode: 401, resume: () => { drained = true; } });
  await assert.rejects(denied.connecting, { code: "azure_http_401" });
  assert.equal(drained, true);
  assert.deepEqual(denied.failures.map((error) => error.code), ["azure_http_401"]);
  const timeout = harness(t);
  timeout.socket.open();
  t.mock.timers.tick(15_000);
  await assert.rejects(timeout.connecting, { code: "azure_session_timeout" });
  assert.deepEqual(timeout.failures.map((error) => error.code), ["azure_session_timeout"]);
});

test("audio output overflow fails rather than allowing an unbounded playback queue", async (t) => {
  const h = harness(t, { maxFrames: 1 });
  await h.connect();
  h.socket.created("too-much-audio");
  h.socket.audio("too-much-audio", "too-long");
  await settle();
  assert.deepEqual(h.failures.map((error) => error.code), ["audio_output_backpressure"]);
  assert.equal(h.queue.next(), undefined);
});

test("close waits for confirmed POSTs already in flight and never starts queued actions or lookups", { timeout: 5000 }, async (t) => {
  const submitted = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const h = harness(t, { request: async (_input, init) => {
    assert.equal(init?.method, "POST");
    started.resolve();
    return submitted.promise;
  } });
  const session = await h.connect();
  session.sendText("An explicitly final out-of-scope request.");
  h.socket.created("outcome");
  h.socket.tool("outcome", "confirmed-outcome", "report_outcome", {
    action: "NO_ACTION", reason: "out_of_scope",
  });
  h.socket.tool("outcome", "queued-action", "report_outcome", {
    action: "ESCALATE", reason: "medical_emergency",
  });
  h.socket.tool("outcome", "queued-lookup", "get_clinic", {});
  h.socket.done("outcome");
  await started.promise;
  assert.equal(h.requests.length, 1);
  assert.ok(h.records.some((event) => event.type === "action" && event.stage === "confirmed"));
  const pendingSignal = h.requests[0]?.init?.signal;
  h.controller.abort();
  const closing = session.close();
  assert.equal(session.close(), closing);
  let closed = false;
  void closing.then(() => { closed = true; });
  await settle();
  assert.equal(closed, false);
  assert.equal(pendingSignal?.aborted, false);
  assert.equal(h.socket.readyState, WebSocket.CLOSED);
  submitted.resolve(Response.json({
    call_id: "offline-transport-call", received_at: "2026-09-18T18:00:00Z",
    record: { actions: [{ action: "NO_ACTION", reason: "out_of_scope" }] },
  }));
  await closing;
  assert.equal(closed, true);
  assert.equal(h.requests.length, 1);
  assert.ok(h.records.some((event) => event.type === "action" && event.stage === "accepted"));
  assert.equal(h.records.filter((event) => event.type === "action" && event.stage === "confirmed").length, 1);
  assert.deepEqual(h.socket.outputs(), []);
  assert.equal(h.socket.events("response.create").length, 1);
  assert.equal(h.completed(), 0);
  assert.deepEqual(h.failures, []);
});

test("a registration request cannot become a patient-not-found refusal through the voice tool dispatcher", { timeout: 5000 }, async (t) => {
  const reported = Promise.withResolvers<void>();
  const h = harness(t, {
    onRecord: (event) => {
      if (event.type === "tool" && event.name === "report_outcome") reported.resolve();
    },
  });
  const session = await h.connect();
  session.sendText("Please look up the existing patient.");
  h.socket.created("lookup");
  h.socket.tool("lookup", "find", "find_patient", {
    name: "Luz Ejemplo Prueba", date_of_birth: "1980-05-10",
  });
  h.socket.done("lookup");
  await settle();
  h.socket.created("clarification");
  h.socket.done("clarification");
  session.sendText("I want to register as a new patient instead.");
  h.socket.created("outcome");
  h.socket.tool("outcome", "wrong-refusal", "report_outcome", {
    action: "NO_ACTION", reason: "patient_not_found",
  });
  h.socket.done("outcome");
  await reported.promise;
  await settle();
  assert.equal(h.socket.outputs().find((item) => item.call_id === "wrong-refusal")?.output.error,
    "outcome_request_unresolved");
  assert.equal(h.requests.some((request) => request.init?.method === "POST"), false);
  assert.equal(h.records.some((event) => event.type === "action" && event.stage === "accepted"), false);
  assert.deepEqual(h.failures, []);
});

test("a new caller turn invalidates a terminal refusal still waiting for transcript stability", { timeout: 5000 }, async (t) => {
  const reported = Promise.withResolvers<void>();
  const h = harness(t, {
    onRecord: (event) => {
      if (event.type === "tool" && event.name === "report_outcome") reported.resolve();
    },
  });
  const session = await h.connect();
  session.sendText("An out-of-scope request to refuse.");
  h.socket.created("outcome");
  h.socket.tool("outcome", "stale-refusal", "report_outcome", {
    action: "NO_ACTION", reason: "out_of_scope",
  });
  h.socket.done("outcome");
  await settle();
  assert.equal(h.requests.length, 0);
  h.socket.receive({ type: "input_audio_buffer.speech_started", item_id: "correction" });
  h.socket.receive({ type: "input_audio_buffer.speech_stopped" });
  await reported.promise;
  await settle();
  assert.equal(h.socket.outputs().find((item) => item.call_id === "stale-refusal")?.output.error, "stale_turn");
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.failures, []);
});

test("closing aborts a read-only lookup without creating a final action", async (t) => {
  const h = harness(t, { request: async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("Offline lookup aborted")), { once: true });
  }) });
  const session = await h.connect();
  session.sendText("Read the catalogue.");
  h.socket.created("lookup");
  h.socket.tool("lookup", "read", "get_clinic", {});
  await settle();
  assert.equal(h.requests.length, 1);
  await session.close();
  assert.equal(h.requests[0]?.init?.signal?.aborted, true);
  assert.equal(h.requests.some((request) => request.init?.method === "POST"), false);
  assert.deepEqual(h.socket.outputs(), []);
  assert.throws(() => session.sendText("Cannot act after close"), { code: "azure_not_connected" });
  assert.deepEqual(h.failures, []);
});

test("abort before session initialization cancels setup without a greeting or submission", async (t) => {
  const h = harness(t, { greet: true });
  h.controller.abort();
  await assert.rejects(h.connecting, { code: "call_cancelled" });
  assert.equal(h.socket.terminated, true);
  assert.equal(h.socket.events("response.create").length, 0);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.failures, []);
});
