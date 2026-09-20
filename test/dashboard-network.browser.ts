import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { chromium } from "playwright";
import { DashboardService } from "../src/dashboard/service.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { dashboardConfig, dashboardDirectory, dashboardFetch } from "./dashboard-fixtures.js";

function sampleCalls() {
  const now = new Date().toISOString();
  return Array.from({ length: 30 }, (_, index) => ({
    id: `technical-call-${index}`, personKey: `person-${index}`,
    patientIds: [`person-${index}`], caller: `Persona Ejemplo ${index + 1}`,
    phone: "No consultado", booked: true, missed: false, outcome: "resolved",
    simulated: false, reason: "Reserva comunicada", time: "Hoy", duration: "1m 20s",
    startedAt: now, endReason: "prosper_stop", receiptSource: "prosper", actions: ["Reserva comunicada"],
  }));
}

async function setup(t: TestContext) {
  const config = dashboardConfig(dashboardDirectory(t));
  const upstream = dashboardFetch();
  let agendaReads = 0;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const match = /^\/api\/v1\/patients\/(person-\d+)\/appointments$/.exec(url.pathname);
    if (match) {
      agendaReads += 1;
      return Response.json({ appointments: [{
        appointment_id: `appointment-${match[1]}`, patient_id: match[1],
        provider_id: "test-provider", location_id: "test-site", appointment_type_id: "test-type",
        start_time: "2026-10-01T10:30:00+02:00", duration_minutes: 30,
      }] });
    }
    return upstream.request(input, init);
  };
  const server = createDashboardServer(config, new DashboardService(config, request), resolve("dashboard"));
  const port = await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const base = `http://127.0.0.1:${port}`;
  await page.route(`${base}/map-test`, (route) => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><html><head><link rel="stylesheet" href="/src/styles/tokens.css"><link rel="stylesheet" href="/src/styles/app.css"></head><body><div id="map"></div></body></html>',
  }));
  await page.goto(`${base}/map-test`);
  await page.evaluate(async ({ base, token, calls }) => {
    const apiPath = `${base}/src/data/api.js`;
    const networkPath = `${base}/src/components/network.js`;
    const data = await import(apiPath);
    const { networkPanel } = await import(networkPath);
    await data.connect(token);
    document.getElementById("map")!.append(networkPanel(calls));
  }, { base, token: config.DASHBOARD_TOKEN, calls: sampleCalls() });
  return { page, base, agendaReads: () => agendaReads };
}

test("the map shows every person by name around maio at varied radii without crowding", async (t) => {
  const { page } = await setup(t);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  assert.equal(await page.locator(".map__node").count(), 12);
  const labels = await page.locator(".map__node-label").allTextContents();
  assert.deepEqual(new Set(labels), new Set(Array.from({ length: 12 }, (_, index) => `Persona Ejemplo ${index + 1}`)));
  assert.equal(await page.locator(".map__node image").count(), 0);
  assert.equal(await page.locator(".map__node-fallback").count(), 12);
  assert.equal(await page.locator(".map__hub").count(), 1);
  const positions = await page.locator(".map__node").evaluateAll((nodes) => nodes.map((node) => ({
    x: Number(node.getAttribute("data-x")), y: Number(node.getAttribute("data-y")),
    radius: Number(node.getAttribute("data-radius")),
  })));
  for (let left = 0; left < positions.length; left += 1) {
    for (let right = left + 1; right < positions.length; right += 1) {
      assert.ok(Math.hypot(positions[left]!.x - positions[right]!.x, positions[left]!.y - positions[right]!.y) > 110);
    }
  }
  assert.ok(positions.some(({ x }) => x < 600) && positions.some(({ x }) => x > 600));
  assert.ok(positions.some(({ y }) => y < 350) && positions.some(({ y }) => y > 350));
  assert.ok(new Set(positions.map(({ radius }) => radius)).size >= 6);
  assert.match(await page.locator(".map-full__bar").innerText(), /12 de 30 personas/);
  await page.getByRole("button", { name: "Identificadores siguientes", exact: true }).click();
  assert.equal(await page.locator(".map__node").count(), 12);
  assert.match(await page.locator(".map-full__bar").innerText(), /2 \/ 3/);
  await page.getByRole("button", { name: "Identificadores siguientes", exact: true }).click();
  assert.equal(await page.locator(".map__node").count(), 6);
  assert.match(await page.locator(".map-full__bar").innerText(), /6 de 30 personas/);
  assert.deepEqual(errors, []);
});

test("hovering a person opens their detailed call card and reads the actual upcoming agenda once", async (t) => {
  const h = await setup(t);
  const node = h.page.locator('.map__node[data-person-id="person-0"]');
  await node.hover();
  const card = h.page.locator(".map-person__card");
  await card.getByText("Persona Ejemplo 1", { exact: true }).waitFor();
  await card.getByText("Profesional de prueba · Sede de prueba", { exact: true }).waitFor();
  assert.match(await card.innerText(), /ID: technical-call-0/);
  assert.match(await card.innerText(), /person-0/);
  assert.match(await card.innerText(), /Próxima cita/);
  assert.match(await card.innerText(), /1m 20s/);
  assert.equal(h.agendaReads(), 1);
  await card.getByRole("img", { name: "Sin fotografía; icono Finn the Human", exact: true }).waitFor();
  await card.getByRole("button", { name: "Cerrar", exact: true }).click();
  await h.page.locator('.map__node[data-person-id="person-0"]').focus();
  await card.getByText("Persona Ejemplo 1", { exact: true }).waitFor();
  assert.equal(h.agendaReads(), 1, "Hover/focus should reuse the short agenda cache");
});

test("every mapped person has a populated card with their own call information", { timeout: 60_000 }, async (t) => {
  const h = await setup(t);
  const seen = new Set<string>();
  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    const ids = await h.page.locator(".map__node").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-person-id")).filter((id): id is string => Boolean(id)));
    for (const id of ids) {
      const index = Number(id.split("-").at(-1));
      await h.page.locator(`.map__node[data-person-id="${id}"]`).evaluate((node) =>
        node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      const card = h.page.locator(".map-person__card");
      await card.getByText(`Persona Ejemplo ${index + 1}`, { exact: true }).waitFor();
      await card.getByText("Profesional de prueba · Sede de prueba", { exact: true }).waitFor();
      const text = await card.innerText();
      assert.match(text, new RegExp(`ID: technical-call-${index}`));
      assert.match(text, /Llamadas\s+1 · últimos 7 días observados/);
      assert.match(text, /Última llamada\s+Hoy/);
      assert.match(text, /Duración\s+1m 20s/);
      assert.match(text, /Último resultado\s+Registro recibido/);
      assert.match(text, /Profesional de prueba · Sede de prueba/);
      await card.getByRole("img", { name: "Sin fotografía; icono Finn the Human", exact: true }).waitFor();
      seen.add(id);
      await card.getByRole("button", { name: "Cerrar", exact: true }).click();
    }
    if (pageIndex < 2) await h.page.getByRole("button", { name: "Identificadores siguientes", exact: true }).click();
  }
  assert.equal(seen.size, 30);
  assert.equal(h.agendaReads(), 30);
});

test("unlinked calls are not invented people and map updates retain page and pan", async (t) => {
  const h = await setup(t);
  await h.page.getByRole("button", { name: "Identificadores siguientes", exact: true }).click();
  await h.page.getByRole("button", { name: "Ampliar", exact: true }).click();
  const before = await h.page.locator(".map__viewport").getAttribute("transform");
  await h.page.evaluate((calls) => {
    const element = document.querySelector(".map-full");
    const update = Reflect.get(element!, "update");
    update([...calls, { ...calls[0], id: "unlinked-call", personKey: "unlinked-call", patientIds: [],
      caller: "Llamada unlinked-call" }], { state: "all", range: "7d" });
  }, sampleCalls());
  assert.match(await h.page.locator(".map-full__bar").innerText(), /2 \/ 3/);
  assert.match(await h.page.locator(".map-full__bar").innerText(), /30 personas · 31 llamadas/);
  assert.equal(await h.page.locator(".map__viewport").getAttribute("transform"), before);
  assert.equal(await h.page.locator(".map__node-label").getByText("Llamada unlinked-call").count(), 0);
});
