import assert from "node:assert/strict";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { DashboardService } from "../src/dashboard/service.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { dashboardConfig, dashboardDirectory, dashboardFetch, writeDashboardRecord } from "./dashboard-fixtures.js";

test("the original dashboard runs end-to-end with read-only sources, empty states and live metadata updates", { timeout: 60_000 }, async (t) => {
  const directory = dashboardDirectory(t);
  writeDashboardRecord(directory, "dashboard-test-call", { transcripts: [
    { speaker: "user", itemId: "browser-user", text: "Necesito una cita de prueba." },
  ] });
  const settings = dashboardConfig(directory);
  const upstream = dashboardFetch();
  const server = createDashboardServer(settings, new DashboardService(settings, upstream.request), resolve("dashboard"));
  const port = await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  const base = `http://127.0.0.1:${port}`;
  await page.goto(base);
  assert.equal(await page.getByRole("heading", { name: "Clinica Sintetica" }).count(), 0);
  await page.locator('input[name="dashboard-token"]').fill(settings.DASHBOARD_TOKEN);
  await page.getByRole("button", { name: "Conectar", exact: true }).click();
  await page.getByRole("heading", { name: "Clinica Sintetica", exact: true, level: 2 }).waitFor();
  assert.doesNotMatch(await page.locator("body").innerText(), /Vera Salud|Vicente|NaN|undefined/);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await page.getByRole("link", { name: "Clientes", exact: true }).click();
  await page.getByText("Sin paciente seleccionado", { exact: true }).waitFor();
  await page.getByRole("searchbox", { name: "Nombre o teléfono del paciente" }).fill("Ada");
  await page.getByRole("button", { name: "Buscar", exact: true }).click();
  await page.getByRole("heading", { name: "Ada Sintetica Prueba", exact: true }).waitFor();
  await page.getByText("Profesional de prueba · Sede de prueba", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Nuevo paciente", exact: true }).isDisabled(), true);
  assert.doesNotMatch(await page.locator("body").innerText(), /00000000T|PRIVATE_|1980-06-15/);
  await page.getByRole("link", { name: "Llamadas", exact: true }).click();
  await page.getByRole("region", { name: "Transcripción de la llamada" }).getByText("Necesito una cita de prueba.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Ver analítica", exact: true }).click();
  await page.getByText("G.711 mu-law · 8 kHz · mono", { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator("body").innerText(), /Opus 48k|PRIVATE_|MOS [0-9]|NaN/);
  await page.getByRole("button", { name: "Señales", exact: true }).click();
  await page.getByText("Sentimiento e intenciones: no disponibles", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Registros abiertos", exact: true }).click();
  await page.getByText("Sin registros observados con este filtro.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("region", { name: "Transcripción de la llamada" }).count(), 0);
  await page.getByRole("button", { name: "Ver mapa", exact: true }).click();
  await page.getByText("Ninguna llamada con este filtro.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Todas", exact: true }).click();
  await page.locator(".map__node").first().click();
  await page.getByRole("button", { name: "Ver más en Clientes", exact: true }).click();
  await page.getByRole("heading", { name: "Ada Sintetica Prueba", exact: true }).waitFor();
  assert.match(page.url(), /#\/clientes\/PATIENT_TEST$/);
  await page.getByRole("link", { name: "Configuración", exact: true }).click();
  await page.getByRole("button", { name: "Instrucciones", exact: true }).click();
  await page.getByText("Gestionadas en el backend", { exact: true }).waitFor();
  assert.equal(await page.locator("textarea").count(), 0);
  await page.getByRole("button", { name: "Cumplimiento", exact: true }).click();
  await page.getByText("Metadatos y transcripción autenticada de la llamada seleccionada; sin archivos NDJSON ni WAV", { exact: true }).waitFor();
  await page.getByRole("link", { name: "Llamadas", exact: true }).click();
  writeDashboardRecord(directory, "new-open-test", { ended: false, accepted: false });
  await page.getByText("Llamada new-open-test", { exact: true }).waitFor({ timeout: 12_000 });
  assert.ok(upstream.requests.every((request) => request.method === "GET"));
  assert.ok(requests.every((url) => url.startsWith(base)), "No patient-linked avatars, fonts or third-party requests");
  assert.deepEqual(errors, []);
  await page.getByRole("button", { name: "Desconectar", exact: true }).click();
  await page.getByRole("button", { name: "Conectar", exact: true }).waitFor();
  assert.doesNotMatch(await page.locator("body").innerText(), /Ada Sintetica|new-open-test/);
});

test("source outages and zero calls render unavailable states rather than demo values", { timeout: 30_000 }, async (t) => {
  const directory = dashboardDirectory(t);
  const settings = dashboardConfig(directory);
  const server = createDashboardServer(settings,
    new DashboardService(settings, dashboardFetch({ fail: true }).request), resolve("dashboard"));
  const port = await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('input[name="dashboard-token"]').fill(settings.DASHBOARD_TOKEN);
  await page.getByRole("button", { name: "Conectar", exact: true }).click();
  await page.getByRole("heading", { name: "Fuentes de datos", exact: true }).waitFor();
  assert.match(await page.locator("body").innerText(), /prosper_http_503/);
  assert.doesNotMatch(await page.locator("body").innerText(), /NaN|undefined|PRIVATE_UPSTREAM_FAILURE|342|965/);
  await page.getByRole("link", { name: "Llamadas", exact: true }).click();
  await page.getByRole("button", { name: "Ver mapa", exact: true }).click();
  await page.getByText("Ninguna llamada con este filtro.", { exact: true }).waitFor();
  await page.getByRole("link", { name: "Clientes", exact: true }).click();
  await page.getByText("Sin paciente seleccionado", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test("selected transcripts load, render literal text and partial labels, and refresh with the five-second poll", { timeout: 30_000 }, async (t) => {
  const directory = dashboardDirectory(t);
  const literal = '<img src=x onerror="window.transcriptAttack=true">\n  Necesito una cita de prueba, prueba.';
  const { path, record, started } = writeDashboardRecord(directory, "transcript-visible", {
    ended: false, accepted: false,
    transcripts: [
      { speaker: "user", itemId: "visible-user", text: literal },
      { speaker: "assistant", itemId: "visible-agent", text: " Texto generado de prueba. ", partial: true, startMs: 50, endMs: 150 },
    ],
  });
  writeDashboardRecord(directory, "unselected-transcript", {
    started: new Date(started.getTime() - 1000), transcripts: [
      { speaker: "user", itemId: "unselected-item", text: "Texto de otra llamada, no solicitado." },
    ],
  });
  const settings = dashboardConfig(directory);
  const upstream = dashboardFetch({ submissions: false });
  const server = createDashboardServer(settings, new DashboardService(settings, upstream.request), resolve("dashboard"));
  const port = await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.clock.install();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  let release = () => {};
  const loading = new Promise<void>((done) => { release = done; });
  t.after(() => release());
  const pattern = "**/api/dashboard/calls/transcript-visible/transcript";
  await page.route(pattern, async (route) => { await loading; await route.continue(); });
  const base = `http://127.0.0.1:${port}`;
  await page.goto(base);
  await page.locator('input[name="dashboard-token"]').fill(settings.DASHBOARD_TOKEN);
  await page.getByRole("button", { name: "Conectar", exact: true }).click();
  await page.getByRole("heading", { name: "Clinica Sintetica", exact: true, level: 2 }).waitFor();
  assert.equal(requests.some((url) => url.endsWith("/transcript")), false);
  await page.getByRole("link", { name: "Llamadas", exact: true }).click();
  const transcript = page.getByRole("region", { name: "Transcripción de la llamada" });
  await transcript.getByText("Cargando transcripción…", { exact: true }).waitFor();
  release();
  await transcript.getByRole("article", { name: "Interlocutor", exact: true }).waitFor();
  await page.unroute(pattern);
  assert.equal(await transcript.locator(".transcript__text").first().textContent(), literal);
  assert.equal(await transcript.locator(".transcript__text").nth(1).textContent(), " Texto generado de prueba. ");
  assert.equal(await transcript.locator("img, script").count(), 0);
  assert.equal(await page.evaluate(() => "transcriptAttack" in window), false);
  await transcript.getByRole("article", { name: "Agente · texto generado", exact: true }).waitFor();
  await transcript.getByText("Fragmento parcial · puede estar incompleto o interrumpido", { exact: true }).waitFor();
  assert.match(await transcript.innerText(), /no tiempos acústicos exactos/);
  assert.match(await transcript.innerText(), /no demuestra lo que se oyó/);
  assert.match(await transcript.innerText(), /Intervalo del modelo: 50–150 ms/);
  assert.equal(await transcript.locator("time").first().getAttribute("datetime"),
    new Date(started.getTime() + 1000).toISOString());
  assert.equal(requests.some((url) => url.includes("/calls/unselected-transcript/transcript")), false);
  appendFileSync(path, `${JSON.stringify(record("transcript", {
    speaker: "user", itemId: "visible-follow-up", text: "Ahora prefiero la tarde, por favor.",
  }, Date.now() - started.getTime()))}\n`);
  await page.clock.fastForward(5000);
  await transcript.getByText("Ahora prefiero la tarde, por favor.", { exact: true }).waitFor();
  assert.equal(await transcript.locator(".transcript__text").count(), 3);
  assert.ok(requests.filter((url) => url.endsWith("/calls/transcript-visible/transcript")).length >= 2);
  const anonymous = await page.request.get(`${base}/api/dashboard/calls/transcript-visible/transcript`);
  assert.equal(anonymous.status(), 401, "The browser has no persistent cookie or token granting API access");
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.ok(requests.every((url) => url.startsWith(base)));
  assert.ok(upstream.requests.every(({ method }) => method === "GET"));
  assert.deepEqual(errors, []);
});

interface TranscriptGate {
  hold: string;
  pending: { id: string; signal: AbortSignal | null | undefined; resume: () => void }[];
  returned: number;
}
type GateWindow = typeof window & { transcriptTest: TranscriptGate };

test("late transcript responses cannot repaint another selection, a disposed view or a reconnected session", { timeout: 45_000 }, async (t) => {
  const directory = dashboardDirectory(t);
  const first = writeDashboardRecord(directory, "race-a", {
    started: new Date(Date.now() - 10_000), ended: false, transcripts: [
      { speaker: "user", itemId: "race-a-item", text: "Texto sintético de A." },
    ],
  });
  const second = writeDashboardRecord(directory, "race-b", {
    started: new Date(Date.now() - 20_000), ended: false, transcripts: [
      { speaker: "user", itemId: "race-b-item", text: "Texto sintético de B." },
    ],
  });
  const settings = dashboardConfig(directory);
  const server = createDashboardServer(settings,
    new DashboardService(settings, dashboardFetch({ submissions: false }).request), resolve("dashboard"));
  const port = await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.clock.install();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const control: TranscriptGate = { hold: "race-a", pending: [], returned: 0 };
    Object.assign(window, { transcriptTest: control });
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = input instanceof Request ? input.url : String(input);
      const match = /\/api\/dashboard\/calls\/([^/]+)\/transcript$/.exec(url);
      if (match?.[1] === control.hold) {
        const body = await response.text();
        // Delay an already read body: cancellation alone cannot suppress this result.
        await new Promise<void>((resume) => control.pending.push({ id: control.hold, signal: init?.signal, resume }));
        control.returned += 1;
        return new Response(body, { status: response.status, headers: response.headers });
      }
      return response;
    };
  });
  const pending = () => page.waitForFunction(() => (window as GateWindow).transcriptTest.pending.length === 1);
  const aborted = () => page.evaluate(() => (window as GateWindow).transcriptTest.pending[0]?.signal?.aborted);
  const release = async (returned: number) => {
    await page.evaluate(() => (window as GateWindow).transcriptTest.pending.shift()?.resume());
    await page.waitForFunction((count) => (window as GateWindow).transcriptTest.returned === count, returned);
  };
  const hold = (id: string) => page.evaluate((value) => { (window as GateWindow).transcriptTest.hold = value; }, id);
  const select = (id: string) => page.locator("tbody tr").filter({ hasText: `Llamada ${id}` }).click();
  const transcript = page.getByRole("region", { name: "Transcripción de la llamada" });
  await page.goto(`http://127.0.0.1:${port}/#/llamadas`);
  await page.locator('input[name="dashboard-token"]').fill(settings.DASHBOARD_TOKEN);
  await page.getByRole("button", { name: "Conectar", exact: true }).click();
  await pending();
  await transcript.getByText("Cargando transcripción…", { exact: true }).waitFor();
  await select("race-b");
  await transcript.getByText("Texto sintético de B.", { exact: true }).waitFor();
  assert.equal(await aborted(), true);
  await hold("");
  await release(1);
  assert.doesNotMatch(await transcript.innerText(), /Texto sintético de A/);
  await hold("race-b");
  await page.clock.fastForward(5000);
  await pending();
  appendFileSync(second.path, `${JSON.stringify(second.record("transcript", {
    speaker: "user", itemId: "race-b-latest", text: "Actualización más reciente de B.",
  }, Date.now() - second.started.getTime()))}\n`);
  await select("race-a");
  await transcript.getByText("Texto sintético de A.", { exact: true }).waitFor();
  assert.equal(await aborted(), true);
  await hold("");
  await select("race-b");
  await transcript.getByText("Actualización más reciente de B.", { exact: true }).waitFor();
  await release(2);
  await transcript.getByText("Actualización más reciente de B.", { exact: true }).waitFor();
  assert.doesNotMatch(await transcript.innerText(), /Texto sintético de A/);
  await hold("race-b");
  await page.clock.fastForward(5000);
  await pending();
  await page.getByRole("link", { name: "Clientes", exact: true }).click();
  await page.getByText("Sin paciente seleccionado", { exact: true }).waitFor();
  assert.equal(await aborted(), true);
  await release(3);
  assert.doesNotMatch(await page.locator("body").innerText(), /Texto sintético de [AB]|Actualización más reciente/);
  await hold("race-a");
  await page.getByRole("link", { name: "Llamadas", exact: true }).click();
  await pending();
  await page.getByRole("button", { name: "Desconectar", exact: true }).click();
  await page.getByRole("button", { name: "Conectar", exact: true }).waitFor();
  assert.equal(await aborted(), true);
  assert.equal(await page.getByRole("region", { name: "Transcripción de la llamada" }).count(), 0);
  appendFileSync(first.path, `${JSON.stringify(first.record("transcript", {
    speaker: "user", itemId: "race-a-new-session", text: "Texto de la nueva conexión.",
  }, Date.now() - first.started.getTime()))}\n`);
  await hold("");
  await page.locator('input[name="dashboard-token"]').fill(settings.DASHBOARD_TOKEN);
  await page.getByRole("button", { name: "Conectar", exact: true }).click();
  await transcript.getByText("Texto de la nueva conexión.", { exact: true }).waitFor();
  await release(4);
  await transcript.getByText("Texto de la nueva conexión.", { exact: true }).waitFor();
  assert.doesNotMatch(await transcript.innerText(), /Texto sintético de B/);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(errors, []);
});

test("missing text, missing records and source failures remain distinct transcript states", { timeout: 30_000 }, async (t) => {
  const directory = dashboardDirectory(t);
  const { path } = writeDashboardRecord(directory, "dashboard-test-call", { transcripts: [] });
  const settings = dashboardConfig(directory);
  const server = createDashboardServer(settings, new DashboardService(settings, dashboardFetch().request), resolve("dashboard"));
  const port = await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.clock.install();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/#/llamadas`);
  await page.locator('input[name="dashboard-token"]').fill(settings.DASHBOARD_TOKEN);
  await page.getByRole("button", { name: "Conectar", exact: true }).click();
  const transcript = page.getByRole("region", { name: "Transcripción de la llamada" });
  await transcript.getByText("Sin transcripción registrada", { exact: true }).waitFor();
  rmSync(path);
  await page.clock.fastForward(5000);
  await transcript.getByText("Registro local no encontrado", { exact: true }).waitFor();
  writeFileSync(path, "PRIVATE_BROKEN_TRANSCRIPT_SOURCE\n", { mode: 0o600 });
  await page.clock.fastForward(5000);
  await transcript.getByText("Error al leer la transcripción", { exact: true }).waitFor();
  assert.match(await transcript.innerText(), /dashboard_invalid_record/);
  assert.doesNotMatch(await transcript.innerText(), /PRIVATE_BROKEN_TRANSCRIPT_SOURCE|Sin transcripción registrada|Registro local no encontrado/);
  assert.equal(await transcript.locator(".transcript__text").count(), 0);
  assert.deepEqual(errors, []);
});
