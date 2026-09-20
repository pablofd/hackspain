import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { chromium } from "playwright";
import { DashboardService } from "../src/dashboard/service.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { dashboardConfig, dashboardDirectory, dashboardFetch, writeDashboardRecord } from "./dashboard-fixtures.js";

const capability = { enabled: true, model: "synthetic-text-estimator", minRefreshSeconds: 30, estimated: true };
const quote = '<img src=x onerror="window.signalsAttack=true"> Quiero una cita sintética.';
const alpha = "signals-alpha";
const beta = "signals-beta";

function ready(callId: string) {
  return {
    callId, status: "ready", source: "azure_text_estimate", model: capability.model,
    analyzedAt: new Date().toISOString(), stale: false, nextRefreshAt: null as string | null,
    coverage: { entries: 3, characters: 150, limited: false },
    analysis: {
      tone: "mixed",
      indicators: {
        calmness: { score: 62.5, evidence: ["q1"] },
        satisfaction: { score: null, evidence: [] },
        confusion: { score: 0, evidence: ["q2"] },
      },
      intents: [
        { kind: "book", confidence: "high", evidence: ["q1"] },
        { kind: "clinic_information", confidence: "medium", evidence: ["q2"] },
        { kind: "privacy_request", confidence: "low", evidence: ["q2"] },
      ],
      patterns: [
        { kind: "correction", evidence: ["q2"] }, { kind: "language_switch", evidence: ["q2"] },
      ],
    },
    evidence: [
      { id: "q1", speaker: "user", text: callId === alpha ? quote : "Texto sintético de BETA.", timestamp: new Date().toISOString() },
      { id: "q2", speaker: "user", text: "Rectifico: demà al matí, si us plau.", timestamp: new Date().toISOString() },
    ],
  };
}

interface SignalProbe {
  hold: string;
  pending: { callId: string; signal: AbortSignal | null | undefined; release: () => void }[];
  released: number;
}
type SignalWindow = typeof window & { signalProbe: SignalProbe };
type Reply = { status?: number; body: unknown };

async function setup(t: TestContext, initialCapability: typeof capability | null = capability) {
  const directory = dashboardDirectory(t);
  const now = Date.now();
  writeDashboardRecord(directory, alpha, {
    started: new Date(now - 20_000), ended: false,
    transcripts: Array.from({ length: 40 }, (_, index) => ({
      speaker: index % 2 ? "assistant" : "user", itemId: `alpha-${index}`,
      text: index === 0 ? quote : `Fragmento sintético ${index}: ${"texto para leer sin saltos. ".repeat(4)}`,
    })),
  });
  writeDashboardRecord(directory, beta, {
    started: new Date(now - 60_000), accepted: false,
    transcripts: [{ speaker: "user", itemId: "beta-text", text: "Texto sintético de BETA." }],
  });
  const settings = dashboardConfig(directory);
  const upstream = dashboardFetch({ submissions: false });
  const server = createDashboardServer(settings, new DashboardService(settings, upstream.request), resolve("dashboard"));
  const port = await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    for (const context of browser.contexts()) for (const openPage of context.pages()) {
      const logout = openPage.getByRole("button", { name: "Desconectar", exact: true });
      if (await logout.count()) await logout.click();
      await openPage.unrouteAll({ behavior: "wait" });
    }
    await browser.close();
    await server.close();
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  page.setDefaultTimeout(10_000);
  await page.clock.install();
  const base = `http://127.0.0.1:${port}`;
  const errors: string[] = [];
  const urls: string[] = [];
  const requests: { callId: string; time: number }[] = [];
  let currentCapability = initialCapability;
  let respond: (id: string, count: number) => Reply = (id) => ({ body: ready(id) });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => urls.push(request.url()));
  await page.addInitScript(() => {
    const control: SignalProbe = { hold: "", pending: [], released: 0 };
    Object.assign(window, { signalProbe: control });
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const path = new URL(input instanceof Request ? input.url : String(input), location.origin).pathname;
      const match = /^\/api\/dashboard\/calls\/([^/]+)\/signals$/.exec(path);
      if (match?.[1] === control.hold) {
        const body = await response.text();
        await new Promise<void>((release) => {
          control.pending.push({ callId: control.hold, signal: init?.signal, release });
        });
        control.released += 1;
        return new Response(body, { status: response.status, headers: response.headers });
      }
      return response;
    };
  });
  await page.route("**/api/dashboard/snapshot", async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    if (currentCapability) value.signalAnalysis = currentCapability;
    else delete value.signalAnalysis;
    await route.fulfill({ response, json: value });
  });
  await page.route(/\/api\/dashboard\/calls\/[^/]+\/signals$/, async (route) => {
    const callId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);
    assert.equal(route.request().method(), "POST");
    assert.equal(route.request().postData(), null);
    assert.equal(route.request().headers().authorization, `Bearer ${settings.DASHBOARD_TOKEN}`);
    requests.push({ callId, time: await page.evaluate(() => Date.now()) });
    const reply = respond(callId, requests.length);
    await route.fulfill({ status: reply.status ?? 200, contentType: "application/json", body: JSON.stringify(reply.body) });
  });
  await page.goto(`${base}/#/llamadas`);
  const login = async () => {
    await page.locator('input[name="dashboard-token"]').fill(settings.DASHBOARD_TOKEN);
    await page.getByRole("button", { name: "Conectar", exact: true }).click();
    await page.getByRole("button", { name: "Señales", exact: true }).waitFor();
  };
  await login();
  const panel = page.getByRole("region", { name: "Señales textuales de la llamada", exact: true });
  return {
    page, panel, requests, errors, urls, base, upstream, login,
    setReply(next: typeof respond) { respond = next; },
    setCapability(next: typeof currentCapability) { currentCapability = next; },
    open: () => page.getByRole("button", { name: "Señales", exact: true }).click(),
    hold: (id: string) => page.evaluate((value) => { (window as SignalWindow).signalProbe.hold = value; }, id),
    pending: () => page.waitForFunction(() => (window as SignalWindow).signalProbe.pending.length === 1),
    aborted: () => page.evaluate(() => (window as SignalWindow).signalProbe.pending[0]?.signal?.aborted),
    async release(count: number) {
      await page.evaluate(() => (window as SignalWindow).signalProbe.pending.shift()?.release());
      await page.waitForFunction((value) => (window as SignalWindow).signalProbe.released === value, count);
    },
  };
}

test("real signals only analyze on explicit opening and display validated textual estimates, nulls and escaped caller evidence", { timeout: 30_000 }, async (t) => {
  const app = await setup(t);
  const { page, panel } = app;
  await page.clock.fastForward(35_000);
  assert.equal(app.requests.length, 0, "Snapshots and page load do not analyze any calls");
  await page.getByRole("button", { name: "Ver analítica", exact: true }).click();
  await page.getByText("MOS / jitter / pérdida", { exact: true }).waitFor();
  assert.equal(app.requests.length, 0);
  await app.open();
  await panel.getByRole("heading", { name: "Tono lingüístico estimado: Mixto", exact: true }).waitFor();
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0]?.callId, alpha);
  assert.match(await panel.innerText(), /Azure con coste separado/);
  assert.match(await panel.innerText(), /no son probabilidades calibradas/);
  const satisfaction = panel.getByRole("region", { name: "Satisfacción expresada", exact: true });
  await satisfaction.getByText("Desconocido", { exact: true }).waitFor();
  assert.equal(await satisfaction.locator(".bar").count(), 0, "An accepted BOOK never supplies a missing satisfaction score");
  await panel.getByText("62,5 /100", { exact: true }).waitFor();
  await panel.getByText("0 /100", { exact: true }).waitFor();
  for (const level of ["Alta", "Media", "Baja"]) await panel.getByText(`Confianza: ${level}`, { exact: true }).waitFor();
  await panel.getByText("Corrección", { exact: true }).waitFor();
  await panel.getByText("Cambio de idioma", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Texto 1", exact: true }).first().click();
  await panel.getByText(quote, { exact: true }).waitFor();
  assert.equal(await panel.locator("img, script").count(), 0);
  assert.equal(await page.evaluate(() => "signalsAttack" in window), false);
  assert.doesNotMatch(await panel.innerText(), /%|MOS\s+[0-9]|NPS\s+[0-9]/);
  const transcript = page.locator(".calls__panel .chat");
  const handle = await transcript.elementHandle();
  assert.ok(handle);
  await transcript.evaluate((node) => { node.scrollTop = 350; });
  await page.clock.fastForward(20_000);
  assert.equal(app.requests.length, 1);
  const refreshed = page.waitForResponse((response) => response.url().endsWith(`/${alpha}/signals`));
  await page.clock.fastForward(10_000);
  await refreshed;
  await panel.getByText("Último análisis recibido · conservado en esta vista.", { exact: true }).waitFor();
  assert.equal(app.requests.length, 2);
  assert.ok(app.requests[1]!.time - app.requests[0]!.time >= 30_000);
  assert.equal(await handle.evaluate((node) => node === document.querySelector(".calls__panel .chat")), true);
  assert.ok(Math.abs(await transcript.evaluate((node) => node.scrollTop) - 350) <= 2);
  await app.open();
  await page.clock.fastForward(90_000);
  assert.equal(app.requests.length, 2, "A closed panel stops paid refreshes");
  assert.ok(app.urls.every((url) => url.startsWith(app.base) && !/[?&]token=/.test(url)));
  assert.ok(app.upstream.requests.every(({ method }) => method === "GET"));
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(app.errors, []);
});

test("missing or disabled capability and visual-demo signals never POST; enabling a visible panel still requires an explicit action", { timeout: 30_000 }, async (t) => {
  const app = await setup(t, null);
  await app.open();
  await app.panel.getByText("Análisis textual no configurado.", { exact: true }).waitFor();
  await app.page.clock.fastForward(60_000);
  assert.equal(app.requests.length, 0);
  app.setCapability({ ...capability, enabled: false });
  await app.page.clock.fastForward(5000);
  assert.equal(app.requests.length, 0);
  app.setCapability(capability);
  await app.page.clock.fastForward(5000);
  await app.panel.getByRole("button", { name: "Analizar esta llamada", exact: true }).waitFor();
  assert.equal(app.requests.length, 0);
  await app.panel.getByRole("button", { name: "Analizar esta llamada", exact: true }).click();
  await app.panel.getByRole("heading", { name: "Tono lingüístico estimado: Mixto", exact: true }).waitFor();
  await app.page.getByRole("button", { name: "Demo visual", exact: true }).click();
  await app.open();
  await app.page.getByRole("heading", { name: "Estado emocional", exact: true }).waitFor();
  await app.page.clock.fastForward(90_000);
  assert.equal(app.requests.length, 1, "The separate visual-demo panel never analyzes its synthetic rows");
  await app.page.getByRole("button", { name: "Datos reales", exact: true }).click();
  assert.equal(await app.panel.count(), 0);
  assert.equal(app.requests.length, 1);
  assert.deepEqual(app.errors, []);
});

test("reopening uses cached results, stale/limited coverage stays visible, and backend nextRefreshAt gates refresh", { timeout: 25_000 }, async (t) => {
  const app = await setup(t);
  const nextRefresh = await app.page.evaluate(() => Date.now() + 70_000);
  app.setReply((id, count) => count === 1 ? { body: {
    ...ready(id), stale: true, nextRefreshAt: new Date(nextRefresh).toISOString(),
    coverage: { entries: 3, characters: 150, limited: true },
  } } : { body: {
    ...ready(id), status: "insufficient_data", analyzedAt: null, analysis: null, evidence: [],
    coverage: { entries: 0, characters: 0, limited: false },
  } });
  await app.open();
  await app.panel.getByText("Resultado marcado como desactualizado por el servidor.", { exact: true }).waitFor();
  assert.match(await app.panel.locator(".signals-source").innerText(), /Fuente: Azure.*synthetic-text-estimator.*3 fragmentos \/ 150 caracteres.*Muestra limitada/);
  assert.match(await app.panel.locator(".signals-timing").innerText(), /Siguiente consulta posible/);
  await app.page.clock.fastForward(20_000);
  await app.open();
  await app.page.clock.fastForward(10_000);
  await app.open();
  assert.equal(app.requests.length, 1);
  await app.page.clock.fastForward(30_000);
  assert.equal(app.requests.length, 1, "Backend cooldown can be longer than the local 30-second minimum");
  const response = app.page.waitForResponse((value) => value.url().endsWith(`/${alpha}/signals`));
  await app.page.clock.fastForward(10_000);
  await response;
  await app.panel.getByText("Texto insuficiente para estimar señales. No hay un análisis disponible.", { exact: true }).waitFor();
  assert.equal(app.requests.length, 2);
  assert.equal(await app.panel.locator(".textual-indicator").count(), 0);
  assert.match(await app.panel.locator(".signals-source").innerText(), /fecha no disponible.*0 fragmentos \/ 0 caracteres/);
  assert.deepEqual(app.errors, []);
});

test("busy, cooldown and source failures remain explicit and never auto-retry; manual retries respect the minimum interval", { timeout: 25_000 }, async (t) => {
  const app = await setup(t);
  app.setReply((id, count) => count < 4 ? {
    status: count === 3 ? 503 : 429,
    body: { error: ["signals_busy", "signals_cooldown", "signals_unavailable"][count - 1] },
  } : { body: ready(id) });
  await app.open();
  await app.panel.getByText(/signals_busy/).waitFor();
  for (const [expected, wait] of [["signals_cooldown", 90_000], ["signals_unavailable", 30_000], ["ready", 90_000]] as const) {
    const before = app.requests.length;
    await app.page.clock.fastForward(wait);
    assert.equal(app.requests.length, before, "Errors do not turn into a paid retry loop");
    await app.panel.getByRole("button", { name: "Reintentar análisis", exact: true }).click();
    if (expected === "ready") await app.panel.getByRole("heading", { name: "Tono lingüístico estimado: Mixto", exact: true }).waitFor();
    else {
      await app.panel.getByText(new RegExp(expected)).waitFor();
      assert.equal(await app.panel.getByRole("button", { name: "Reintentar análisis", exact: true }).isDisabled(), true);
    }
  }
  assert.equal(app.requests.length, 4);
  assert.ok(app.requests.every((request, index) => index === 0 || request.time - app.requests[index - 1]!.time >= 30_000));
  assert.deepEqual(app.errors, []);
});

test("unauthorized, missing transcripts and invalid evidence or scores cannot become successful estimates", { timeout: 35_000 }, async (t) => {
  const app = await setup(t);
  app.setReply((id, count) => {
    const data = ready(id);
    if (count === 1) return { status: 401, body: { error: "dashboard_unauthorized" } };
    if (count === 2) return { status: 404, body: { error: "dashboard_transcript_not_found" } };
    if (count === 3) return { body: { ...data, evidence: data.evidence.map((item) => ({ ...item, speaker: "assistant" })) } };
    if (count === 4) return { body: { ...data, analysis: {
      ...data.analysis, indicators: { ...data.analysis.indicators, calmness: { score: 101, evidence: ["q1"] } },
    } } };
    return { body: { ...data, analysis: { ...data.analysis, patterns: [{ kind: "thanks", evidence: ["unknown-reference"] }] } } };
  });
  await app.open();
  for (const [index, error] of ["dashboard_unauthorized", "dashboard_transcript_not_found", "signals_invalid_response",
    "signals_invalid_response", "signals_invalid_response"].entries()) {
    await app.panel.getByText(new RegExp(error)).waitFor();
    assert.equal(await app.panel.locator(".textual-indicator, blockquote").count(), 0);
    assert.equal(app.requests.length, index + 1);
    await app.page.clock.fastForward(60_000);
    assert.equal(app.requests.length, index + 1);
    if (index < 4) await app.panel.getByRole("button", { name: "Reintentar análisis", exact: true }).click();
  }
  assert.deepEqual(app.errors, []);
});

test("selection changes abort old analysis and require explicit authorization for the newly selected real call", { timeout: 25_000 }, async (t) => {
  const app = await setup(t);
  await app.hold(alpha);
  await app.open();
  await app.pending();
  await app.page.getByRole("button", { name: "Sin recibo", exact: true }).click();
  assert.equal(await app.aborted(), true);
  assert.equal(app.requests.length, 1, "Changing selection is not consent to analyze another call");
  await app.hold("");
  await app.panel.getByRole("button", { name: "Analizar esta llamada", exact: true }).click();
  await app.panel.getByRole("heading", { name: "Tono lingüístico estimado: Mixto", exact: true }).waitFor();
  await app.panel.getByRole("button", { name: "Texto 1", exact: true }).first().click();
  await app.panel.getByText("Texto sintético de BETA.", { exact: true }).waitFor();
  await app.release(1);
  assert.doesNotMatch(await app.panel.innerText(), /Quiero una cita sintética/);
  assert.deepEqual(app.requests.map((item) => item.callId), [alpha, beta]);
  assert.deepEqual(app.errors, []);
});

test("panel/mode disposal cancels requests and delayed responses cannot replace demo panels or restart analysis", { timeout: 25_000 }, async (t) => {
  const app = await setup(t);
  await app.hold(alpha);
  await app.open();
  await app.pending();
  await app.page.getByRole("button", { name: "Ver analítica", exact: true }).click();
  assert.equal(await app.aborted(), true);
  await app.release(1);
  await app.page.clock.fastForward(60_000);
  assert.equal(app.requests.length, 1);
  await app.open();
  await app.panel.getByRole("button", { name: "Reintentar análisis", exact: true }).click();
  await app.pending();
  await app.page.getByRole("button", { name: "Demo visual", exact: true }).click();
  assert.equal(await app.aborted(), true);
  await app.release(2);
  await app.open();
  await app.page.getByRole("heading", { name: "Estado emocional", exact: true }).waitFor();
  assert.equal(await app.panel.count(), 0);
  await app.page.clock.fastForward(90_000);
  assert.equal(app.requests.length, 2);
  assert.deepEqual(app.errors, []);
});

test("logout clears signals, aborts network waits and prevents late analysis from resurfacing after reconnect", { timeout: 25_000 }, async (t) => {
  const app = await setup(t);
  await app.hold(alpha);
  await app.open();
  await app.pending();
  await app.page.getByRole("button", { name: "Desconectar", exact: true }).click();
  await app.page.getByRole("button", { name: "Conectar", exact: true }).waitFor();
  assert.equal(await app.aborted(), true);
  await app.hold("");
  await app.login();
  await app.release(1);
  assert.equal(await app.panel.count(), 0);
  await app.page.clock.fastForward(90_000);
  assert.equal(app.requests.length, 1);
  assert.doesNotMatch(await app.page.locator("#content").innerText(), /Tono lingüístico estimado|62,5 \/100/);
  assert.deepEqual(app.errors, []);
});
