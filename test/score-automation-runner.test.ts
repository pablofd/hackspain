import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { AppError } from "../src/errors.js";
import type { PublishedProblem, TeamProgress } from "../src/prosper-dashboard.js";
import { RunApiError, type ProsperRun } from "../src/prosper-runs.js";
import {
  SCORE_FREEZE_AT, ScoreAutomationRunner, automationCheckpointSchema,
  type AutomationStatus, type ScoreAutomationPorts,
} from "../src/score-automation-runner.js";
import type { AutomationArtifact } from "../src/score-automation-storage.js";

function fixture() {
  let now = Date.parse("2026-09-19T16:00:00Z");
  let frozen = false;
  let activeCalls = 0;
  let admissionError: Error | undefined;
  let progressError: Error | undefined;
  let failStateWrite = false;
  const posts: { lane: "scored" | "practice"; problemId: string; caseId: string | null }[] = [];
  const store = new Map<AutomationArtifact, unknown>();
  const savedRuns: ProsperRun[] = [];
  const statuses: AutomationStatus[] = [];
  const problems: PublishedProblem[] = [{ id: "alpha", number: 7, title: "Synthetic problem", weight: 3, examples: 2 }];
  const publicCases = new Map([["alpha", ["public-a", "public-b"]]]);
  const progress: TeamProgress = {
    team_id: "team-synthetic", generated_at: new Date(now).toISOString(),
    stats: { best_points: 0, rank: null }, progress: [],
    eligibility: { active_run: false, withdrawn: false, public_wait: 0, private_wait: 0 },
  };
  const baseline: ProsperRun = {
    id: "older-run", team_id: progress.team_id, problem_id: "alpha", mode: "scored", status: "completed",
    endpoint: "wss://voice.example/ws",
    created_at: new Date(now - 4_000_000).toISOString(),
    started_at: new Date(now - 4_000_000).toISOString(),
    finished_at: new Date(now - 3_600_000).toISOString(),
    cases: [{ call_id: "older-call", passed: true, attribution: "none", signal_codes: [] }],
  };
  const runs = new Map([[baseline.id, baseline]]);
  const admit = async (lane: "scored" | "practice", problemId: string, caseId: string | null) => {
    const journal = store.get("admission");
    assert.ok(journal && typeof journal === "object" && "status" in journal && journal.status === "pending");
    posts.push({ lane, problemId, caseId });
    if (admissionError) throw admissionError;
    const id = `new-run-${posts.length}`;
    runs.set(id, {
      ...baseline, id, mode: lane, problem_id: problemId, status: "running", cases: [],
      created_at: new Date(now).toISOString(), started_at: new Date(now).toISOString(), finished_at: null,
    });
    progress.eligibility.active_run = true;
    return { id };
  };
  const ports: ScoreAutomationPorts = {
    teamId: progress.team_id,
    dashboard: {
      problems: async () => structuredClone(problems),
      publicCases: async (id) => structuredClone(publicCases.get(id) ?? []),
      progress: async () => {
        if (progressError) throw progressError;
        return { ...structuredClone(progress), generated_at: new Date(now).toISOString() };
      },
      board: async () => ({ generated_at: new Date(now).toISOString(), frozen }),
    },
    runs: {
      list: async () => structuredClone([...runs.values()]),
      get: async (id) => {
        const run = runs.get(id);
        if (!run) throw new AppError("test_unknown_run");
        return structuredClone(run);
      },
      startScored: (problemId) => admit("scored", problemId, null),
      startPractice: (problemId, caseId) => admit("practice", problemId, caseId),
    },
    read: (name) => structuredClone(store.get(name)),
    write: (name, value) => {
      if (name === "state" && failStateWrite && automationCheckpointSchema.parse(value).planner.trackedRun) {
        failStateWrite = false;
        throw new AppError("test_disk_full");
      }
      store.set(name, structuredClone(value));
    },
    saveRun: (run) => { savedRuns.push(structuredClone(run)); },
    health: async () => ({ activeCalls }),
    now: () => now,
    report: (status) => { statuses.push(status); },
  };
  return {
    ports, store, posts, runs, progress, problems, publicCases, savedRuns, statuses,
    advance(ms = 10_000) {
      now += ms;
      progress.eligibility.private_wait = Math.max(0, progress.eligibility.private_wait - ms / 1000);
      progress.eligibility.public_wait = Math.max(0, progress.eligibility.public_wait - ms / 1000);
    },
    freeze: () => { frozen = true; },
    activeCalls: (value: number) => { activeCalls = value; },
    admissionError: (value: Error | undefined) => { admissionError = value; },
    progressError: (value: Error | undefined) => { progressError = value; },
    failStateWrite: () => { failStateWrite = true; },
    finish(id: string, passed: boolean | null, status: ProsperRun["status"] = "completed") {
      const run = runs.get(id)!;
      runs.set(id, {
        ...run, status, finished_at: new Date(now).toISOString(),
        cases: [{ call_id: `${id}-call`, passed, attribution: passed ? "none" : "agent_issue", signal_codes: [] }],
      });
      progress.eligibility.active_run = false;
      progress.eligibility[run.mode === "scored" ? "private_wait" : "public_wait"] = run.mode === "scored" ? 300 : 30;
    },
    tick: (runner: ScoreAutomationRunner) => runner.tick(new AbortController().signal),
  };
}

test("admission journals before POST, follows published weights and never repeats an active run", async () => {
  const f = fixture();
  f.problems.push({ id: "beta", number: 8, title: "Higher weight", weight: 4, examples: 0 });
  const runner = new ScoreAutomationRunner(f.ports);
  const admitted = await f.tick(runner);
  assert.equal(admitted.status.event, "admitted");
  assert.deepEqual(f.posts, [{ lane: "scored", problemId: "beta", caseId: null }]);
  assert.equal(automationCheckpointSchema.parse(f.store.get("state")).receipts.length, 1);
  f.advance();
  assert.equal((await f.tick(runner)).status.reason, "tracked_run");
  assert.equal(f.posts.length, 1);
});

test("dashboard waits are seconds, global scored cooldown is five minutes after finish", async () => {
  const f = fixture();
  f.progress.eligibility.private_wait = 12;
  const runner = new ScoreAutomationRunner(f.ports);
  assert.equal((await f.tick(runner)).waitMs, 12_000);
  assert.equal(f.posts.length, 0);
  f.advance(12_000);
  assert.equal((await f.tick(runner)).status.event, "admitted");
  f.advance(120_000);
  f.finish("new-run-1", true);
  assert.equal((await f.tick(runner)).status.reason, "refresh");
  f.advance(299_000);
  assert.equal((await f.tick(runner)).waitMs, 1000);
  assert.equal(f.posts.length, 1);
  f.advance(1000);
  assert.equal((await f.tick(runner)).status.event, "admitted");
  assert.equal(f.posts.length, 2);
});

test("stale dashboard eligibility cannot bypass an active API run or its scored cooldown", async () => {
  const f = fixture();
  f.runs.set("external", { ...f.runs.get("older-run")!, id: "external", status: "running", finished_at: null });
  const runner = new ScoreAutomationRunner(f.ports);
  assert.equal((await f.tick(runner)).status.reason, "active_run");
  assert.equal(f.posts.length, 0);
  f.runs.set("external", {
    ...f.runs.get("external")!, status: "completed", finished_at: new Date(f.ports.now()).toISOString(),
  });
  assert.equal((await f.tick(runner)).status.reason, "cooldown");
  assert.equal(f.posts.length, 0);
});

test("capped problems and an occupied local voice session never consume a scored call", async () => {
  const f = fixture();
  f.progress.progress.push({ problem_id: "alpha", passed: 9, credited: 4, credited_of: 4 });
  const runner = new ScoreAutomationRunner(f.ports);
  assert.equal((await f.tick(runner)).status.event, "idle");
  f.progress.progress[0]!.credited = 3;
  f.activeCalls(1);
  assert.equal((await f.tick(runner)).status.reason, "local_call_active");
  assert.equal(f.posts.length, 0);
});

test("a scored failure runs every public case once before review, then explicitly retries the reviewed category", async () => {
  const f = fixture();
  let runner = new ScoreAutomationRunner(f.ports);
  await f.tick(runner);
  f.advance();
  f.finish("new-run-1", false);
  assert.equal((await f.tick(runner)).status.reason, "refresh");
  f.advance();
  assert.equal((await f.tick(runner)).status.event, "admitted");
  assert.deepEqual(f.posts[1], { lane: "practice", problemId: "alpha", caseId: "public-a" });
  f.advance();
  f.finish("new-run-2", false);
  assert.equal((await f.tick(runner)).status.reason, "refresh");
  runner = new ScoreAutomationRunner(f.ports);
  f.advance(10_000);
  assert.equal((await f.tick(runner)).waitMs, 20_000);
  f.advance(20_000);
  await f.tick(runner);
  assert.deepEqual(f.posts[2], { lane: "practice", problemId: "alpha", caseId: "public-b" });
  f.advance();
  f.finish("new-run-3", true);
  const review = await f.tick(runner);
  assert.equal(review.stop, true);
  assert.equal(review.status.event, "review_required");
  const manifest = f.store.get("review");
  assert.ok(manifest && typeof manifest === "object" && "runs" in manifest && Array.isArray(manifest.runs));
  assert.deepEqual(manifest.runs.map((run) => run.caseId), [null, "public-a", "public-b"]);
  assert.deepEqual(manifest.runs.map((run) => run.counts.failed), [1, 1, 0]);
  assert.equal(f.posts.length, 3);
  await f.tick(new ScoreAutomationRunner(f.ports));
  assert.equal(f.posts.length, 3);
  assert.throws(() => runner.approveReview({
    failureRunId: "other-failure", revision: "123abcd", outcome: "no_local_change", reviewedAt: new Date(f.ports.now()).toISOString(),
  }), { code: "score_automation_review_mismatch" });
  runner.approveReview({
    failureRunId: "new-run-1", revision: "123abcd", outcome: "no_local_change", reviewedAt: new Date(f.ports.now()).toISOString(),
  });
  f.problems.push({ id: "beta", number: 8, title: "New higher weight problem", weight: 5, examples: 0 });
  f.advance(300_000);
  await f.tick(runner);
  assert.deepEqual(f.posts[3], { lane: "scored", problemId: "alpha", caseId: null });
  assert.equal(automationCheckpointSchema.parse(f.store.get("state")).reviews.length, 1);
});

test("unknown POST delivery stays blocked across restart instead of retrying the admission", async () => {
  const f = fixture();
  f.admissionError(new AppError("prosper_run_admission_unknown"));
  await assert.rejects(f.tick(new ScoreAutomationRunner(f.ports)), { code: "prosper_run_admission_unknown" });
  f.admissionError(undefined);
  await assert.rejects(f.tick(new ScoreAutomationRunner(f.ports)), { code: "automation_admission_unknown" });
  assert.equal(f.posts.length, 1);
});

test("a received run ID survives a crash before state persistence without a second POST", async () => {
  const f = fixture();
  const runner = new ScoreAutomationRunner(f.ports);
  f.failStateWrite();
  await assert.rejects(f.tick(runner), { code: "test_disk_full" });
  const recovered = new ScoreAutomationRunner(f.ports);
  assert.equal((await f.tick(recovered)).status.reason, "tracked_run");
  assert.equal(f.posts.length, 1);
  assert.equal(automationCheckpointSchema.parse(f.store.get("state")).planner.trackedRun?.id, "new-run-1");
});

test("a definite busy rejection waits and refreshes instead of blocking on uncertain admission", async () => {
  const f = fixture();
  f.admissionError(new RunApiError(429, 17_000));
  const runner = new ScoreAutomationRunner(f.ports);
  assert.equal((await f.tick(runner)).waitMs, 17_000);
  f.admissionError(undefined);
  f.advance(17_000);
  assert.equal((await f.tick(runner)).status.event, "admitted");
  assert.equal(f.runs.size, 2);
});

test("progress errors, wrong API teams and invalid public rosters never become empty successful data", async () => {
  const f = fixture();
  const runner = new ScoreAutomationRunner(f.ports);
  f.progressError(new AppError("dashboard_invalid_progress"));
  await assert.rejects(f.tick(runner), { code: "dashboard_invalid_progress" });
  f.progressError(undefined);
  f.runs.get("older-run")!.team_id = "other-team";
  await assert.rejects(f.tick(runner), { code: "automation_team_mismatch" });
  assert.equal(f.posts.length, 0);
  f.runs.get("older-run")!.team_id = f.ports.teamId;
  await f.tick(runner);
  f.advance();
  f.finish("new-run-1", false);
  f.publicCases.set("alpha", []);
  await assert.rejects(f.tick(runner), { code: "automation_case_roster_changed" });
  assert.equal(f.posts.length, 1);
});

test("cancelled remote runs pause permanently and are never silently replaced", async () => {
  const f = fixture();
  const runner = new ScoreAutomationRunner(f.ports);
  await f.tick(runner);
  f.advance();
  f.finish("new-run-1", null, "cancelled");
  assert.equal((await f.tick(runner)).status.reason, "remote_cancelled");
  f.advance(360_000);
  assert.equal((await f.tick(new ScoreAutomationRunner(f.ports))).status.event, "paused");
  assert.equal(f.posts.length, 1);
});

test("freeze flags, the documented deadline and withdrawal stop new admissions", async () => {
  for (const reason of ["flag", "deadline", "withdrawn"]) {
    const f = fixture();
    if (reason === "flag") f.freeze();
    if (reason === "deadline") f.advance(SCORE_FREEZE_AT - f.ports.now());
    if (reason === "withdrawn") f.progress.eligibility.withdrawn = true;
    const result = await f.tick(new ScoreAutomationRunner(f.ports));
    assert.equal(result.stop, true);
    assert.equal(result.status.event, reason === "withdrawn" ? "paused" : "complete");
    assert.equal(f.posts.length, 0);
  }
});

test("terminal missing results reach diagnostic review, never fabricated PASS or points", async () => {
  const f = fixture();
  const runner = new ScoreAutomationRunner(f.ports);
  await f.tick(runner);
  f.advance();
  f.finish("new-run-1", null, "failed");
  f.runs.get("new-run-1")!.cases = [];
  await f.tick(runner);
  const state = automationCheckpointSchema.parse(f.store.get("state"));
  assert.equal(state.planner.phase, "diagnostics");
  assert.deepEqual(state.planner.failure?.unresolvedRunIds, ["new-run-1"]);
  assert.equal(f.progress.stats.best_points, 0);
});

test("CLI validates review arguments before credentials and status is read-only", (t) => {
  const directory = resolve(".local", `automation-cli-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = resolve("scripts/prosper-auto.ts");
  for (const args of [["resume"], ["run-all"], ["run", "--revision", "123abcd"]]) {
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), script, ...args], {
      cwd: directory, env: {}, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /invalid_automation_(command|review)/);
  }
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), script, "status"], {
    cwd: directory, env: {}, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: null, state: null, review: null });
});

test("CLI freezes safely with synthetic authenticated responses and private persistent state", (t) => {
  const directory = resolve(".local", `automation-cli-${randomUUID()}`);
  const local = resolve(directory, ".local");
  mkdirSync(local, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(resolve(local, "prosper-dashboard-session.json"), JSON.stringify({
    origin: "https://prosper.example", team_id: "team-synthetic",
    cookie: "session=synthetic-secret", created_at: "2026-09-19T15:00:00Z",
  }), { mode: 0o600 });
  const mock = resolve(directory, "fetch.mjs");
  writeFileSync(mock, `
    import assert from 'node:assert/strict';
    globalThis.fetch = async (input, init) => {
      assert.equal(init.method,'GET');
      const path = new URL(input).pathname;
      const stamp = '2026-09-19T16:00:00Z';
      if (path.endsWith('/problems')) return Response.json({problems:[]});
      if (path.endsWith('/board')) return Response.json({generated_at:stamp,frozen:true,entries:[]});
      assert.equal(path,'/leaderboard/api/teams/team-synthetic');
      return Response.json({team_id:'team-synthetic',generated_at:stamp,stats:{best_points:0,rank:null},
        progress:[],eligibility:{active_run:false,withdrawn:false,public_wait:0,private_wait:0}});
    };
  `, { mode: 0o600 });
  const result = spawnSync(process.execPath, [
    "--import", mock, "--import", import.meta.resolve("tsx"), resolve("scripts/prosper-auto.ts"), "run",
  ], {
    cwd: directory, encoding: "utf8", timeout: 15_000,
    env: {
      AZURE_OPENAI_ENDPOINT: "https://synthetic.openai.azure.com", PROSPER_API_BASE_URL: "https://prosper.example",
      PROSPER_API_KEY: "synthetic-api-secret", VOICE_ENDPOINT_TOKEN: "synthetic-token-with-at-least-32-characters",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!(result.stdout + result.stderr).includes("synthetic-secret"));
  const status = JSON.parse(readFileSync(resolve(local, "score-automation/status.json"), "utf8"));
  assert.equal(status.event, "complete");
  assert.equal(status.reason, "frozen");
  assert.equal(statSync(resolve(local, "score-automation/state.json")).mode & 0o777, 0o600);
});
