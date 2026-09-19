import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as settle, setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import WebSocket from "ws";
import { z } from "zod";
import { AudioQueue } from "../src/audio.js";
import { azureLiveUrl, createAzureLiveVoiceFactory, type AzureLiveDependencies } from "../src/azure-live.js";
import type { VoiceSession } from "../src/azure-realtime.js";
import type { CallRecordEvent } from "../src/call-records.js";
import { AppError } from "../src/errors.js";
import { ProsperClient } from "../src/prosper.js";
import { actionSchema, type ProsperAction } from "../src/prosper-types.js";
import { config } from "./helpers.js";

const frame = (value = 0x80) => Buffer.alloc(160, value).toString("base64");
const messageSchema = z.object({ type: z.string() }).passthrough();
const patient = {
  patient_id: "PTEST", given_name: "Ana", first_surname: "Prueba", second_surname: "Test",
  national_id: "12345678Z", date_of_birth: "1988-03-14", phone: "612345678",
  has_visited_before: true, insurer: "mapfre", referrals: [], note: "",
  matched_fields: ["name", "national_id"],
};
const slot = {
  provider_id: "PRTEST", provider_name: "Test Doctor", specialty_id: "general_practice",
  location_id: "centro", appointment_type_id: "review",
  start_time: "2026-09-19T11:00:00+02:00", duration_minutes: 15, payable_with: ["mapfre"],
};
const clinic = {
  clinic_name: "Synthetic Clinic", patient_count: 1,
  calendar: { starts: "2026-09-07", ends: "2026-10-16", max_span_days: 14, slot_minutes: 15, closure_days: [] },
  locations: [{ id: "centro", name: "Centro", address: "Synthetic", latitude: 40.4, longitude: -3.7,
    hours: [{ weekday: "saturday", intervals: ["09:00-14:00"] }] }],
  providers: [{ id: "PRTEST", name: "Test Doctor", specialty_id: "general_practice", languages: ["en", "es"],
    schedules: [{ location_id: "centro", location_name: "Centro", days: [{ weekday: "saturday", intervals: ["09:00-14:00"] }] }], leave: null }],
  specialties: [{ id: "general_practice", name: "General Practice", min_age_months: 168, max_age_months: null, referral_required: false }],
  appointment_types: [{ id: "review", name: "Review" }],
  plans: [{ id: "mapfre", name: "Mapfre" }], restrictions: [],
};

class LiveSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  readonly sent: z.infer<typeof messageSchema>[] = [];
  automaticClose = true;
  private sequence = 0;

  open(): void { this.readyState = WebSocket.OPEN; this.emit("open"); }
  receive(event: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify({ event_id: `server-${++this.sequence}`, ...event })), false);
  }
  send(payload: string): void {
    assert.equal(this.readyState, WebSocket.OPEN);
    const event = messageSchema.parse(JSON.parse(payload));
    this.sent.push(event);
    if (event.type === "session.close" && this.automaticClose) {
      queueMicrotask(() => this.receive({ type: "session.closed", reason: "client_request", usage: { seconds: 2 } }));
    }
  }
  close(): void { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  terminate(): void { this.close(); }
  events(type: string) { return this.sent.filter((event) => event.type === type); }
  created(delegation: string, response: string): void {
    this.receive({ type: "session.delegation.created", delegation: {
      id: delegation, type: "delegation", target: "responses", response_id: response,
    } });
    this.response(delegation, { type: "response.created", response: { id: response, status: "in_progress" } });
  }
  response(delegation: string | null, event: Record<string, unknown>): void {
    this.receive({ type: "response.event", delegation_id: delegation, event });
  }
  tool(delegation: string | null, id: string, name: string, args: unknown): void {
    this.response(delegation, { type: "response.output_item.done", item: {
      type: "function_call", call_id: id, name, arguments: JSON.stringify(args),
    } });
  }
  done(delegation: string | null, id: string): void {
    this.response(delegation, { type: "response.completed",
      response: { id, status: "completed", output: [], tools: [], instructions: null, usage: { input_tokens: 8, output_tokens: 4 } } });
  }
  outputs() {
    return this.events("response.item.create").flatMap((event) => {
      const parsed = z.object({
        type: z.literal("function_call_output"), call_id: z.string(), output: z.string(),
      }).safeParse(event.item);
      return parsed.success ? [{ callId: parsed.data.call_id, output: JSON.parse(parsed.data.output) as unknown }] : [];
    });
  }
}

function harness(t: TestContext, options: {
  greet?: boolean;
  submissions?: boolean;
  request?: typeof fetch;
  submit?: typeof fetch;
  token?: boolean;
  getToken?: AzureLiveDependencies["getToken"];
  closeTimeoutMs?: number;
} = {}) {
  const settings = config({
    VOICE_CONNECTOR: "live", AZURE_OPENAI_LIVE_DEPLOYMENT: "live-test",
    AZURE_OPENAI_LIVE_BACKEND_DEPLOYMENT: "backend-test",
    ...(options.token ? {} : { AZURE_OPENAI_API_KEY: "synthetic-azure-key" }),
  });
  const socket = new LiveSocket();
  const controller = new AbortController();
  const queue = new AudioQueue();
  const records: CallRecordEvent[] = [];
  const failures: AppError[] = [];
  const requests: { url: URL; init?: RequestInit }[] = [];
  const actions: ProsperAction[] = [];
  const finished: string[] = [];
  let connection: { url: URL; options: WebSocket.ClientOptions } | undefined;
  const api = new ProsperClient(settings, async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, ...(init ? { init } : {}) });
    if (options.request) return options.request(input, init);
    if (init?.method === "POST") {
      const body = z.record(z.string(), z.unknown()).parse(JSON.parse(String(init.body)));
      assert.equal(body.call_id, "authoritative-live-call");
      const { call_id: _callId, ...fields } = body;
      actions.push(actionSchema.parse({
        ...fields, action: url.pathname.split("/").at(-1)?.toUpperCase().replace("-", "_"),
      }));
      if (options.submit) return options.submit(input, init);
      return Response.json({ call_id: "authoritative-live-call", received_at: "2026-09-18T18:00:00Z", record: { actions } });
    }
    if (url.pathname.endsWith("/clinic")) return Response.json(clinic);
    if (url.pathname.endsWith("/directory")) return Response.json({ matches: [patient] });
    if (url.pathname.endsWith("/availability")) return Response.json({
      providers: clinic.providers, appointment_type: { id: "review", name: "Review", duration_minutes: 15, guidance: "" },
      slots: [slot], blocked: [],
    });
    throw new Error("Unexpected synthetic route");
  });
  const connecting = createAzureLiveVoiceFactory(settings, api, {
    createWebSocket: (url, options) => {
      connection = { url: new URL(url), options };
      return socket as unknown as WebSocket;
    },
    getToken: options.getToken ?? (async () => ({ token: "synthetic-managed-token" })),
    transcriptSettleMs: 0,
    closeTimeoutMs: options.closeTimeoutMs ?? 20,
  })({
    callId: "authoritative-live-call", startedAt: new Date("2026-09-18T18:00:00Z"),
    parent: ROOT_CONTEXT, signal: controller.signal, greet: options.greet ?? false,
    allowSubmissions: options.submissions ?? true,
    onAudio: (chunk) => queue.push(chunk),
    onAudioDone: (id) => { finished.push(id); queue.finish(id); },
    onInterrupt: () => queue.interruptAll(),
    onFailure: (error) => failures.push(error),
    onTurnDone: () => {},
    onRecord: (event) => records.push(event),
  });
  void connecting.catch(() => {});
  t.after(async () => {
    controller.abort();
    const session = await connecting.catch(() => undefined);
    await session?.close().catch((error: unknown) => {
      assert.ok(error instanceof AppError && error.code === "azure_live_close_unconfirmed");
    });
  });
  const connect = async (): Promise<VoiceSession> => {
    await settle();
    socket.open();
    socket.receive({ type: "session.started", session: {
      id: "live-session", model: "live-test", audio: { format: { type: "audio/pcmu", rate: 8000 } },
      delegation: { type: "responses" },
    } });
    return connecting;
  };
  const user = (text: string, start = 0, end = 100) =>
    socket.receive({ type: "session.input_transcript.delta", delta: text, start_ms: start, end_ms: end });
  return { socket, controller, queue, records, failures, requests, actions, finished, connect, connecting, user, connection: () => connection };
}

async function prepare(h: ReturnType<typeof harness>): Promise<string> {
  h.user("Book a GP appointment for me, Ana Prueba Test, DNI 12345678Z.");
  h.socket.created("proposal-task", "lookup");
  h.socket.tool("proposal-task", "find", "find_patient", { name: "Ana Prueba Test", national_id: "12345678Z" });
  h.socket.done("proposal-task", "lookup");
  await settle();
  h.socket.response("proposal-task", { type: "response.created", response: { id: "search", status: "in_progress" } });
  h.socket.tool("proposal-task", "search-call", "search_availability", {
    patient_id: "PTEST", specialty_id: "general_practice", prepare_booking: true,
  });
  h.socket.done("proposal-task", "search");
  await settle();
  const output = z.object({ booking_proposal: z.object({ proposal_id: z.string() }) }).parse(
    h.socket.outputs().find((item) => item.callId === "search-call")?.output,
  );
  h.socket.response("proposal-task", { type: "response.created", response: { id: "readback", status: "in_progress" } });
  h.socket.done("proposal-task", "readback");
  h.socket.receive({
    type: "session.output_transcript.delta", delta: "Here is the complete prepared appointment. May I book it?",
    start_ms: 200, end_ms: 800,
  });
  return output.booking_proposal.proposal_id;
}

test("Live uses its own endpoint, native PCMU, voice and Responses backend without changing Realtime config", async (t) => {
  const h = harness(t);
  await h.connect();
  assert.equal(h.connection()?.url.pathname, "/openai/v1/live/sessions");
  assert.equal(h.connection()?.url.search, "");
  const event = z.object({ session: z.object({
    model: z.string(), audio: z.object({ format: z.object({ type: z.string(), rate: z.number() }), output: z.object({ voice: z.string() }) }),
    delegation: z.object({ type: z.string(), responses: z.object({
      model: z.string(), instructions: z.string(), parallel_tool_calls: z.boolean(), tools: z.array(z.object({ type: z.literal("function"), strict: z.literal(false) })),
    }) }),
  }) }).parse(h.socket.events("session.start")[0]);
  assert.equal(event.session.model, "live-test");
  assert.deepEqual(event.session.audio.format, { type: "audio/pcmu", rate: 8000 });
  assert.equal(event.session.audio.output.voice, "coral");
  assert.equal(event.session.delegation.responses.model, "backend-test");
  assert.equal(event.session.delegation.responses.parallel_tool_calls, false);
  assert.match(event.session.delegation.responses.instructions, /An ordinary booking is not registration/);
  assert.ok(event.session.delegation.responses.tools.length > 10);
  assert.equal(h.requests.length, 0);
  assert.equal(h.socket.events("session.update").length, 0);
  assert.equal(h.socket.events("input_audio_buffer.append").length, 0);
});

test("input clock advances with bounded silence and preserves caller frames in order", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(t);
  const session = await h.connect();
  session.sendAudio(frame(0xff));
  t.mock.timers.tick(20);
  assert.equal(h.socket.events("session.input_audio.append")[0]?.audio, frame(0xff));
  session.sendAudio(frame(0x80));
  session.sendAudio(frame(0x82));
  t.mock.timers.tick(40);
  assert.deepEqual(h.socket.events("session.input_audio.append").slice(1).map((event) => event.audio), [frame(0x80), frame(0x82)]);
  assert.throws(() => session.sendAudio(Buffer.alloc(1).toString("base64")), { code: "unsupported_audio_frame_size" });
  for (let count = 0; count < 500; count += 1) session.sendAudio(frame(0x80));
  assert.throws(() => session.sendAudio(frame(0x80)), { code: "audio_input_backpressure" });
});

test("the opening is injected only once after readiness while microphone silence continues", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(t, { greet: true });
  await h.connect();
  t.mock.timers.tick(20);
  const greetings = h.socket.events("session.instructions.append");
  assert.equal(greetings.length, 1);
  assert.match(String(greetings[0]?.content), /Greet the caller now in English/);
  assert.ok(h.socket.events("session.input_audio.append").length > 0);
  t.mock.timers.tick(100);
  assert.equal(h.socket.events("session.instructions.append").length, 1);
});

test("Live output gaps flush mu-law remainders; caller interruption never sends preview truncation events", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(t);
  await h.connect();
  h.socket.receive({ type: "session.output_audio.delta", delta: Buffer.alloc(161, 0x80).toString("base64") });
  assert.equal(h.queue.next()?.length, 160);
  assert.equal(h.queue.next(), undefined);
  t.mock.timers.tick(200);
  assert.equal(h.queue.next()?.length, 160);
  assert.equal(h.finished.length, 1);
  h.socket.receive({ type: "session.output_audio.delta", delta: Buffer.alloc(320, 0x82).toString("base64") });
  h.user("Please wait.", 1000, 1200);
  assert.equal(h.queue.next(), undefined);
  assert.equal(h.socket.events("conversation.item.truncate").length, 0);
  assert.ok(h.socket.events("session.thinking.append").some((event) => String(event.content).includes("playback was interrupted")));
  h.socket.receive({ type: "session.output_audio.delta", delta: Buffer.alloc(160, 0x83).toString("base64") });
  assert.equal(h.queue.next()?.[0], 0x83);
});

test("timed Live caption fragments remain partial and deduplicate event IDs rather than repeated words", async (t) => {
  const h = harness(t);
  await h.connect();
  const event = { type: "session.input_transcript.delta", event_id: "caption-1", delta: "yes", start_ms: 0, end_ms: 100 };
  h.socket.receive(event);
  h.socket.receive(event);
  h.socket.receive({ ...event, event_id: "caption-2", delta: " yes", start_ms: 100, end_ms: 200 });
  const records = h.records.filter((event) => event.type === "transcript");
  assert.equal(records.length, 2);
  assert.ok(records.every((event) => event.type === "transcript" && event.partial === true && event.startMs !== undefined));
});

test("delegated functions serialize, deduplicate, and explicitly continue after completed tool collection", async (t) => {
  const response = Promise.withResolvers<Response>();
  const h = harness(t, { request: async () => response.promise });
  await h.connect();
  h.user("Tell me about the clinic.");
  h.socket.created("task", "response");
  h.socket.tool("task", "tool-1", "get_clinic", {});
  h.socket.tool("task", "tool-1", "get_clinic", {});
  h.socket.tool("task", "tool-2", "get_clinic", {});
  h.socket.done("task", "response");
  await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.socket.events("response.create").length, 0);
  response.resolve(Response.json(clinic));
  await settle();
  assert.equal(h.socket.outputs().length, 2);
  assert.equal(h.socket.events("response.create").length, 1);
  assert.deepEqual(h.failures, []);
});

test("a changed caller fragment invalidates an in-flight read and supplies current context before retry", async (t) => {
  const lookup = Promise.withResolvers<Response>();
  const h = harness(t, { request: async () => lookup.promise });
  await h.connect();
  h.user("Read the clinic.");
  h.socket.created("task", "response");
  h.socket.tool("task", "read", "get_clinic", {});
  h.socket.done("task", "response");
  await settle();
  h.user(" Actually, I meant another site.", 100, 500);
  lookup.resolve(Response.json(clinic));
  await settle();
  assert.equal(z.object({ error: z.string() }).parse(h.socket.outputs()[0]?.output).error, "stale_turn");
  assert.ok(h.socket.events("response.item.create").some((event) =>
    z.object({ type: z.literal("message"), role: z.literal("user") }).safeParse(event.item).success));
  assert.equal(h.actions.length, 0);
});

test("Azure continuations can start with in_progress without repeating response.created", async (t) => {
  const h = harness(t);
  await h.connect();
  h.user("Tell me about the clinic.");
  h.socket.created("task", "first");
  h.socket.response("task", { type: "response.in_progress", response: { id: "first", status: "in_progress" } });
  h.socket.tool("task", "clinic", "get_clinic", {});
  h.socket.done("task", "first");
  await settle();
  h.socket.response("task", { type: "response.in_progress", response: { id: "second", status: "in_progress" } });
  h.socket.tool("task", "state", "get_call_state", {});
  h.socket.done("task", "second");
  await settle();
  assert.deepEqual(h.socket.outputs().map((item) => item.callId), ["clinic", "state"]);
  assert.equal(h.socket.events("response.create").length, 2);
  h.socket.response("task", { type: "response.in_progress", response: { id: "third", status: "in_progress" } });
  h.socket.done("task", "third");
  await settle();
  assert.equal(h.socket.events("response.create").length, 2);
  assert.deepEqual(h.failures, []);
});

test("fresh confirmation requires a new Live delegation and a later explicit caller approval", { timeout: 5000 }, async (t) => {
  const h = harness(t);
  await h.connect();
  const proposal = await prepare(h);
  h.user("Yes, please book it.", 3000, 3400);
  h.socket.created("confirmation-task", "confirm");
  h.socket.tool("confirmation-task", "confirm-call", "confirm_action", { proposal_id: proposal, confirmed: true });
  h.socket.done("confirmation-task", "confirm");
  assert.equal(h.actions.length, 0);
  await delay(550);
  await settle();
  assert.deepEqual(h.actions, [{
    action: "BOOK", patient_id: "PTEST", provider_id: "PRTEST", location_id: "centro",
    appointment_type_id: "review", slot: slot.start_time, policy_id: "mapfre",
  }]);
  assert.deepEqual(h.failures, []);
});

for (const known of [true, false]) {
  test(`${known ? "the proposal's own" : "an uncorrelated"} delegation cannot authorize a fresh write`, async (t) => {
    const h = harness(t);
    await h.connect();
    const proposal = await prepare(h);
    h.user("Yes, please book it.", 3000, 3400);
    const delegation = known ? "proposal-task" : null;
    if (known) h.socket.created("proposal-task", "unsafe-confirm");
    else h.socket.response(null, { type: "response.created", response: { id: "unsafe-confirm", status: "in_progress" } });
    h.socket.tool(delegation, "confirm-call", "confirm_action", { proposal_id: proposal, confirmed: true });
    h.socket.done(delegation, "unsafe-confirm");
    await settle();
    assert.equal(h.actions.length, 0);
    assert.equal(z.object({ error: z.string() }).parse(
      h.socket.outputs().find((item) => item.callId === "confirm-call")?.output,
    ).error, "live_confirmation_requires_new_delegation");
    assert.deepEqual(h.failures, []);
  });
}

test("closing preserves one already-confirmed POST but never starts a queued tool", { timeout: 5000 }, async (t) => {
  const delivery = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const h = harness(t, { submit: async () => { started.resolve(); return delivery.promise; } });
  const session = await h.connect();
  const proposal = await prepare(h);
  h.user("Yes, please book it.", 3000, 3400);
  h.socket.created("confirmation-task", "confirm");
  h.socket.tool("confirmation-task", "confirm-call", "confirm_action", { proposal_id: proposal, confirmed: true });
  h.socket.done("confirmation-task", "confirm");
  await started.promise;
  assert.equal(h.actions.length, 1);
  assert.ok(h.records.some((event) => event.type === "action" && event.stage === "confirmed"));
  h.socket.created("queued-task", "queued");
  h.socket.tool("queued-task", "queued-call", "get_call_state", {});
  h.socket.done("queued-task", "queued");
  let closed = false;
  const closing = session.close().then(() => { closed = true; });
  await delay(20);
  assert.equal(closed, false);
  delivery.resolve(Response.json({
    call_id: "authoritative-live-call", received_at: "2026-09-18T18:00:00Z", record: { actions: h.actions },
  }));
  await closing;
  assert.ok(h.records.some((event) => event.type === "action" && event.stage === "accepted"));
  assert.ok(!h.records.some((event) => event.type === "tool" && event.name === "get_call_state"));
  assert.equal(h.actions.length, 1);
  assert.equal(h.socket.events("session.close").length, 1);
  assert.deepEqual(h.failures, []);
});

test("new words after an apparent assent prevent an irreversible Live booking", { timeout: 5000 }, async (t) => {
  const h = harness(t);
  await h.connect();
  const proposal = await prepare(h);
  h.user("Yes", 3000, 3100);
  h.socket.created("confirmation-task", "confirm");
  h.socket.tool("confirmation-task", "confirm-call", "confirm_action", { proposal_id: proposal, confirmed: true });
  h.socket.done("confirmation-task", "confirm");
  await delay(20);
  h.user(", but check outside working hours.", 3100, 3600);
  await delay(550);
  await settle();
  assert.equal(h.actions.length, 0);
  assert.equal(z.object({ error: z.string() }).parse(h.socket.outputs().find((item) => item.callId === "confirm-call")?.output).error, "stale_turn");
});

test("text injection is read-only and cannot manufacture a Live confirmation delegation", async (t) => {
  const writable = harness(t);
  const session = await writable.connect();
  assert.throws(() => session.sendText("Yes, book it."), { code: "azure_live_text_read_only" });
  const diagnostic = harness(t, { submissions: false });
  const probe = await diagnostic.connect();
  probe.sendText("Read the catalogue.");
  assert.equal(diagnostic.socket.events("response.create").length, 1);
  assert.equal(diagnostic.requests.length, 0);
});

test("incompatible startup formats fail instead of forwarding PCM as mu-law or falling back", async (t) => {
  const h = harness(t);
  await settle(); h.socket.open();
  h.socket.receive({ type: "session.started", session: {
    model: "live-test", audio: { format: { type: "audio/pcm", rate: 24000 } }, delegation: { type: "responses" },
  } });
  await assert.rejects(h.connecting, { code: "azure_live_session_mismatch" });
  assert.deepEqual(h.failures.map((error) => error.code), ["azure_live_session_mismatch"]);
});

test("managed identity is injectable and Live initialization remains separate from Realtime URLs", async (t) => {
  const h = harness(t, { token: true });
  await h.connect();
  assert.equal(h.connection()?.options.headers?.Authorization, "Bearer synthetic-managed-token");
  assert.equal(new URL(azureLiveUrl(config())).search, "");
});

test("graceful close stops input clock, is idempotent and requires session.closed for final usage", async (t) => {
  const h = harness(t);
  const session = await h.connect();
  const closing = session.close();
  assert.equal(session.close(), closing);
  await closing;
  assert.equal(h.socket.events("session.close").length, 1);
  const sent = h.socket.events("session.input_audio.append").length;
  await delay(30);
  assert.equal(h.socket.events("session.input_audio.append").length, sent);
  assert.throws(() => session.sendAudio(frame()), { code: "azure_live_not_connected" });
});

test("close without terminal usage is an explicit failure and never submits an outcome", async (t) => {
  const h = harness(t, { closeTimeoutMs: 10 });
  const session = await h.connect();
  h.socket.automaticClose = false;
  await assert.rejects(session.close(), { code: "azure_live_close_unconfirmed" });
  assert.ok(h.records.some((event) => event.type === "error" && event.code === "azure_live_close_unconfirmed"));
  assert.equal(h.actions.length, 0);
});

for (const status of ["failed", "incomplete", "cancelled"]) {
  test(`a ${status} backend response is an explicit failure without fallback or default outcome`, async (t) => {
    const h = harness(t);
    await h.connect();
    h.socket.created("task", "response");
    h.socket.response("task", { type: `response.${status}`, response: { id: "response", status } });
    await settle();
    assert.deepEqual(h.failures.map((error) => error.code), ["azure_live_backend_failed"]);
    assert.equal(h.actions.length, 0);
    assert.equal(h.socket.events("session.start").length, 1);
  });
}
