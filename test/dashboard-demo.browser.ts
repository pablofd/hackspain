import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { chromium, type WebSocketRoute } from "playwright";
import type { VoiceContext, VoiceFactory } from "../src/azure-realtime.js";
import { decodeMuLaw } from "../src/call-audio.js";
import { DashboardDemoCalls } from "../src/dashboard/demo.js";
import { DashboardService } from "../src/dashboard/service.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { dashboardConfig, dashboardDirectory, dashboardFetch } from "./dashboard-fixtures.js";

const decodeTable = Array.from({ length: 256 }, (_, value) => decodeMuLaw(value));
const callId = "dashboard-demo-synthetic-browser";
const ticket = "synthetic_single_use_browser_ticket_123";
const feature = { enabled: true, activeCalls: 0, maxConcurrentCalls: 1, maxDurationSeconds: 180, submissionsAllowed: false } as const;

interface AudioProbe {
  tracks: MediaStreamTrack[];
  contexts: AudioContext[];
  sockets: WebSocket[];
  connections: { url: string; protocols: string[] }[];
  constraints: (MediaStreamConstraints | undefined)[];
  playback: { rate: number; length: number; energy: number }[];
  stops: number;
  workletDisconnects: number;
  denied: boolean;
  holdMicrophone: boolean;
  releaseMicrophone: (() => void) | null;
}
type ProbeWindow = typeof window & { audioProbe: AudioProbe };

async function setup(t: TestContext, options: {
  enabled?: boolean; busy?: boolean; ticketStatus?: number; ticketError?: string; holdTicket?: boolean; clock?: boolean;
  voiceFactory?: VoiceFactory;
} = {}) {
  const directory = dashboardDirectory(t);
  const settings = dashboardConfig(directory);
  const upstream = dashboardFetch({ submissions: false });
  const service = new DashboardService(settings, upstream.request);
  const demo = options.voiceFactory ? new DashboardDemoCalls(settings, { voiceFactory: options.voiceFactory }) : undefined;
  const server = createDashboardServer(settings, service, resolve("dashboard"), demo ? { demoCalls: demo } : {});
  const port = await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({
    headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  page.setDefaultTimeout(10_000);
  if (options.clock) await page.clock.install();
  const base = `http://127.0.0.1:${port}`;
  const errors: string[] = [];
  const requests: string[] = [];
  const sent: { event: string; media?: { payload: string } }[] = [];
  let tickets = 0;
  let socket: WebSocketRoute | undefined;
  let releaseTicket = () => {};
  const ticketGate = options.holdTicket ? new Promise<void>((done) => { releaseTicket = done; }) : Promise.resolve();
  t.after(releaseTicket);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    requests.push(request.url());
    if (request.method() === "POST" && request.url() === `${base}/api/dashboard/demo-call`) tickets += 1;
  });
  const instrumentAudio = () => {
    const probe: AudioProbe = {
      tracks: [], contexts: [], sockets: [], connections: [], constraints: [], playback: [],
      stops: 0, workletDisconnects: 0, denied: false, holdMicrophone: false, releaseMicrophone: null,
    };
    Object.assign(window, { audioProbe: probe });
    const microphone = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      probe.constraints.push(constraints);
      if (probe.denied) throw new DOMException("Synthetic permission denial", "NotAllowedError");
      const stream = await microphone(constraints);
      probe.tracks.push(...stream.getTracks());
      if (probe.holdMicrophone) await new Promise<void>((done) => { probe.releaseMicrophone = done; });
      return stream;
    };
    const OriginalContext = window.AudioContext;
    window.AudioContext = class extends OriginalContext {
      constructor(options?: AudioContextOptions) { super(options); probe.contexts.push(this); }
      override createBufferSource() {
        const source = super.createBufferSource();
        const start = source.start.bind(source);
        const stop = source.stop.bind(source);
        source.start = (when = 0, offset = 0, duration?: number) => {
          const buffer = source.buffer!;
          probe.playback.push({ rate: buffer.sampleRate, length: buffer.length,
            energy: buffer.getChannelData(0).reduce((sum, sample) => sum + sample * sample, 0) });
          if (duration === undefined) start(when, offset); else start(when, offset, duration);
        };
        source.stop = (when = 0) => { probe.stops += 1; stop(when); };
        return source;
      }
    };
    const OriginalWorklet = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends OriginalWorklet {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        const disconnect = this.disconnect.bind(this);
        this.disconnect = () => { probe.workletDisconnects += 1; disconnect(); };
      }
    };
  };
  // tsx preserves function names in serialized callbacks with esbuild's __name helper.
  await page.addInitScript({ content:
    `globalThis.__name = (target, name) => Object.defineProperty(target, "name", { value: name, configurable: true });\n(${instrumentAudio.toString()})();`,
  });
  if (!demo) await page.route("**/api/dashboard/demo-call", async (route) => {
    assert.equal(route.request().method(), "POST");
    assert.equal(route.request().postData(), null, "The ticket request has NO body");
    assert.equal(route.request().headers().authorization, `Bearer ${settings.DASHBOARD_TOKEN}`);
    await ticketGate;
    await route.fulfill({
      status: options.ticketStatus ?? 201, contentType: "application/json",
      body: JSON.stringify(options.ticketStatus ? { error: options.ticketError ?? "dashboard_demo_busy" } : {
        callId, ticket, websocketPath: "/api/dashboard/demo-call/ws",
        expiresAt: new Date(Date.now() + 60_000).toISOString(), maxDurationSeconds: 180,
        codec: "audio/x-mulaw", sampleRate: 8000, frameBytes: 160, decodeTable, submissionsAllowed: false,
      }),
    });
  });
  if (!demo) await page.route("**/api/dashboard/snapshot", async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    await route.fulfill({ response, json: {
      ...value, demoCall: { ...feature, enabled: options.enabled !== false, activeCalls: options.busy ? 1 : 0 },
    } });
  });
  if (!demo) await page.routeWebSocket("**/api/dashboard/demo-call/ws", (route) => {
    socket = route;
    route.onMessage((message) => {
      const value = JSON.parse(String(message)) as { event: string; media?: { payload: string } };
      assert.ok(["media", "stop"].includes(value.event), "No Twilio start, call IDs or other messages are sent");
      sent.push(value);
    });
  });
  await page.goto(base);
  await page.locator('input[name="dashboard-token"]').fill(settings.DASHBOARD_TOKEN);
  await page.getByRole("button", { name: "Conectar", exact: true }).click();
  await page.getByRole("heading", { name: "Clinica Sintetica", level: 2, exact: true }).waitFor();
  assert.deepEqual(errors, [], "Audio probes and application initialize without browser errors");
  await page.evaluate(() => {
    const probe = (window as ProbeWindow).audioProbe;
    const OriginalSocket = window.WebSocket;
    window.WebSocket = class extends OriginalSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        probe.sockets.push(this);
        probe.connections.push({ url: String(url), protocols: typeof protocols === "string" ? [protocols] : protocols ?? [] });
      }
    };
  });
  const capability = await page.evaluate(async () => {
    const path = "/src/data/api.js";
    return (await import(path)).snapshot.demoCall;
  });
  assert.equal(capability.enabled, options.enabled !== false);
  return {
    page, base, errors, requests, sent, upstream, directory, demo, tickets: () => tickets, releaseTicket,
    socket: () => { assert.ok(socket, "A local mock WebSocket was created"); return socket; },
    async start() {
      await page.getByRole("button", { name: "Llamada fake", exact: true }).click();
      await page.getByRole("button", { name: "Iniciar llamada", exact: true }).click();
    },
    async connected() {
      await page.waitForFunction(() => (window as ProbeWindow).audioProbe.sockets.length === 1);
      if (!demo) {
        assert.ok(socket);
        socket.send(JSON.stringify({ event: "ready", callId, submissionsAllowed: false, maxDurationSeconds: 180 }));
      }
      await page.getByText("En conversación · micrófono activo", { exact: true }).waitFor();
    },
    async released() {
      await page.waitForFunction(() => {
        const probe = (window as ProbeWindow).audioProbe;
        return probe.tracks.every((track) => track.readyState === "ended") &&
          probe.contexts.every((context) => context.state === "closed") &&
          probe.sockets.every((ws) => ws.readyState === WebSocket.CLOSED);
      });
    },
  };
}

test("the actual authenticated 201 ticket and native WebSocket bridge accept early greetings and microphone audio without Azure", { timeout: 20_000 }, async (t) => {
  let context: VoiceContext | undefined;
  let opened = 0;
  let closed = 0;
  const frames: Buffer[] = [];
  const app = await setup(t, { voiceFactory: async (call) => {
    context = call;
    opened += 1;
    assert.equal(call.allowSubmissions, false);
    call.onRecord?.({ type: "transcript", speaker: "assistant", itemId: "native-greeting", partial: true,
      text: "Saludo sintético. synthetic-prosper-key" });
    call.onAudio({ audio: Buffer.alloc(6400, 0xd0), itemId: "native-greeting", contentIndex: 0 });
    await delay(80);
    return {
      sendAudio(payload) {
        frames.push(Buffer.from(payload, "base64"));
        if (frames.length === 1) call.onRecord?.({
          type: "transcript", speaker: "user", itemId: "native-mic", text: "Micrófono sintético recibido.",
        });
      },
      sendText() {},
      async close() { closed += 1; },
    };
  } });
  assert.equal(opened, 0);
  const packets: string[] = [];
  const outbound: { event: string; ready: boolean }[] = [];
  app.page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      const value = JSON.parse(String(payload)) as { event: string };
      packets.push(value.event);
    });
    socket.on("framesent", ({ payload }) => {
      const value = JSON.parse(String(payload)) as { event: string };
      outbound.push({ event: value.event, ready: packets.includes("ready") });
    });
  });
  const admitted = app.page.waitForResponse((response) =>
    response.url() === `${app.base}/api/dashboard/demo-call` && response.request().method() === "POST");
  await app.start();
  const response = await admitted;
  assert.equal(response.status(), 201);
  assert.equal(response.headers()["cache-control"], "no-store");
  assert.match(response.headers()["permissions-policy"] ?? "", /microphone=\(self\)/);
  const transcript = app.page.getByRole("region", { name: "Transcripción de la llamada fake", exact: true });
  await app.page.waitForFunction(() => {
    const text = document.querySelector(".demo-call__status")?.textContent ?? "";
    return text.includes("En conversación") || text.includes("se ha detenido");
  });
  assert.equal(await app.page.locator(".demo-call__status").textContent(), "En conversación · micrófono activo");
  await transcript.getByText("Saludo sintético. [REDACTED]", { exact: true }).waitFor();
  await transcript.getByText("Micrófono sintético recibido.", { exact: true }).waitFor();
  await app.page.waitForFunction(() => (window as ProbeWindow).audioProbe.playback.length > 0);
  assert.ok(packets.indexOf("transcript") >= 0 && packets.indexOf("transcript") < packets.indexOf("ready"),
    "The real bridge can forward a generated greeting while the provider is still starting");
  assert.ok(packets.indexOf("media") >= 0 && packets.indexOf("media") < packets.indexOf("ready"),
    "Greeting playback can precede microphone readiness");
  assert.equal(opened, 1);
  assert.ok(frames.length > 0 && frames.every((frame) => frame.length === 160));
  assert.ok(context);
  context.onInterrupt();
  await app.page.waitForFunction(() => (window as ProbeWindow).audioProbe.stops > 0);
  assert.ok(packets.includes("clear"), "Opt-in native bridge clear reaches the browser");
  await app.page.getByRole("button", { name: "Colgar", exact: true }).click();
  await app.released();
  await delay(30);
  assert.equal(closed, 1);
  assert.equal(context.signal.aborted, true);
  assert.equal(app.demo?.status().activeCalls, 0);
  assert.deepEqual(readdirSync(app.directory), []);
  assert.equal(app.tickets(), 1);
  assert.ok(outbound.every((packet) => packet.event === "stop" || (packet.event === "media" && packet.ready)),
    "Mic frames remain gated until ready on the native WebSocket");
  assert.ok(app.requests.every((url) => url.startsWith(app.base) && !/[?&](token|ticket)=/.test(url)));
  assert.ok(app.upstream.requests.every(({ method }) => method === "GET"));
  assert.deepEqual(app.errors, []);
});

test("fake-call capture uses real AudioWorklet 160-byte frames only after ready, and playback/clear/hangup clean up", { timeout: 35_000 }, async (t) => {
  const app = await setup(t);
  const { page } = app;
  assert.equal(app.tickets(), 0);
  assert.equal(await page.evaluate(() => (window as ProbeWindow).audioProbe.constraints.length), 0);
  await page.getByRole("button", { name: "Llamada fake", exact: true }).click();
  await page.getByText(/Consume Azure de pago/).waitFor();
  assert.equal(app.tickets(), 0, "Opening the dialog does not open a paid session or microphone");
  await page.getByRole("button", { name: "Iniciar llamada", exact: true }).click();
  await page.waitForFunction(() => (window as ProbeWindow).audioProbe.sockets.length === 1);
  await page.waitForTimeout(150);
  assert.equal(app.sent.length, 0, "No mic frames before the server is ready");
  assert.equal(app.tickets(), 1);
  await app.connected();
  await page.waitForTimeout(420);
  const media = app.sent.filter((message) => message.event === "media");
  assert.ok(media.length >= 8 && media.length <= 32, `20 ms capture cadence, got ${media.length} frames in ~420 ms`);
  assert.ok(media.every((message) => Buffer.from(message.media!.payload, "base64").length === 160));
  const probe = await page.evaluate(() => ({
    constraints: (window as ProbeWindow).audioProbe.constraints,
    rate: (window as ProbeWindow).audioProbe.contexts[0]!.sampleRate,
    connections: (window as ProbeWindow).audioProbe.connections,
  }));
  assert.equal(probe.constraints[0]?.video, false);
  assert.deepEqual(probe.constraints[0]?.audio, { echoCancellation: true, noiseSuppression: true, channelCount: 1 });
  assert.ok(probe.rate >= 8000);
  assert.deepEqual(probe.connections, [{
    url: app.base.replace("http:", "ws:") + "/api/dashboard/demo-call/ws", protocols: ["maio-demo", ticket],
  }]);
  const payload = Buffer.alloc(160, 0x90).toString("base64");
  for (let index = 0; index < 12; index += 1) app.socket().send(JSON.stringify({ event: "media", media: { payload } }));
  await page.waitForFunction(() => (window as ProbeWindow).audioProbe.playback.length === 12);
  assert.ok(await page.evaluate(() => (window as ProbeWindow).audioProbe.playback.every((item) =>
    item.rate === 8000 && item.length === 160 && item.energy > 0)));
  app.socket().send(JSON.stringify({ event: "clear" }));
  await page.waitForFunction(() => (window as ProbeWindow).audioProbe.stops > 0);
  const entry = { speaker: "assistant", itemId: "demo-item", timestamp: new Date().toISOString(),
    text: "<b>Texto sintético, no HTML</b>", partial: true };
  app.socket().send(JSON.stringify({ event: "transcript", entry }));
  const transcript = page.getByRole("region", { name: "Transcripción de la llamada fake", exact: true });
  await transcript.getByText(entry.text, { exact: true }).waitFor();
  assert.equal(await transcript.locator("b").count(), 0);
  app.socket().send(JSON.stringify({ event: "transcript", entry: { ...entry, text: "Fragmento actualizado.", partial: false } }));
  await transcript.getByText("Fragmento actualizado.", { exact: true }).waitFor();
  assert.equal(await transcript.locator(".chat__row").count(), 1, "A partial update does not duplicate the same recorded item");
  for (let index = 0; index < 25; index += 1) app.socket().send(JSON.stringify({ event: "transcript", entry: {
    speaker: index % 2 ? "user" : "assistant", itemId: `fake-scroll-${index}`,
    text: `Texto de prueba de voz ${index}.`, timestamp: new Date(Date.now() + index).toISOString(),
  } }));
  await transcript.getByText("Texto de prueba de voz 24.", { exact: true }).waitFor();
  const chat = transcript.locator(".chat");
  assert.ok(await chat.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop) <= 2);
  await chat.evaluate((node) => { node.scrollTop = 500; });
  app.socket().send(JSON.stringify({ event: "transcript", entry: {
    speaker: "user", itemId: "fake-scroll-last", text: "Nuevo texto sin mover al lector.", timestamp: new Date().toISOString(),
  } }));
  await transcript.getByText("Nuevo texto sin mover al lector.", { exact: true }).waitFor();
  assert.ok(Math.abs(await chat.evaluate((node) => node.scrollTop) - 500) <= 2, "Fake calls share the same non-jumping transcript behavior");
  assert.equal(await page.getByRole("button", { name: "Iniciar llamada", exact: true }).isDisabled(), true);
  app.socket().send(JSON.stringify({ event: "tool", name: "get_clinic", status: "ok" }));
  await page.getByText("get_clinic · ok · sin envíos a Prosper", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Colgar", exact: true }).click();
  await app.released();
  assert.ok(await page.evaluate(() => (window as ProbeWindow).audioProbe.workletDisconnects >= 1));
  assert.ok(app.sent.some((message) => message.event === "stop"));
  const count = app.sent.length;
  await page.waitForTimeout(100);
  assert.equal(app.sent.length, count, "No audio resumes after cleanup");
  assert.ok(app.requests.every((url) => url.startsWith(app.base) && !url.includes(ticket) && !/[?&](token|ticket)=/.test(url)));
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.ok(app.upstream.requests.every(({ method }) => method === "GET"));
  assert.deepEqual(app.errors, []);
});

test("codec, streaming resampler and playback budgets are validated with the backend decode table", { timeout: 30_000 }, async (t) => {
  const { page, errors } = await setup(t, { enabled: false });
  const result = await page.evaluate(async (table) => {
    const codecPath = "/src/lib/voice-codec.js";
    const playbackPath = "/src/lib/voice-playback.js";
    const { createMuLawCodec, StreamingDownsampler } = await import(codecPath);
    const { voicePlayback } = await import(playbackPath);
    const codec = createMuLawCodec(table);
    const silence = codec.encode(new Float32Array(160));
    const maximumError = Math.max(...table.map((sample) => {
      const encoded = codec.encode(new Float32Array([sample / 32768]))[0];
      const decoded = table[encoded];
      if (decoded === undefined) throw new Error("Invalid encoded sample");
      return Math.abs(decoded - sample);
    }));
    const checks = [8000, 44100, 48000].map((rate) => {
      const sine = (frequency: number) => Float32Array.from({ length: rate }, (_, index) => 0.6 * Math.sin(2 * Math.PI * frequency * index / rate));
      const render = (data: Float32Array, chunk: number) => {
        const resampler = new StreamingDownsampler(rate);
        const result: number[] = [];
        for (let index = 0; index < data.length; index += chunk) result.push(...resampler.process(data.subarray(index, index + chunk)));
        return result;
      };
      const a = render(sine(1000), 128);
      const b = render(sine(1000), 257);
      const rms = (data: number[]) => Math.sqrt(data.slice(512).reduce((sum, value) => sum + value * value, 0) / (data.length - 512));
      return { rate, count: a.length, chunkError: Math.max(...a.map((sample, index) => Math.abs(sample - b[index]!))),
        rms: rms(a), highRms: rate > 8000 ? rms(render(sine(6000), 128)) : 0 };
    });
    let stopped = 0;
    const scheduled: number[] = [];
    const context = {
      currentTime: 0, state: "running", destination: {},
      createBuffer: (_channels: number, length: number, rate: number) => ({ duration: length / rate, copyToChannel() {} }),
      createBufferSource: () => ({ buffer: null, onended: null, connect() {}, disconnect() {},
        start(time: number) { scheduled.push(time); }, stop() { stopped += 1; } }),
    };
    const player = voicePlayback(context, codec);
    let backpressure = "";
    try { for (let index = 0; index < 120; index += 1) player.push(silence); }
    catch (error) { backpressure = error instanceof Error ? error.message : ""; }
    player.clear();
    player.push(silence);
    return { silence: [...silence], maximumError, checks, backpressure, stopped, scheduled };
  }, decodeTable);
  assert.ok(result.silence.every((value) => value === 0xff));
  assert.equal(result.maximumError, 0);
  for (const check of result.checks) {
    assert.equal(check.count, 8000, `One second at ${check.rate} Hz becomes exactly 8000 samples`);
    assert.ok(check.chunkError < 0.000001);
    assert.ok(check.rms > 0.42 && check.rms < 0.43);
    assert.ok(check.highRms < 0.005, "Anti-alias filtering rejects frequencies above the 8kHz Nyquist limit");
  }
  assert.equal(result.backpressure, "dashboard_demo_playback_backpressure");
  assert.ok(result.stopped > 0 && result.stopped <= 100);
  assert.equal(result.scheduled.at(-1), 0.015, "Clear discards both current and queued playback time");
  assert.deepEqual(errors, []);
});

test("permission denial, disabled capability and busy or unauthorized admissions never open a voice socket", { timeout: 45_000 }, async (t) => {
  const disabled = await setup(t, { enabled: false });
  assert.equal(await disabled.page.getByRole("button", { name: "Llamada fake", exact: true }).isVisible(), false);
  assert.equal(disabled.tickets(), 0);
  const busy = await setup(t, { busy: true });
  assert.equal(await busy.page.getByRole("button", { name: "Llamada fake", exact: true }).isDisabled(), true);
  assert.equal(busy.tickets(), 0);
  const denied = await setup(t);
  await denied.page.evaluate(() => { (window as ProbeWindow).audioProbe.denied = true; });
  await denied.start();
  await denied.page.getByText(/Permiso de micrófono denegado/).waitFor();
  await denied.released();
  assert.equal(denied.tickets(), 0);
  for (const [status, code, text] of [
    [409, "dashboard_demo_busy", /Ya hay una llamada de prueba activa/],
    [401, "dashboard_unauthorized", /La sesión no está autorizada/],
  ] as const) {
    const rejected = await setup(t, { ticketStatus: status, ticketError: code });
    await rejected.start();
    await rejected.page.getByText(text).waitFor();
    await rejected.released();
    assert.equal(rejected.tickets(), 1);
    assert.equal(await rejected.page.evaluate(() => (window as ProbeWindow).audioProbe.sockets.length), 0);
    assert.deepEqual(rejected.errors, []);
  }
});

test("late microphone permission and late tickets cannot create a socket after logout", { timeout: 35_000 }, async (t) => {
  const delayed = await setup(t);
  await delayed.page.evaluate(() => { (window as ProbeWindow).audioProbe.holdMicrophone = true; });
  await delayed.start();
  await delayed.page.waitForFunction(() => (window as ProbeWindow).audioProbe.releaseMicrophone !== null);
  await delayed.page.getByRole("button", { name: "Cerrar llamada fake", exact: true }).click();
  await delayed.page.getByRole("button", { name: "Desconectar", exact: true }).click();
  await delayed.page.evaluate(() => (window as ProbeWindow).audioProbe.releaseMicrophone?.());
  await delayed.released();
  assert.equal(delayed.tickets(), 0);
  assert.equal(await delayed.page.evaluate(() => (window as ProbeWindow).audioProbe.sockets.length), 0);
  const ticketPending = await setup(t, { holdTicket: true });
  await ticketPending.start();
  await ticketPending.page.getByText("Preparando la conexión de voz…", { exact: true }).waitFor();
  await ticketPending.page.getByRole("button", { name: "Cerrar llamada fake", exact: true }).click();
  await ticketPending.page.getByRole("button", { name: "Desconectar", exact: true }).click();
  ticketPending.releaseTicket();
  await ticketPending.released();
  assert.equal(await ticketPending.page.evaluate(() => (window as ProbeWindow).audioProbe.sockets.length), 0);
  await ticketPending.page.getByRole("button", { name: "Conectar", exact: true }).waitFor();
  assert.deepEqual(delayed.errors, []);
  assert.deepEqual(ticketPending.errors, []);
});

test("backpressure, server termination, navigation and the three-minute cap release microphone and playback", { timeout: 45_000 }, async (t) => {
  const overloaded = await setup(t);
  await overloaded.start();
  await overloaded.connected();
  await overloaded.page.evaluate(() => {
    Object.defineProperty((window as ProbeWindow).audioProbe.sockets[0], "bufferedAmount", { value: 32768 });
  });
  await overloaded.page.getByText(/La conexión no puede enviar el audio a tiempo/).waitFor();
  await overloaded.released();
  const ended = await setup(t);
  await ended.start();
  await ended.connected();
  ended.socket().send(JSON.stringify({ event: "ended", reason: "synthetic_complete" }));
  await ended.page.getByText("Llamada finalizada · synthetic_complete", { exact: true }).waitFor();
  await ended.released();
  const navigated = await setup(t);
  await navigated.start();
  await navigated.connected();
  await navigated.page.evaluate(() => { location.hash = "#/clientes"; });
  await navigated.page.getByText("Sin paciente seleccionado", { exact: true }).waitFor();
  await navigated.released();
  const capped = await setup(t, { clock: true });
  await capped.start();
  await capped.connected();
  await capped.page.clock.fastForward(180_001);
  await capped.page.getByText("Límite de 3 minutos alcanzado.", { exact: true }).waitFor();
  await capped.released();
  for (const app of [overloaded, ended, navigated, capped]) {
    assert.equal(app.tickets(), 1);
    assert.deepEqual(app.errors, []);
  }
});

test("an expired dashboard session closes an active microphone call and cannot reopen it", { timeout: 20_000 }, async (t) => {
  const app = await setup(t, { clock: true });
  await app.start();
  await app.connected();
  await app.page.route("**/api/dashboard/snapshot", (route) => route.fulfill({
    status: 401, contentType: "application/json", body: JSON.stringify({ error: "dashboard_unauthorized" }),
  }));
  await app.page.clock.fastForward(5000);
  await app.page.getByRole("button", { name: "Conectar", exact: true }).waitFor();
  await app.released();
  assert.equal(await app.page.getByRole("dialog", { name: "Llamada fake", exact: true }).count(), 0);
  assert.equal(app.tickets(), 1);
  assert.deepEqual(app.errors, []);
});

test("unsupported audio, server errors and broken sockets are explicit failures without automatic retries", { timeout: 30_000 }, async (t) => {
  const unsupported = await setup(t);
  await unsupported.page.evaluate(() => { Reflect.deleteProperty(window, "AudioWorkletNode"); });
  await unsupported.start();
  await unsupported.page.getByText(/Este navegador necesita HTTPS/).waitFor();
  assert.equal(unsupported.tickets(), 0);
  const failed = await setup(t);
  await failed.start();
  await failed.connected();
  failed.socket().send(JSON.stringify({ event: "error", code: "synthetic_provider_error" }));
  await failed.page.getByText("La llamada se ha detenido: synthetic_provider_error", { exact: true }).waitFor();
  await failed.released();
  const disconnected = await setup(t);
  await disconnected.start();
  await disconnected.connected();
  disconnected.socket().close({ code: 1011, reason: "Synthetic connection failure" });
  await disconnected.page.getByText(/dashboard_demo_connection_closed/).waitFor();
  await disconnected.released();
  assert.equal(failed.tickets(), 1);
  assert.equal(disconnected.tickets(), 1);
  assert.deepEqual(unsupported.errors, []);
  assert.deepEqual(failed.errors, []);
  assert.deepEqual(disconnected.errors, []);
});
