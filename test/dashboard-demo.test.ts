import assert from "node:assert/strict";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import WebSocket from "ws";
import { z } from "zod";
import type { VoiceContext, VoiceFactory } from "../src/azure-realtime.js";
import { decodeMuLaw } from "../src/call-audio.js";
import { DashboardDemoCalls, demoWebSocketPath, readOnlyDemoClinicFetch } from "../src/dashboard/demo.js";
import { DashboardService } from "../src/dashboard/service.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { decodeAudio } from "../src/protocol.js";
import { ProsperClient } from "../src/prosper.js";
import { Receptionist } from "../src/receptionist.js";
import { dashboardConfig, dashboardDirectory, dashboardFetch } from "./dashboard-fixtures.js";

const ticketSchema = z.object({
  callId: z.string().startsWith("demo-"), ticket: z.string().regex(/^[a-f0-9]{64}$/),
  websocketPath: z.literal(demoWebSocketPath), expiresAt: z.iso.datetime(),
  maxDurationSeconds: z.literal(180), submissionsAllowed: z.literal(false),
  sampleRate: z.literal(8000), frameBytes: z.literal(160), codec: z.literal("audio/x-mulaw"),
  decodeTable: z.array(z.number().int()).length(256),
});

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), "Expected demo transport event was not observed");
}

async function setup(t: TestContext, voiceFactory: VoiceFactory, now?: () => number) {
  const directory = dashboardDirectory(t);
  const config = dashboardConfig(directory);
  const upstream = dashboardFetch();
  const demo = new DashboardDemoCalls(config, { voiceFactory, ...(now ? { now } : {}) });
  const server = createDashboardServer(config, new DashboardService(config, upstream.request),
    resolve("dashboard"), { demoCalls: demo });
  const port = await server.listen();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${config.DASHBOARD_TOKEN}`, Origin: base };
  const issue = async () => {
    const response = await fetch(`${base}/api/dashboard/demo-call`, { method: "POST", headers });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return ticketSchema.parse(await response.json());
  };
  return { directory, config, upstream, demo, server, base, headers, issue };
}

async function connect(base: string, ticket: z.infer<typeof ticketSchema>, origin = base) {
  const packets: Record<string, unknown>[] = [];
  const client = new WebSocket(`${base.replace("http:", "ws:")}${demoWebSocketPath}`,
    ["maio-demo", ticket.ticket], { headers: { Origin: origin } });
  client.on("message", (raw) => packets.push(z.record(z.string(), z.unknown()).parse(JSON.parse(raw.toString()))));
  await once(client, "open");
  return { client, packets };
}

async function rejectedSocket(base: string, ticket: string, origin: string, expected: number) {
  const client = new WebSocket(`${base.replace("http:", "ws:")}${demoWebSocketPath}`,
    ["maio-demo", ticket], { headers: { Origin: origin } });
  client.on("error", () => {});
  await new Promise<void>((done, reject) => {
    client.once("open", () => { client.close(); reject(new Error("Unexpected authorized socket")); });
    client.once("unexpected-response", (_request, response) => {
      try { assert.equal(response.statusCode, expected); }
      catch (error) { response.destroy(); reject(error); return; }
      response.resume();
      client.terminate();
      done();
    });
  });
}

test("demo admission needs independent authentication, same origin and an empty body", async (t) => {
  let calls = 0;
  const h = await setup(t, async () => { calls += 1; throw new Error("No model should open"); });
  for (const [headers, expected, body] of [
    [{ Origin: h.base }, 401, undefined],
    [{ ...h.headers, Origin: "https://other.example" }, 403, undefined],
    [{ Authorization: h.headers.Authorization }, 403, undefined],
    [{ ...h.headers, "Sec-Fetch-Site": "cross-site" }, 403, undefined],
    [h.headers, 400, JSON.stringify({ allowSubmissions: true, callId: "forged-real-call" })],
  ] as const) {
    const response = await fetch(`${h.base}/api/dashboard/demo-call`, {
      method: "POST", headers, ...(body ? { body } : {}),
    });
    assert.equal(response.status, expected);
  }
  assert.equal(calls, 0);
  const ticket = await h.issue();
  assert.deepEqual(ticket.decodeTable, Array.from({ length: 256 }, (_, value) => decodeMuLaw(value)));
  assert.ok(!ticket.websocketPath.includes(ticket.ticket));
  assert.ok(!JSON.stringify(ticket).includes(h.config.DASHBOARD_TOKEN));
  assert.ok(!JSON.stringify(ticket).includes(h.config.voice.VOICE_ENDPOINT_TOKEN));
  assert.equal(calls, 0, "A ticket alone cannot invoke the model");
  const busy = await fetch(`${h.base}/api/dashboard/demo-call`, { method: "POST", headers: h.headers });
  assert.equal(busy.status, 409);
});

test("origin-bound tickets expire, cannot be replayed, and do not start inference before a successful upgrade", async (t) => {
  let now = Date.now();
  let opened = 0;
  const h = await setup(t, async () => {
    opened += 1;
    return { sendAudio() {}, sendText() {}, async close() {} };
  }, () => now);
  const expired = await h.issue();
  await rejectedSocket(h.base, expired.ticket, "https://other.example", 403);
  assert.equal(opened, 0);
  now += 30_001;
  await rejectedSocket(h.base, expired.ticket, h.base, 401);
  assert.equal(opened, 0);
  const ticket = await h.issue();
  const { client, packets } = await connect(h.base, ticket);
  await waitFor(() => packets.some((packet) => packet.event === "ready"));
  assert.equal(opened, 1);
  await rejectedSocket(h.base, ticket.ticket, h.base, 401);
  const ended = once(client, "close");
  client.send(JSON.stringify({ event: "stop" }));
  await ended;
  await waitFor(() => h.demo.status().activeCalls === 0);
  await rejectedSocket(h.base, ticket.ticket, h.base, 401);
  assert.equal(opened, 1);
});

test("concurrent ticket requests cannot create multiple reserved calls", async (t) => {
  let calls = 0;
  const h = await setup(t, async () => { calls += 1; throw new Error("No model expected"); });
  const responses = await Promise.all(Array.from({ length: 4 }, () =>
    fetch(`${h.base}/api/dashboard/demo-call`, { method: "POST", headers: h.headers })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409, 409, 409]);
  for (const response of responses) await response.arrayBuffer();
  assert.equal(calls, 0);
  assert.equal(h.demo.status().activeCalls, 1);
});

test("browser audio reuses exact frames, ordered clear and protected transcript projection without disk recordings", async (t) => {
  let context: VoiceContext | undefined;
  const inputs: Buffer[] = [];
  let closes = 0;
  const h = await setup(t, async (call) => {
    context = call;
    assert.equal(call.allowSubmissions, false);
    assert.match(call.callId, /^demo-/);
    call.onRecord?.({
      type: "transcript", speaker: "assistant", itemId: "demo-greeting", partial: true,
      text: "Hola. synthetic-prosper-key is not for the browser.",
    });
    return {
      sendAudio(payload) {
        inputs.push(decodeAudio(payload));
        call.onAudio({ audio: Buffer.alloc(640, 0xd0), itemId: "demo-output", contentIndex: 0 });
        call.onAudioDone("demo-output");
      },
      sendText() {},
      async close() { closes += 1; },
    };
  });
  const { client, packets } = await connect(h.base, await h.issue());
  await waitFor(() => packets.some((packet) => packet.event === "ready"));
  const transcript = z.object({ entry: z.object({ text: z.string(), partial: z.literal(true) }) })
    .parse(packets.find((packet) => packet.event === "transcript"));
  assert.ok(transcript.entry.text.includes("[REDACTED]"));
  assert.ok(!transcript.entry.text.includes(h.config.voice.PROSPER_API_KEY));
  client.send(JSON.stringify({ event: "media", media: { payload: Buffer.alloc(160, 0xcc).toString("base64") } }));
  await waitFor(() => packets.some((packet) => packet.event === "media"));
  assert.deepEqual(inputs, [Buffer.alloc(160, 0xcc)]);
  const output = z.object({ media: z.object({ payload: z.string() }) })
    .parse(packets.find((packet) => packet.event === "media"));
  assert.deepEqual(decodeAudio(output.media.payload), Buffer.alloc(160, 0xd0));
  const interrupted = context!.onInterrupt();
  assert.ok(interrupted?.[0] && interrupted[0].audioEndMs > 0 && interrupted[0].audioEndMs <= 80);
  await waitFor(() => packets.some((packet) => packet.event === "clear"));
  const clearIndex = packets.findIndex((packet) => packet.event === "clear");
  await delay(100);
  assert.ok(packets.slice(clearIndex + 1).every((packet) => packet.event !== "media"),
    "Old frames cannot arrive after the ordered clear");
  const ended = once(client, "close");
  client.send(JSON.stringify({ event: "stop" }));
  await ended;
  assert.equal(context!.signal.aborted, true);
  assert.equal(closes, 1);
  assert.equal(h.demo.status().activeCalls, 0);
  assert.deepEqual(readdirSync(h.directory), [], "Demo transcripts/audio must not pollute real call records");
});

test("a demo cannot forge transport identity or submissions through client packets", async (t) => {
  const ids: string[] = [];
  const h = await setup(t, async (call) => {
    ids.push(call.callId);
    return { sendAudio() {}, sendText() {}, async close() {} };
  });
  for (const packet of [
    { event: "start", start: { callSid: "real-call-forged" } },
    { event: "media", media: { payload: Buffer.alloc(160).toString("base64") }, allowSubmissions: true },
    { event: "media", media: { payload: Buffer.alloc(159).toString("base64") } },
  ]) {
    const { client, packets } = await connect(h.base, await h.issue());
    await waitFor(() => packets.some((item) => item.event === "ready"));
    const ended = once(client, "close");
    client.send(JSON.stringify(packet));
    await ended;
    assert.ok(packets.some((item) => item.event === "error"));
    await waitFor(() => h.demo.status().activeCalls === 0);
  }
  assert.equal(ids.length, 3);
  assert.ok(ids.every((id) => id.startsWith("demo-")));
  assert.equal(new Set(ids).size, 3);
});

test("faster-than-real-time audio input is bounded and releases the demo slot", async (t) => {
  let inputs = 0;
  const h = await setup(t, async () => ({
    sendAudio() { inputs += 1; }, sendText() {}, async close() {},
  }));
  const { client, packets } = await connect(h.base, await h.issue());
  await waitFor(() => packets.some((packet) => packet.event === "ready"));
  const ended = once(client, "close");
  const frame = JSON.stringify({ event: "media", media: { payload: Buffer.alloc(160, 0xff).toString("base64") } });
  for (let index = 0; index < 250; index += 1) client.send(frame);
  await ended;
  assert.ok(packets.some((packet) => packet.event === "error" && packet.code === "dashboard_demo_audio_rate_limit"));
  assert.ok(inputs < 250);
  assert.equal(h.demo.status().activeCalls, 0);
});

test("closing the browser aborts a model still connecting and later closes its returned session", async (t) => {
  let context: VoiceContext | undefined;
  let release: (() => void) | undefined;
  let closed = false;
  const h = await setup(t, async (call) => {
    context = call;
    await new Promise<void>((resolve) => { release = resolve; });
    return { sendAudio() {}, sendText() {}, async close() { closed = true; } };
  });
  const { client } = await connect(h.base, await h.issue());
  await waitFor(() => Boolean(context));
  const ended = once(client, "close");
  client.close();
  await ended;
  await waitFor(() => context!.signal.aborted);
  release!();
  await waitFor(() => closed && h.demo.status().activeCalls === 0);
});

test("readonly demo clinic transport rejects writes and run APIs before any request leaves the process", async () => {
  let requests = 0;
  const request = readOnlyDemoClinicFetch("https://clinic.example", async () => {
    requests += 1;
    return Response.json({});
  });
  await request("https://clinic.example/api/v1/clinic");
  assert.equal(requests, 1);
  for (const [url, method] of [
    ["https://clinic.example/api/v1/submit/book", "POST"],
    ["https://clinic.example/api/v1/submit/cancel", "GET"],
    ["https://clinic.example/api/v1/runs", "POST"],
    ["https://clinic.example/api/v1/runs", "GET"],
    ["https://other.example/api/v1/clinic", "GET"],
  ]) {
    await assert.rejects(request(url!, { method: method! }), { code: "dashboard_demo_write_forbidden" });
  }
  assert.equal(requests, 1);
});

test("the actual receptionist receives disabled submissions in a browser demo", async (t) => {
  let requests = 0;
  let blocked = false;
  const config = dashboardConfig("/tmp");
  const h = await setup(t, async (call) => {
    const engine = new Receptionist(new ProsperClient(config.voice, async () => {
      requests += 1;
      throw new Error("No request expected for a disabled conversational outcome");
    }), {
      callId: call.callId, startedAt: call.startedAt!, parent: call.parent, signal: call.signal,
      allowSubmissions: call.allowSubmissions === true, generation: () => 1,
      record: (event) => call.onRecord?.(event),
    });
    await assert.rejects(engine.execute("report_outcome",
      JSON.stringify({ action: "NO_ACTION", reason: "out_of_scope" }), 1), { code: "submissions_disabled" });
    blocked = true;
    return { sendAudio() {}, sendText() {}, close: () => engine.close() };
  });
  const { client, packets } = await connect(h.base, await h.issue());
  await waitFor(() => packets.some((packet) => packet.event === "ready"));
  assert.equal(blocked, true);
  assert.equal(requests, 0);
  const ended = once(client, "close");
  client.send(JSON.stringify({ event: "stop" }));
  await ended;
});
