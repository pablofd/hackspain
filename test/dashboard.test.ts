import assert from "node:assert/strict";
import { chmodSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DashboardRecords, projectCallRecord } from "../src/dashboard/records.js";
import { DashboardService } from "../src/dashboard/service.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { requestJson } from "../src/dashboard/source.js";
import { z } from "zod";
import { dashboardBook, dashboardConfig, dashboardDirectory, dashboardFetch, dashboardPatient, writeDashboardRecord } from "./dashboard-fixtures.js";

test("dashboard credentials and local binding are independent of the voice endpoint", () => {
  assert.throws(() => dashboardConfig("/tmp", {
    DASHBOARD_TOKEN: "synthetic-voice-endpoint-token-32-characters",
  }), { code: "dashboard_token_must_be_separate" });
  assert.throws(() => dashboardConfig("/tmp", { DASHBOARD_HOST: "0.0.0.0" }), { code: "dashboard_invalid_configuration" });
  assert.throws(() => dashboardConfig("/tmp", { DASHBOARD_VOICE_URL: "http://example.com" }), { code: "dashboard_invalid_configuration" });
  assert.throws(() => dashboardConfig("/tmp", { AZURE_MONITOR_RESOURCE_ID: "https://attacker.example" }), { code: "dashboard_invalid_configuration" });
});

test("private records expose only allowed metadata, never transcript, action bodies or tools' details", async (t) => {
  const directory = dashboardDirectory(t);
  const { text } = writeDashboardRecord(directory);
  const call = projectCallRecord(`${text}{"unfinished":`, "dashboard-test-call");
  assert.equal(call.transcriptEvents, 1);
  assert.equal(call.interruptions, 1);
  assert.equal(call.inputBytes, 8000);
  assert.equal(call.actions[0]?.stage, "accepted");
  assert.doesNotMatch(JSON.stringify(call), /PRIVATE_|00000000T|PATIENT_TEST|policy_id|patient_id/);
  assert.throws(() => projectCallRecord(text, "another-call"), { code: "dashboard_invalid_record" });
  const reader = new DashboardRecords(directory, 7);
  assert.deepEqual((await reader.read()).calls, [call]);
  assert.deepEqual((await reader.read()).calls, [call]);
});

test("the record reader refuses symlinks and does not read unrelated private files", async (t) => {
  const directory = dashboardDirectory(t);
  const { path } = writeDashboardRecord(directory);
  const privatePath = join(directory, ".env.local");
  writeFileSync(privatePath, "PRIVATE_SECRET", { mode: 0o600 });
  rmSync(path);
  symlinkSync(resolve(privatePath), path);
  await assert.rejects(new DashboardRecords(directory, 7).read(), { code: "dashboard_records_unavailable" });
});

test("additional source permissions are reported without modifying shared source files or exposing content", async (t) => {
  const directory = dashboardDirectory(t);
  const { path } = writeDashboardRecord(directory);
  chmodSync(directory, 0o770);
  chmodSync(path, 0o660);
  const result = await new DashboardRecords(directory, 7).read();
  assert.equal(result.restrictedPermissions, false);
  assert.equal(statSync(directory).mode & 0o777, 0o770);
  assert.equal(statSync(path).mode & 0o777, 0o660);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|00000000T/);
});

test("snapshot correlates actual receipts, keeps proposed actions separate and never submits a record", async (t) => {
  const directory = dashboardDirectory(t);
  writeDashboardRecord(directory);
  writeDashboardRecord(directory, "open-test", { ended: false, accepted: false });
  writeDashboardRecord(directory, "old-unclosed", { ended: false, accepted: false, started: new Date(Date.now() - 300_000) });
  const upstream = dashboardFetch();
  const service = new DashboardService(dashboardConfig(directory), upstream.request);
  const snapshot = await service.snapshot();
  assert.equal(snapshot.clinic?.patientCount, 2);
  const booked = snapshot.calls.find((call) => call.id === "dashboard-test-call")!;
  assert.equal(booked.receiptSource, "prosper");
  assert.equal(booked.durationMs, 20_000);
  assert.deepEqual(booked.patientIds, ["PATIENT_TEST"]);
  assert.equal(booked.technical.trace, null);
  const proposed = snapshot.calls.find((call) => call.id === "open-test")!;
  assert.equal(proposed.openRecord, true);
  assert.deepEqual(proposed.actions, []);
  assert.equal(snapshot.calls.find((call) => call.id === "old-unclosed")!.openRecord, false);
  assert.equal(snapshot.sources.speech.status, "not_used");
  assert.equal(snapshot.sources.foundry.status, "not_configured");
  assert.equal(snapshot.coverage.completeHistory, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_|00000000T|synthetic-prosper-key|DASHBOARD_TOKEN|national_id/);
  assert.ok(snapshot.unavailable.includes("sentiment"));
  await service.snapshot();
  assert.equal(upstream.requests.length, 3);
  assert.ok(upstream.requests.every((request) => request.method === "GET"));
});

test("missing sources stay explicit errors, not empty successful statistics", async (t) => {
  const directory = dashboardDirectory(t);
  const service = new DashboardService(dashboardConfig(join(directory, "missing")), dashboardFetch({ fail: true }).request);
  const result = await service.snapshot();
  assert.equal(result.sources.records.status, "error");
  assert.equal(result.sources.submissions.status, "error");
  assert.equal(result.sources.clinic.status, "error");
  assert.equal(result.sources.voice.status, "error");
  assert.equal(result.health, null);
  assert.equal(result.clinic, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_UPSTREAM_FAILURE/);
});

test("successive multi-action receipts stay together without publishing registration demographics", async (t) => {
  const directory = dashboardDirectory(t);
  const upstream = dashboardFetch();
  const request: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname !== "/api/v1/submissions") return upstream.request(input, init);
    const newest = { call_id: "multi-call-test", received_at: new Date().toISOString(), record: { actions: [
      dashboardBook,
      { action: "REGISTER", new_patient: {
        given_name: "PRIVATE_NEW_PATIENT", first_surname: "Synthetic", second_surname: "Test",
        national_id: "00000000T", date_of_birth: "1980-06-15", phone: "600000000",
        email: "private-register@example.test", insurer: "mapfre",
      } },
    ] } };
    return Response.json({ submissions: [newest, {
      call_id: newest.call_id, received_at: new Date(Date.now() - 1000).toISOString(), record: { actions: [dashboardBook] },
    }] });
  };
  const result = await new DashboardService(dashboardConfig(directory), request).snapshot();
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0]?.actions.map(({ action }) => action), ["BOOK", "REGISTER"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NEW_PATIENT|private-register|00000000T|1980-06-15|600000000|new_patient/);
});

test("patient lookup and upcoming appointments reuse the clinic client without leaking protected fields", async (t) => {
  const directory = dashboardDirectory(t);
  const upstream = dashboardFetch();
  const service = new DashboardService(dashboardConfig(directory), upstream.request);
  await assert.rejects(service.patients({}), { code: "dashboard_invalid_patient_search" });
  await assert.rejects(service.patients({ national_id: dashboardPatient.national_id }), { code: "dashboard_invalid_patient_search" });
  assert.equal(upstream.requests.length, 0);
  const result = await service.patients({ name: "Ada Sintetica" });
  assert.deepEqual(Object.keys(result.patients[0]!).sort(), ["id", "insurer", "name", "phone"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|00000000T|1980-06-15|private@example/);
  assert.equal(upstream.requests[0]?.url.searchParams.get("name"), "Ada Sintetica");
  assert.equal(upstream.requests[0]?.headers.get("X-Api-Key"), "synthetic-prosper-key");
  const appointments = await service.appointments("PATIENT_TEST");
  assert.equal(appointments.appointments[0]?.id, "APPOINTMENT_TEST");
  assert.equal(upstream.requests[1]?.url.searchParams.get("when"), "upcoming");
  await assert.rejects(service.appointments("../submit/book"), { code: "dashboard_invalid_patient_id" });
  assert.ok(upstream.requests.every(({ method }) => method === "GET"));
});

test("HTTP surface is authenticated, read-only, no-store and cannot serve backend or private files", async (t) => {
  const directory = dashboardDirectory(t);
  const settings = dashboardConfig(directory);
  const upstream = dashboardFetch({ submissions: false });
  const service = new DashboardService(settings, upstream.request);
  const server = createDashboardServer(settings, service, resolve("dashboard"));
  const port = await server.listen();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${settings.DASHBOARD_TOKEN}` };
  assert.equal((await fetch(`${base}/api/dashboard/snapshot`)).status, 401);
  assert.equal((await fetch(`${base}/api/dashboard/snapshot?token=${settings.DASHBOARD_TOKEN}`)).status, 401);
  assert.equal((await fetch(`${base}/api/dashboard/snapshot`, {
    headers: { Authorization: `Bearer ${settings.voice.VOICE_ENDPOINT_TOKEN}` },
  })).status, 401);
  assert.equal(upstream.requests.length, 0);
  assert.equal((await fetch(`${base}/api/v1/submit/book`, { method: "POST", headers })).status, 405);
  assert.equal((await fetch(`${base}/api/dashboard/snapshot`, {
    headers: { ...headers, "sec-fetch-site": "cross-site" },
  })).status, 403);
  assert.equal(upstream.requests.length, 0);
  const result = await fetch(`${base}/api/dashboard/snapshot`, { headers });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.match(result.headers.get("content-security-policy")!, /connect-src 'self'/);
  for (const path of ["/.env.local", "/.local/calls/example.ndjson", "/src/config.ts", "/README.md", "/%2e%2e/.env.local"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 404);
  }
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/src/data/api.js`)).status, 200);
  assert.equal((await fetch(`${base}/src/data/mock.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/dashboard/patients?name=Ada&name=Other`, { headers })).status, 400);
  assert.ok(upstream.requests.every(({ method }) => method === "GET"));
});

test("HTTP source reader bounds bodies and rejects malformed JSON without forwarding private details", async () => {
  const url = new URL("https://clinic.example/api/v1/clinic");
  await assert.rejects(requestJson(async () => new Response("not-json"), url, z.object({}), "test", {}, new AbortController().signal),
    { code: "test_invalid_json" });
  await assert.rejects(requestJson(async () => new Response("x".repeat(4 * 1024 * 1024 + 1)), url, z.object({}), "test", {}, new AbortController().signal),
    { code: "test_response_too_large" });
});
