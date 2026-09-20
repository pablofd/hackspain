import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer as createStaticServer } from "node:http";
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
  assert.equal(await page.getByRole("region", { name: "Transcripción de la llamada", exact: true, includeHidden: true }).isVisible(), false);
  await page.getByRole("button", { name: "Ver mapa", exact: true }).click();
  await page.getByText("Ninguna llamada con este filtro.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Todas", exact: true }).click();
  await page.locator(".map__node").first().click();
  await page.getByRole("button", { name: "Ver más en Clientes", exact: true }).click();
  await page.getByRole("heading", { name: "Ada Sintetica Prueba", exact: true }).waitFor();
  assert.match(page.url(), /#\/clientes\/PATIENT_TEST$/);
  await page.getByRole("link", { name: "Configuración", exact: true }).click();
  await page.getByRole("button", { name: "Instrucciones", exact: true }).click();
  await page.getByRole("textbox", { name: "Prompt real de Azure" }).waitFor();
  assert.match(await page.getByRole("textbox", { name: "Prompt real de Azure" }).inputValue(), /Clinica Arenal/);
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
  await page.locator(".source-status > summary").click();
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
  await transcript.locator(".transcript-partial:not([hidden])").waitFor();
  await transcript.getByText("Sobre este texto", { exact: true }).click();
  assert.match(await transcript.innerText(), /no tiempos acústicos exactos/);
  assert.match(await transcript.innerText(), /no demuestra lo que se oyó/);
  await transcript.getByText("Detalle del fragmento", { exact: true }).nth(1).click();
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
  await transcript.getByText(/^Registro local no encontrado\./).waitFor();
  writeFileSync(path, "PRIVATE_BROKEN_TRANSCRIPT_SOURCE\n", { mode: 0o600 });
  await page.clock.fastForward(5000);
  await transcript.getByText(/^Error al leer la transcripción:/).waitFor();
  assert.match(await transcript.innerText(), /dashboard_invalid_record/);
  assert.doesNotMatch(await transcript.innerText(), /PRIVATE_BROKEN_TRANSCRIPT_SOURCE|Sin transcripción registrada|Registro local no encontrado/);
  assert.equal(await transcript.locator(".transcript__text").count(), 0);
  assert.deepEqual(errors, []);
});

test("transcript polling preserves its container and reading anchor, and follows only an existing bottom reader", { timeout: 45_000 }, async (t) => {
  const directory = dashboardDirectory(t);
  const fixture = writeDashboardRecord(directory, "dashboard-test-call", {
    ended: false,
    transcripts: Array.from({ length: 510 }, (_, index) => ({
      speaker: index % 2 ? "user" : "assistant", itemId: `scroll-${index}`, partial: index === 12,
      text: `Fragmento ${index}: texto sintético para comprobar la lectura estable.`,
    })),
  });
  let content = fixture.text;
  const settings = dashboardConfig(directory);
  const server = createDashboardServer(settings, new DashboardService(settings, dashboardFetch().request), resolve("dashboard"));
  const port = await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  await page.clock.install();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/#/llamadas`);
  await page.locator('input[name="dashboard-token"]').fill(settings.DASHBOARD_TOKEN);
  await page.getByRole("button", { name: "Conectar", exact: true }).click();
  const region = page.getByRole("region", { name: "Transcripción de la llamada", exact: true });
  const scroller = region.locator(".chat");
  await region.getByText("Fragmento 509: texto sintético para comprobar la lectura estable.", { exact: true }).waitFor();
  const handle = await scroller.elementHandle();
  assert.ok(handle);
  const distance = () => scroller.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
  assert.ok(await distance() <= 2);
  const append = (index: number) => {
    content += `${JSON.stringify(fixture.record("transcript", {
      speaker: "user", itemId: `scroll-${index}`, text: `Nuevo fragmento ${index}.`,
    }, Date.now() - fixture.started.getTime() + index))}\n`;
    writeFileSync(fixture.path, content, { mode: 0o600 });
  };
  append(510);
  await page.clock.fastForward(5000);
  await region.getByText("Nuevo fragmento 510.", { exact: true }).waitFor();
  assert.ok(await distance() <= 2, "An existing bottom reader follows appended text");
  assert.equal(await handle.evaluate((node) => node === document.querySelector(".calls__panel .chat")), true);
  await scroller.evaluate((node) => { node.scrollTop = 3000; });
  const anchor = await scroller.evaluate((node) => {
    const top = node.getBoundingClientRect().top;
    const row = [...node.querySelectorAll("article")].find((item) => item.getBoundingClientRect().bottom > top)!;
    return { text: row.querySelector(".transcript__text")!.textContent!, offset: row.getBoundingClientRect().top - top };
  });
  const anchorOffset = () => region.locator("article").filter({ has: page.getByText(anchor.text, { exact: true }) })
    .evaluate((row) => row.getBoundingClientRect().top - row.closest(".chat")!.getBoundingClientRect().top);
  append(511);
  await page.clock.fastForward(5000);
  await region.getByText("Nuevo fragmento 511.", { exact: true }).waitFor();
  assert.ok(Math.abs(await anchorOffset() - anchor.offset) <= 2, "Dropping old bounded entries preserves a surviving reading anchor");
  assert.ok(await distance() > 100);
  content = content.replace("Fragmento 12: texto sintético para comprobar la lectura estable.",
    `Fragmento 12: ${"Ampliación parcial de ejemplo. ".repeat(45)}`);
  writeFileSync(fixture.path, content, { mode: 0o600 });
  await page.clock.fastForward(5000);
  await region.getByText(/^Fragmento 12: Ampliación parcial/).waitFor();
  assert.ok(Math.abs(await anchorOffset() - anchor.offset) <= 2, "Partial text growing above the reader does not move the reading anchor");
  await page.getByRole("button", { name: "Ver analítica", exact: true }).click();
  await page.getByText("G.711 mu-law · 8 kHz · mono", { exact: true }).waitFor();
  assert.equal(await handle.evaluate((node) => node === document.querySelector(".calls__panel .chat")), true);
  const beforeError = await scroller.evaluate((node) => node.scrollTop);
  writeFileSync(fixture.path, "SYNTHETIC_INVALID_RECORD\n", { mode: 0o600 });
  await page.clock.fastForward(5000);
  await region.getByText(/^Error al leer la transcripción:/).waitFor();
  assert.ok(Math.abs(await scroller.evaluate((node) => node.scrollTop) - beforeError) <= 2);
  assert.match(await region.innerText(), /última lectura, sin actualizar/);
  assert.equal(await handle.evaluate((node) => node === document.querySelector(".calls__panel .chat")), true);
  assert.deepEqual(errors, []);
});

test("visual demo restores chart and chat hierarchy without replacing real state or calling patient/transcript APIs", { timeout: 30_000 }, async (t) => {
  const directory = dashboardDirectory(t);
  writeDashboardRecord(directory);
  const settings = dashboardConfig(directory);
  const upstream = dashboardFetch();
  const server = createDashboardServer(settings, new DashboardService(settings, upstream.request), resolve("dashboard"));
  const port = await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  const base = `http://127.0.0.1:${port}`;
  await page.goto(base);
  await page.locator('input[name="dashboard-token"]').fill(settings.DASHBOARD_TOKEN);
  await page.getByRole("button", { name: "Conectar", exact: true }).click();
  await page.getByRole("heading", { name: "Clinica Sintetica", exact: true, level: 2 }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Llamada en directo", exact: true }).isVisible(), false);
  await page.getByRole("button", { name: "Demo visual", exact: true }).click();
  await page.getByRole("heading", { name: "Bienvenido a maio", exact: true }).waitFor();
  assert.match(await page.locator(".connection-banner").innerText(), /simulados/);
  assert.match(await page.locator(".sidebar__footer").innerText(), /Clinica Sintetica|Agente real/);
  assert.equal(await page.locator(".hero + .row + .grid--3").count(), 1, "Original hero → range → six KPI hierarchy");
  assert.ok(await page.locator(".chart").count() >= 3);
  assert.ok(await page.locator(".stat__spark").count() >= 4);
  await page.getByRole("link", { name: "Llamadas", exact: true }).click();
  await page.locator(".chat__row--agent .chat__avatar--agent").first().waitFor();
  await page.getByRole("button", { name: "Señales", exact: true }).click();
  await page.getByRole("heading", { name: "Estado emocional", exact: true }).waitFor();
  assert.match(await page.locator(".signals").innerText(), /demo visual, no inferencia/);
  await page.getByRole("button", { name: "Ver mapa", exact: true }).click();
  await page.locator(".map__node").first().click();
  await page.getByRole("button", { name: "Ver más en Clientes", exact: true }).click();
  await page.getByText("Demo visual · paciente simulado", { exact: true }).waitFor();
  assert.equal(requests.some((url) => /\/api\/dashboard\/(patients|calls)\b/.test(url)), false);
  await page.getByRole("button", { name: "Datos reales", exact: true }).click();
  await page.getByText("Sin paciente seleccionado", { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator("#content").innerText(), /Lucía Demo|paciente simulado|Agenda simulada/);
  assert.ok(requests.every((url) => url.startsWith(base)));
  assert.deepEqual(errors, []);
});

test("platform reference and product share brand, typography and primary layout geometry", { timeout: 35_000 }, async (t) => {
  const assets = new Map<string, string>();
  const reference = createStaticServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://reference.local").pathname;
    const file = path === "/" ? "index.html" : path.slice(1);
    if (request.method !== "GET" || (file !== "index.html" && !/^(src|design)\/[A-Za-z0-9_/-]+\.(js|css|svg|json)$/.test(file))) {
      response.writeHead(404).end();
      return;
    }
    let body = assets.get(file);
    if (body === undefined) {
      try {
        body = execFileSync("git", ["show", `b5cdcfa:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        response.writeHead(404).end();
        return;
      }
      assets.set(file, body);
    }
    const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" :
      file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".json") ? "application/json" : "text/html";
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }).end(body);
  });
  await new Promise<void>((done) => reference.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done, reject) => reference.close((error) => error ? reject(error) : done())));
  const address = reference.address();
  assert.ok(address && typeof address !== "string");
  const referenceBase = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${referenceBase}/.env.local`)).status, 404);
  const directory = dashboardDirectory(t);
  const settings = dashboardConfig(directory);
  const server = createDashboardServer(settings, new DashboardService(settings, dashboardFetch().request), resolve("dashboard"));
  const port = await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const original = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: "reduce" });
  await original.route("**/*", (route) => new URL(route.request().url()).origin === referenceBase ? route.continue() : route.abort());
  await original.goto(referenceBase);
  await original.getByRole("heading", { name: "Bienvenido a maio, Vicente", exact: true }).waitFor();
  const current = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: "reduce" });
  const base = `http://127.0.0.1:${port}`;
  const requests: string[] = [];
  current.on("request", (request) => requests.push(request.url()));
  await current.goto(base);
  await current.locator('input[name="dashboard-token"]').fill(settings.DASHBOARD_TOKEN);
  await current.getByRole("button", { name: "Conectar", exact: true }).click();
  await current.getByRole("button", { name: "Demo visual", exact: true }).click();
  await current.getByRole("heading", { name: "Bienvenido a maio", exact: true }).waitFor();
  for (const selector of [".sidebar", ".brand__name", ".hero", ".hero__title", ".stat"]) {
    const before = await original.locator(selector).first().evaluate((node) => ({
      width: node.getBoundingClientRect().width, left: node.getBoundingClientRect().left,
      font: getComputedStyle(node).fontFamily, weight: getComputedStyle(node).fontWeight,
      radius: getComputedStyle(node).borderRadius,
    }));
    const after = await current.locator(selector).first().evaluate((node) => ({
      width: node.getBoundingClientRect().width, left: node.getBoundingClientRect().left,
      font: getComputedStyle(node).fontFamily, weight: getComputedStyle(node).fontWeight,
      radius: getComputedStyle(node).borderRadius,
    }));
    assert.equal(after.font, before.font, `${selector}: original font stack`);
    assert.equal(after.weight, before.weight, `${selector}: original weight`);
    assert.equal(after.radius, before.radius, `${selector}: original corner treatment`);
    if (selector !== ".hero__title" && selector !== ".brand__name") {
      assert.ok(Math.abs(after.width - before.width) <= 2, `${selector}: original width`);
      assert.ok(Math.abs(after.left - before.left) <= 2, `${selector}: original horizontal alignment`);
    }
  }
  if (process.env.DASHBOARD_VISUAL_CAPTURE === "1") {
    mkdirSync("dashboard/.local/visual-captures", { recursive: true, mode: 0o700 });
    await original.screenshot({ path: "dashboard/.local/visual-captures/platform-home.png" });
    await current.screenshot({ path: "dashboard/.local/visual-captures/product-home.png" });
  }
  await original.locator('.nav__item[href="#/llamadas"]').click();
  await current.getByRole("link", { name: "Llamadas", exact: true }).click();
  await original.locator(".chat-card").waitFor();
  await current.locator(".chat-card").waitFor();
  assert.equal(await current.locator(".chat__avatar--agent").count() > 0, true);
  assert.equal(await current.locator(".waveform").isVisible(), true);
  if (process.env.DASHBOARD_VISUAL_CAPTURE === "1") {
    await original.screenshot({ path: "dashboard/.local/visual-captures/platform-calls.png" });
    await current.screenshot({ path: "dashboard/.local/visual-captures/product-calls.png" });
  }
  await current.setViewportSize({ width: 390, height: 844 });
  assert.ok(await current.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "Presentation controls and call layout do not overflow a narrow viewport");
  assert.ok(requests.every((url) => url.startsWith(base)), "No external avatars, fonts or analytics");
});

test("real mode has no success banner while snapshot errors and compact demo provenance remain visible", { timeout: 25_000 }, async (t) => {
  const directory = dashboardDirectory(t);
  const settings = dashboardConfig(directory);
  const server = createDashboardServer(settings, new DashboardService(settings, dashboardFetch().request), resolve("dashboard"));
  const port = await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  await page.clock.install();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let fail = false;
  await page.route("**/api/dashboard/snapshot", (route) => fail
    ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"synthetic_snapshot_unavailable"}' })
    : route.continue());
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('input[name="dashboard-token"]').fill(settings.DASHBOARD_TOKEN);
  await page.getByRole("button", { name: "Conectar", exact: true }).click();
  await page.getByRole("heading", { name: "Clinica Sintetica", level: 2, exact: true }).waitFor();
  const banner = page.locator(".connection-banner");
  assert.equal(await banner.isVisible(), false);
  assert.equal(await banner.textContent(), "");
  assert.doesNotMatch(await page.locator("body").innerText(), /Datos reales · muestra observada/);
  fail = true;
  const failed = page.waitForResponse((response) => response.url().endsWith("/api/dashboard/snapshot") && response.status() === 503);
  await page.clock.fastForward(5000);
  await failed;
  await banner.getByText(/Sin actualizar: synthetic_snapshot_unavailable/).waitFor();
  assert.match(await banner.innerText(), /datos anteriores no representan el estado en directo/);
  await page.getByRole("button", { name: "Demo visual", exact: true }).click();
  assert.match(await banner.innerText(), /Demo visual · datos simulados · Sin actualizar/);
  await page.getByRole("button", { name: "Datos reales", exact: true }).click();
  assert.match(await banner.innerText(), /^Sin actualizar:/, "Changing presentation does not clear a stale-connection warning");
  fail = false;
  const recovered = page.waitForResponse((response) => response.url().endsWith("/api/dashboard/snapshot") && response.status() === 200);
  await page.clock.fastForward(5000);
  await recovered;
  await page.waitForFunction(() => document.querySelector(".connection-banner")?.hasAttribute("hidden"));
  assert.equal(await banner.textContent(), "");
  await page.getByRole("button", { name: "Demo visual", exact: true }).click();
  assert.equal(await banner.innerText(), "Demo visual · datos simulados");
  await page.getByRole("button", { name: "Datos reales", exact: true }).click();
  assert.equal(await banner.isVisible(), false);
  assert.deepEqual(errors, []);
});
