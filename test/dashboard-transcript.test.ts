import assert from "node:assert/strict";
import { appendFileSync, linkSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DashboardRecords, projectCallTranscript } from "../src/dashboard/records.js";
import { DashboardService } from "../src/dashboard/service.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { dashboardConfig, dashboardDirectory, dashboardFetch, writeDashboardRecord } from "./dashboard-fixtures.js";

test("selected transcripts project only validated fields, preserve synthetic statements and redact credentials", async (t) => {
  const directory = dashboardDirectory(t);
  const settings = dashboardConfig(directory, {
    AZURE_OPENAI_API_KEY: "synthetic-azure-transcript-key",
    APPLICATIONINSIGHTS_CONNECTION_STRING: "synthetic-insights-transcript-credential",
  });
  const secrets = [
    settings.DASHBOARD_TOKEN, settings.voice.PROSPER_API_KEY, settings.voice.VOICE_ENDPOINT_TOKEN,
    settings.voice.AZURE_OPENAI_API_KEY!, settings.voice.APPLICATIONINSIGHTS_CONNECTION_STRING!,
  ];
  const { path, record, started } = writeDashboardRecord(directory, "dashboard-test-call", { transcripts: [] });
  const statement = 'Soy una paciente sintética, DNI 00000000T. <img src=x onerror="alert(1)">\n  palabra palabra';
  appendFileSync(path, [
    record("transcript", {
      speaker: "user", text: statement, itemId: "synthetic-user-item",
      details: "PRIVATE_TRANSCRIPT_DETAILS", audio: { filename: "PRIVATE_AUDIO.wav" },
    }, 21_000),
    record("transcript", {
      speaker: "assistant", text: `Texto generado [REDACTED] ${secrets.join(" ")}`,
      itemId: `${settings.voice.PROSPER_API_KEY}-item`, partial: true, startMs: 1200.5, endMs: 1300.5,
      path: "PRIVATE_SOURCE_PATH", arguments: { national_id: "PRIVATE_TOOL_ARGUMENT" },
    }, 22_000),
  ].map((line) => `${JSON.stringify(line)}\n`).join(""));
  const upstream = dashboardFetch();
  const service = new DashboardService(settings, upstream.request);
  const transcript = await service.transcript("dashboard-test-call");
  assert.deepEqual(upstream.requests, [], "A transcript is never sent to Prosper, Azure or another model");
  assert.equal(transcript.callId, "dashboard-test-call");
  assert.equal(transcript.historyDays, 7);
  assert.ok(Number.isFinite(Date.parse(transcript.checkedAt)));
  assert.equal(transcript.limited, false);
  assert.deepEqual(transcript.entries[0], {
    timestamp: new Date(started.getTime() + 21_000).toISOString(),
    speaker: "user", text: statement, itemId: "synthetic-user-item",
  });
  assert.deepEqual(transcript.entries[1], {
    timestamp: new Date(started.getTime() + 22_000).toISOString(),
    speaker: "assistant", text: `Texto generado ${Array(6).fill("[REDACTED]").join(" ")}`,
    itemId: "[REDACTED]-item", partial: true, startMs: 1200.5, endMs: 1300.5,
  });
  const serialized = JSON.stringify(transcript);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  assert.doesNotMatch(serialized, /PRIVATE_|policy_id|patient_id|proposalId|\.ndjson|\.wav/);
  const snapshot = await service.snapshot();
  assert.doesNotMatch(JSON.stringify(snapshot), /00000000T|palabra|Texto generado|synthetic-user-item|startMs|endMs|PRIVATE_/);
  assert.equal(snapshot.calls[0]?.technical.transcriptEvents, 2);
  assert.equal("transcript" in snapshot.calls[0]!, false);
});

test("transcripts refresh from complete appended lines without synthesizing an unfinished event", async (t) => {
  const directory = dashboardDirectory(t);
  const { path, record } = writeDashboardRecord(directory, "append-test", { ended: false, transcripts: [] });
  const reader = new DashboardRecords(directory, 7);
  assert.deepEqual((await reader.transcript("append-test")).entries, []);
  const entry = JSON.stringify(record("transcript", {
    speaker: "assistant", text: "Fragmento de prueba actualizado", itemId: "append-item", partial: true,
  }, 6000));
  appendFileSync(path, entry.slice(0, -1));
  assert.deepEqual((await reader.transcript("append-test")).entries, []);
  appendFileSync(path, "}\n");
  assert.equal((await reader.transcript("append-test")).entries[0]?.text, "Fragmento de prueba actualizado");
  assert.deepEqual((await reader.read()).calls[0]?.transcriptEvents, 1);
});

test("transcript schemas reject malformed envelopes, speakers, partial flags, item IDs and timing", async (t) => {
  const directory = dashboardDirectory(t);
  const { record, text } = writeDashboardRecord(directory, "schema-test");
  const start = `${JSON.stringify(record("start"))}\n`;
  const fields = { speaker: "assistant", itemId: "schema-item", text: "Texto sintético" };
  for (const invalid of [
    { speaker: "system" }, { text: { html: "not text" } }, { itemId: 123 }, { itemId: "x".repeat(513) },
    { partial: "true" }, { startMs: 1 }, { endMs: 1 }, { startMs: -1, endMs: 1 },
    { startMs: 2, endMs: 1 }, { startMs: null, endMs: 1 }, { startMs: "0", endMs: 1 },
  ]) {
    const event = record("transcript", { ...fields, ...invalid }, 1);
    assert.throws(() => projectCallTranscript(`${start}${JSON.stringify(event)}\n`, "schema-test"),
      { code: "dashboard_invalid_transcript" });
  }
  for (const invalid of [
    { callId: "other-call" }, { schemaVersion: 2 }, { timestamp: "not-a-date" },
    { timestamp: "2000-01-01T00:00:00.000Z" },
  ]) {
    const event = { ...record("transcript", fields, 1), ...invalid };
    assert.throws(() => projectCallTranscript(`${start}${JSON.stringify(event)}\n`, "schema-test"),
      { code: "dashboard_invalid_record" });
  }
  assert.throws(() => projectCallTranscript(text, "another-call"), { code: "dashboard_invalid_record" });
  assert.throws(() => projectCallTranscript(`${start}not-json\n`, "schema-test"), { code: "dashboard_invalid_record" });
  assert.throws(() => projectCallTranscript('{"incomplete":', "schema-test"), { code: "dashboard_incomplete_record" });
  assert.throws(() => projectCallTranscript(`${start}${JSON.stringify(record("transcript", {
    ...fields, text: "x".repeat(64 * 1024),
  }))}\n`, "schema-test"), { code: "dashboard_record_event_too_large" });
});

test("incomplete UTF-8 lines wait for completion and corrupt complete text is a source error", async (t) => {
  const directory = dashboardDirectory(t);
  const { path, text, record } = writeDashboardRecord(directory, "unicode-test", { transcripts: [] });
  const reader = new DashboardRecords(directory, 7);
  const line = Buffer.from(`${JSON.stringify(record("transcript", {
    speaker: "user", itemId: "unicode-item", text: "Sí, una cita sintética.",
  }, 21_000))}\n`);
  const split = line.indexOf(Buffer.from("í")) + 1;
  appendFileSync(path, line.subarray(0, split));
  assert.deepEqual((await reader.transcript("unicode-test")).entries, []);
  appendFileSync(path, line.subarray(split));
  assert.equal((await reader.transcript("unicode-test")).entries[0]?.text, "Sí, una cita sintética.");
  const corrupt = Buffer.from(line);
  corrupt[split] = 0xff;
  writeFileSync(path, Buffer.concat([Buffer.from(text), corrupt]), { mode: 0o600 });
  await assert.rejects(reader.transcript("unicode-test"), { code: "dashboard_invalid_record" });
});

test("selected reads use the newest matching call record, not another call's text or errors", async (t) => {
  const directory = dashboardDirectory(t);
  const now = new Date();
  writeDashboardRecord(directory, "repeated-id", {
    started: new Date(now.getTime() - 60_000), transcripts: [
      { speaker: "user", text: "Versión anterior de prueba.", itemId: "old-item" },
    ],
  });
  writeDashboardRecord(directory, "repeated-id", {
    started: new Date(now.getTime() - 30_000), transcripts: [
      { speaker: "user", text: "Versión actual de prueba.", itemId: "current-item" },
    ],
  });
  const other = writeDashboardRecord(directory, "different-id", { started: new Date(now.getTime() - 1000) });
  writeFileSync(other.path, "PRIVATE_OTHER_CALL_INVALID_JSON\n", { mode: 0o600 });
  const result = await new DashboardRecords(directory, 7).transcript("repeated-id", now);
  assert.deepEqual(result.entries.map(({ text }) => text), ["Versión actual de prueba."]);
  assert.doesNotMatch(JSON.stringify(result), /anterior|PRIVATE_OTHER_CALL/);
});

test("transcript projections retain the newest events within entry and UTF-8 byte budgets", async (t) => {
  const directory = dashboardDirectory(t);
  const { text } = writeDashboardRecord(directory, "many-fragments", {
    transcripts: Array.from({ length: 510 }, (_, index) => ({
      speaker: "user", text: `Fragmento ${index}`, itemId: `fragment-${index}`, partial: true,
    })),
  });
  const countLimited = projectCallTranscript(text, "many-fragments");
  assert.equal(countLimited.limited, true);
  assert.equal(countLimited.entries.length, 500);
  assert.equal(countLimited.entries[0]?.text, "Fragmento 10");
  assert.equal(countLimited.entries.at(-1)?.text, "Fragmento 509");
  const large = writeDashboardRecord(directory, "large-fragments", {
    transcripts: Array.from({ length: 40 }, (_, index) => ({
      speaker: "assistant", text: `${index}: ${"ñ".repeat(5000)}`, itemId: `large-${index}`, partial: true,
    })),
  });
  const byteLimited = projectCallTranscript(large.text, "large-fragments");
  assert.equal(byteLimited.limited, true);
  assert.ok(byteLimited.entries.length > 0 && byteLimited.entries.length < 40);
  assert.ok(Buffer.byteLength(JSON.stringify(byteLimited.entries)) <= byteLimited.limits.bytes);
  assert.equal(byteLimited.entries.at(-1)?.itemId, "large-39");
});

test("selected records share history, file-count and ID bounds with the metadata reader", async (t) => {
  const directory = dashboardDirectory(t);
  const now = new Date();
  const reader = new DashboardRecords(directory, 7);
  for (const id of ["", "../private", "bad/id", "bad id", "_not-a-call", "x".repeat(129)]) {
    await assert.rejects(reader.transcript(id, now), { code: "dashboard_invalid_call_id" });
  }
  writeDashboardRecord(directory, "expired-call", { started: new Date(now.getTime() - 8 * 86_400_000) });
  writeDashboardRecord(directory, "future-call", { started: new Date(now.getTime() + 60_000) });
  for (const id of ["unknown-call", "expired-call", "future-call"]) {
    await assert.rejects(reader.transcript(id, now), { code: "dashboard_transcript_not_found" });
  }
  writeDashboardRecord(directory, "outside-file-limit", { started: new Date(now.getTime() - 60_000) });
  for (let index = 0; index < 200; index += 1) {
    writeDashboardRecord(directory, `recent-${index}`, {
      started: new Date(now.getTime() - 30_000 + index), transcripts: [], accepted: false,
    });
  }
  await assert.rejects(reader.transcript("outside-file-limit", now), { code: "dashboard_transcript_not_found" });
  assert.deepEqual((await reader.transcript("recent-199", now)).entries, []);
  const summary = await reader.read(now);
  assert.equal(summary.limited, true);
  assert.equal(summary.calls.length, 200);
});

test("transcript reads reject linked, nonregular, oversized and mismatched records without a file proxy", async (t) => {
  const directory = dashboardDirectory(t);
  const { path, text, started } = writeDashboardRecord(directory, "unsafe-test");
  const reader = new DashboardRecords(directory, 7);
  const privatePath = join(directory, "unrelated-private.txt");
  writeFileSync(privatePath, "PRIVATE_UNRELATED_FILE", { mode: 0o600 });
  rmSync(path);
  symlinkSync(resolve(privatePath), path);
  await assert.rejects(reader.transcript("unsafe-test"), { code: "dashboard_records_unavailable" });
  rmSync(path);
  writeFileSync(path, text, { mode: 0o600 });
  const hardlink = join(directory, "linked-record");
  linkSync(path, hardlink);
  await assert.rejects(reader.transcript("unsafe-test"), { code: "dashboard_unsafe_record" });
  rmSync(hardlink);
  truncateSync(path, 8 * 1024 * 1024 + 1);
  await assert.rejects(reader.transcript("unsafe-test"), { code: "dashboard_unsafe_record" });
  rmSync(path);
  mkdirSync(path);
  await assert.rejects(reader.transcript("unsafe-test"), { code: "dashboard_unsafe_record" });
  rmSync(path, { recursive: true });
  writeFileSync(path, text.replace(started.toISOString(), new Date(started.getTime() - 60_000).toISOString()), { mode: 0o600 });
  await assert.rejects(reader.transcript("unsafe-test"), { code: "dashboard_invalid_record" });
  const alias = join(directory, "record-directory-link");
  symlinkSync(resolve(directory), alias);
  await assert.rejects(new DashboardRecords(alias, 7).transcript("unsafe-test"), { code: "dashboard_records_unavailable" });
});

test("transcript HTTP is authenticated, same-origin, read-only, bounded and never exposes raw files", async (t) => {
  const directory = dashboardDirectory(t);
  const { path } = writeDashboardRecord(directory);
  writeDashboardRecord(directory, "empty-transcript", { transcripts: [] });
  const settings = dashboardConfig(directory);
  const upstream = dashboardFetch();
  const server = createDashboardServer(settings, new DashboardService(settings, upstream.request), resolve("dashboard"));
  const port = await server.listen();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const endpoint = `${base}/api/dashboard/calls/dashboard-test-call/transcript`;
  const headers = { Authorization: `Bearer ${settings.DASHBOARD_TOKEN}` };
  for (const url of [endpoint, `${endpoint}?token=${settings.DASHBOARD_TOKEN}`, `${base}/api/dashboard/calls/bad%20id/transcript`]) {
    const result = await fetch(url);
    assert.equal(result.status, 401);
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
  assert.equal((await fetch(endpoint, { headers: { Authorization: "Bearer incorrect-synthetic-token" } })).status, 401);
  assert.equal((await fetch(endpoint, { headers: { ...headers, "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await fetch(endpoint, { headers, method: "POST" })).status, 405);
  const response = await fetch(endpoint, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy")!, /connect-src 'self'/);
  const body = await response.json() as { entries: { text: string }[] };
  assert.equal(body.entries[0]?.text, "PRIVATE_TRANSCRIPT_WITH_ID_00000000T");
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_TOOL_NAME|PRIVATE_AUDIO_FILENAME|\.ndjson|policy_id|patient_id/);
  assert.deepEqual(upstream.requests, []);
  const empty = await fetch(`${base}/api/dashboard/calls/empty-transcript/transcript`, { headers });
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json() as { entries: unknown[] }).entries, []);
  const unknown = await fetch(`${base}/api/dashboard/calls/unknown-call/transcript`, { headers });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "dashboard_transcript_not_found" });
  for (const id of ["", "bad%20id", "bad%2Fid", "bad%00id", "%ZZ", "_bad", "x".repeat(129)]) {
    assert.equal((await fetch(`${base}/api/dashboard/calls/${id}/transcript`, { headers })).status, 400, id);
  }
  assert.equal((await fetch(`${endpoint}?path=unrelated-private.txt`, { headers })).status, 400);
  for (const raw of ["/.local/calls/example.ndjson", "/.local/calls/example.wav", "/.env.local", "/api/dashboard/files/example.wav"]) {
    assert.equal((await fetch(`${base}${raw}`, { headers })).status, 404);
  }
  writeFileSync(path, "PRIVATE_MALFORMED_RECORD\n", { mode: 0o600 });
  const broken = await fetch(endpoint, { headers });
  assert.equal(broken.status, 503);
  assert.deepEqual(await broken.json(), { error: "dashboard_invalid_record" });
  rmSync(directory, { recursive: true });
  const unavailable = await fetch(endpoint, { headers });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "dashboard_records_unavailable" });
  assert.deepEqual(upstream.requests, []);
});
