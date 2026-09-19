import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  ProsperRunsClient, RunApiError, caseVerdict, formatRun, scoredRunEligibility,
  runCounts, runFinished, runSchema, saveRunSnapshot, transientRunError,
} from "../src/prosper-runs.js";

const settings = { PROSPER_API_BASE_URL: "https://prosper.example", PROSPER_API_KEY: "synthetic-key" };
const signal = () => new AbortController().signal;
const completed = {
  id: "run-test", team_id: "team-test", mode: "scored" as const, status: "completed" as const,
  endpoint: "wss://agent.example/ws",
  created_at: "2026-09-19T10:00:00.000001Z", started_at: "2026-09-19T10:01:00Z",
  finished_at: "2026-09-19T10:20:00Z",
  cases: [
    { call_id: "call-test", passed: true, attribution: "none" as const, signal_codes: ["wall_clock"] },
  ],
};

test("run listing and detail use TeamApiKey, validate IDs and strip non-console fields", async () => {
  const requests: string[] = [];
  const client = new ProsperRunsClient(settings, async (input, init) => {
    requests.push(String(input));
    assert.equal(new Headers(init?.headers).get("X-Api-Key"), "synthetic-key");
    assert.equal(init?.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    const run = {
      ...completed, endpoint: "wss://username:private-value@agent.example/ws?token=private-value",
      notification: "not for console", api_key: "private-value",
      cases: [{ ...completed.cases[0], transcript: "private-value", expected: { patient_id: "private-value" } }],
    };
    return Response.json(String(input).endsWith("/runs") ? { runs: [run] } : run);
  });
  const runs = await client.list(signal());
  assert.equal(runs[0]?.endpoint, "wss://agent.example/ws");
  assert.ok(!JSON.stringify(runs).includes("private-value"));
  assert.deepEqual(await client.get("run-test", signal()), runs[0]);
  await assert.rejects(client.get("../other", signal()), { code: "invalid_run_id" });
  assert.deepEqual(requests, ["https://prosper.example/api/v1/runs", "https://prosper.example/api/v1/runs/run-test"]);
});

test("scored admission sends only the selected problem and scored lane", async () => {
  let requests = 0;
  const client = new ProsperRunsClient(settings, async (input, init) => {
    requests += 1;
    assert.equal(String(input), "https://prosper.example/api/v1/runs");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { lane: "scored", problem_id: "no_slot_free" });
    assert.equal(new Headers(init?.headers).get("X-Api-Key"), "synthetic-key");
    assert.equal(init?.redirect, "error");
    return Response.json({ id: "new-run" }, { status: 202 });
  });
  assert.deepEqual(await client.startScored("no_slot_free", signal()), { id: "new-run" });
  assert.equal(requests, 1);
  await assert.rejects(client.startScored("../invalid", signal()), { code: "invalid_problem_id" });
  await assert.rejects(client.startScored("switchboard", signal()), { code: "unscored_problem" });
  assert.equal(requests, 1);
});

test("uncertain admission never retries POST or claims no run was created", async () => {
  for (const request of [
    async () => { throw new Error("private upstream data"); },
    async () => new Response("private upstream data", { status: 503 }),
    async () => new Response("not json", { status: 202 }),
    async () => Response.json({ wrong: "private upstream data" }, { status: 202 }),
  ]) {
    let count = 0;
    const client = new ProsperRunsClient(settings, async () => { count += 1; return request(); });
    await assert.rejects(client.startScored("no_slot_free", signal()), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "prosper_run_admission_unknown");
      assert.ok(!error.message.includes("private upstream data"));
      return true;
    });
    assert.equal(count, 1);
  }
});

test("HTTP cooldown and authorization errors remain explicit without exposing response bodies", async () => {
  for (const status of [401, 403, 409, 429]) {
    const client = new ProsperRunsClient(settings, async () =>
      new Response("sensitive explanation", { status, headers: { "Retry-After": "25" } }));
    await assert.rejects(client.startScored("no_slot_free", signal()), (error: unknown) => {
      assert.ok(error instanceof RunApiError);
      assert.equal(error.status, status);
      assert.equal(error.retryAfterMs, 25_000);
      assert.ok(!error.message.includes("sensitive explanation"));
      assert.equal(transientRunError(error), status === 429);
      return true;
    });
  }
});

test("run reads reject malformed JSON, wrong IDs and unsupported statuses", async () => {
  for (const body of [{ bad: true }, { ...completed, id: "other" }, { ...completed, status: "invented" }]) {
    const client = new ProsperRunsClient(settings, async () => Response.json(body));
    await assert.rejects(client.get("run-test", signal()), { code: "prosper_run_invalid_response" });
  }
  const malformed = new ProsperRunsClient(settings, async () => new Response("<html>unavailable</html>"));
  await assert.rejects(malformed.list(signal()), { code: "prosper_run_invalid_response" });
});

test("aborting monitoring does not cancel a remote run or make another request", async () => {
  let requests = 0;
  const controller = new AbortController();
  const client = new ProsperRunsClient(settings, async (_input, init) => {
    requests += 1;
    assert.equal(init?.method, "GET");
    assert.ok(init?.signal);
    const pendingSignal = init.signal;
    return new Promise<Response>((_resolve, reject) => {
      pendingSignal.addEventListener("abort", () => reject(pendingSignal.reason), { once: true });
    });
  });
  const rejected = assert.rejects(client.get("run-test", controller.signal), { code: "operation_aborted" });
  controller.abort();
  await rejected;
  assert.equal(requests, 1);
});

test("official PASS takes precedence over wall-clock and other failure signals", () => {
  const run = runSchema.parse(completed);
  assert.equal(caseVerdict(run.cases[0]!), "PASS");
  assert.deepEqual(runCounts(run), { reported: 1, passed: 1, failed: 0, voided: 0, pending: 0 });
  assert.match(formatRun(run, true), /PASS/);
  assert.match(formatRun(run, true), /wall_clock/);
  assert.ok(runFinished(run));
  const running = { ...run, status: "running" as const, finished_at: null };
  assert.match(formatRun(running), /Published verdicts 1/);
  assert.match(formatRun(running), /total not supplied yet/);
  assert.doesNotMatch(formatRun(running), /PENDING 0/);
  const pending = { call_id: null, passed: null, attribution: null, signal_codes: [] };
  assert.equal(caseVerdict(pending), "PENDING");
  assert.equal(caseVerdict({ ...pending, passed: false, attribution: "harness_issue" }), "VOID");
  assert.equal(caseVerdict({ ...pending, passed: false, attribution: "mixed" }), "VOID");
  assert.equal(caseVerdict({ ...pending, passed: false, attribution: "inconclusive", signal_codes: ["wall_clock"] }), "FAIL");
});

test("one active run in either lane blocks admission and scored cooldown starts at finish", () => {
  const run = runSchema.parse(completed);
  const before = Date.parse("2026-09-19T10:31:59Z");
  assert.equal(scoredRunEligibility([run], before).ready, false);
  assert.equal(scoredRunEligibility([run], before).eligibleAt, Date.parse("2026-09-19T10:32:00Z"));
  assert.equal(scoredRunEligibility([run], before + 1000).ready, true);
  const practice = { ...run, id: "practice", mode: "practice" as const, status: "running" as const, finished_at: null };
  assert.equal(scoredRunEligibility([practice, run], before + 2000).active?.id, "practice");
  assert.equal(scoredRunEligibility([practice, run], before + 2000).ready, false);
  assert.equal(scoredRunEligibility([{ ...run, mode: "practice" }], Date.parse(run.finished_at!)).ready, true);
  assert.equal(scoredRunEligibility([], before).ready, true);
});

test("private snapshots retain receipt IDs, redact endpoint credentials and atomically update", (t) => {
  const id = `snapshot-test-${randomUUID()}`;
  const path = saveRunSnapshot(id);
  t.after(() => rmSync(path, { force: true }));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).state, "admitted");
  const admittedAt = JSON.parse(readFileSync(path, "utf8")).admission_received_at;
  assert.equal(typeof admittedAt, "string");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  saveRunSnapshot(id, { ...completed, id, endpoint: "wss://user:secret@agent.example/ws?secret=secret" });
  const text = readFileSync(path, "utf8");
  assert.ok(!text.includes("secret"));
  assert.equal(JSON.parse(text).run.id, id);
  assert.equal(JSON.parse(text).admission_received_at, admittedAt);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => saveRunSnapshot("../escape"), { code: "invalid_run_id" });
});

test("snapshot updates refuse symlinks without altering their targets", (t) => {
  const id = `snapshot-link-${randomUUID()}`;
  const path = saveRunSnapshot(id);
  const target = resolve(`${path}.target`);
  t.after(() => { rmSync(path, { force: true }); rmSync(target, { force: true }); });
  writeFileSync(target, "unchanged", { mode: 0o600 });
  rmSync(path);
  symlinkSync(target, path);
  assert.throws(() => saveRunSnapshot(id, { ...completed, id }), { code: "prosper_run_unsafe_path" });
  assert.equal(readFileSync(target, "utf8"), "unchanged");
});

test("observing an existing run does not fabricate an admission receipt", (t) => {
  const id = `observed-test-${randomUUID()}`;
  const path = saveRunSnapshot(id, { ...completed, id });
  t.after(() => rmSync(path, { force: true }));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).admission_received_at, undefined);
});

test("CLI rejects obsolete batch admission and invalid score targets before loading credentials", () => {
  for (const args of [
    ["run-all"], ["score"], ["score", "--problem", "../invalid"], ["score", "--problem", "switchboard"],
  ]) {
    const result = spawnSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), resolve("scripts/prosper-runs.ts"), ...args,
    ], { encoding: "utf8", timeout: 15_000, env: {} });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /prosper_run_all_removed|missing_problem_id|invalid_problem_id|unscored_problem/);
  }
});

for (const mode of ["scored", "practice"] as const) {
test(`CLI admission validates the ${mode} lane and never prints credentials`, (t) => {
  const directory = resolve(".local", `runs-cli-test-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const mock = resolve(directory, "fake-fetch.mjs");
  writeFileSync(mock, `
    import assert from 'node:assert/strict';
    const run = ${JSON.stringify({ ...completed, mode })};
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://prosper.example');
      assert.equal(new Headers(init.headers).get('X-Api-Key'), 'synthetic-cli-key');
      if (init.method === 'POST') {
        assert.equal(url.pathname, '/api/v1/runs');
        assert.deepEqual(JSON.parse(init.body), {lane:'scored',problem_id:'no_slot_free'});
        return Response.json({id:run.id}, {status:202});
      }
      if (url.pathname === '/api/v1/runs') return Response.json({runs:[]});
      assert.equal(url.pathname, '/api/v1/runs/run-test');
      return Response.json({...run, notification:'do not display', private_field:'do not display'});
    };
  `, { mode: 0o600 });
  const result = spawnSync(process.execPath, [
    "--import", mock, "--import", import.meta.resolve("tsx"), resolve("scripts/prosper-runs.ts"),
    "score", "--problem", "no_slot_free", "--watch", "--json",
  ], {
    cwd: directory, encoding: "utf8", timeout: 15_000,
    env: {
      AZURE_OPENAI_ENDPOINT: "https://synthetic.openai.azure.com",
      PROSPER_API_BASE_URL: "https://prosper.example",
      PROSPER_API_KEY: "synthetic-cli-key",
      VOICE_ENDPOINT_TOKEN: "synthetic-voice-token-at-least-32-characters",
    },
  });
  assert.equal(result.status, mode === "scored" ? 0 : 1, result.stderr);
  if (mode === "scored") {
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.run.id, "run-test");
    assert.equal(parsed.counts.passed, 1);
    assert.equal(parsed.counts.failed, 0);
  } else {
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /prosper_run_lane_mismatch/);
  }
  assert.match(result.stderr, /ADMITTED run-test/);
  assert.ok(!(result.stdout + result.stderr).includes("synthetic-cli-key"));
  assert.ok(!result.stdout.includes("do not display"));
  assert.equal(statSync(resolve(directory, ".local/runs/run-run-test.json")).mode & 0o777, 0o600);
});
}
