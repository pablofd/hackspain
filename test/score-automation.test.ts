import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/errors.js";
import type { ProsperRun, ProsperRunCase } from "../src/prosper-runs.js";
import {
  createScoreAutomationState, planScoreAutomation, recordScoreAdmission, resumeScoreAutomation,
  scoreAutomationSnapshotSchema, scoreAutomationStateSchema, seedScoreAutomationFailure,
  type ScoreAdmission, type ScoreAutomationSnapshot, type ScoreAutomationState,
} from "../src/score-automation.js";

const now = Date.parse("2026-09-19T15:00:00Z");
const problem = (id = "rules", number = 6, weight = 3, publicCaseIds = ["public-a", "public-b", "public-c"]) =>
  ({ id, number, title: `Synthetic ${id}`, weight, publicCaseIds });
const snapshot = (overrides: Partial<ScoreAutomationSnapshot> = {}): ScoreAutomationSnapshot => ({
  now, openProblems: [problem()], progress: [],
  eligibility: { activeRun: false, scoredWaitMs: 0, practiceWaitMs: 0, withdrawn: false },
  frozen: false, ...overrides,
});
const runCase = (overrides: Partial<ProsperRunCase> = {}): ProsperRunCase => ({
  call_id: "synthetic-call", passed: true, attribution: "none", signal_codes: [], ...overrides,
});
const run = (overrides: Partial<ProsperRun> = {}): ProsperRun => ({
  id: "score-1", team_id: "synthetic-team", problem_id: "rules", mode: "scored", status: "completed",
  endpoint: "wss://synthetic.example/ws", created_at: new Date(now - 60_000).toISOString(),
  started_at: new Date(now - 50_000).toISOString(), finished_at: new Date(now).toISOString(),
  cases: [runCase()], ...overrides,
});
const restore = (state: ScoreAutomationState) => scoreAutomationStateSchema.parse(JSON.parse(JSON.stringify(state)));
function admit(state = createScoreAutomationState(), current = snapshot(), id = "score-1") {
  const planned = planScoreAutomation(state, current);
  assert.equal(planned.decision.kind, "admit");
  const admission = planned.decision as ScoreAdmission;
  return { admission, state: recordScoreAdmission(planned.state, admission, id) };
}
function failedScore(publicCaseIds = ["public-a", "public-b", "public-c"], cases = [runCase({ passed: false })]) {
  const initial = snapshot({ openProblems: [problem("rules", 6, 3, publicCaseIds)] });
  const admitted = admit(createScoreAutomationState(), initial).state;
  return planScoreAutomation(admitted, { ...initial, trackedRun: run({ cases }) });
}
function reviewedRetry() {
  const failed = failedScore(["public-a"]);
  const practice = admit(failed.state, snapshot({ now: now + 1 }), "practice-a").state;
  const completed = planScoreAutomation(practice, snapshot({
    now: now + 2, trackedRun: run({ id: "practice-a", mode: "practice" }),
  }));
  return resumeScoreAutomation(completed.state, "score-1");
}

test("only explicit seed imports a selected scored failure, independently of the next scoring priority", () => {
  const state = createScoreAutomationState();
  const current = snapshot({
    openProblems: [problem("higher", 18, 5), problem()],
    trackedRun: run({ id: "manual-score", cases: [runCase({ passed: false })] }),
  });
  assert.throws(() => planScoreAutomation(state, current), { code: "score_automation_run_id_mismatch" });
  assert.throws(() => seedScoreAutomationFailure(state, current, "another-score"),
    { code: "score_automation_run_id_mismatch" });
  const seeded = seedScoreAutomationFailure(state, current, "manual-score");
  assert.equal(seeded.phase, "diagnostics");
  assert.deepEqual(seeded.trackedRun,
    { id: "manual-score", lane: "scored", problemId: "rules", caseId: null, settled: true });
  assert.deepEqual(seeded.failure, {
    problemId: "rules", scoreFailureRunId: "manual-score", publicCaseIds: ["public-a", "public-b", "public-c"],
    diagnosticRunIds: [], unresolvedRunIds: [], reviewReason: null, reviewed: false,
  });
  assert.deepEqual(planScoreAutomation(seeded, current).decision, { kind: "wait", reason: "refresh", waitMs: null });
  assert.deepEqual(planScoreAutomation(seeded, { ...current, now: now + 1 }).decision,
    { kind: "admit", lane: "practice", problemId: "rules", caseId: "public-a" });
  assert.deepEqual(state, createScoreAutomationState());
  assert.ok(scoreAutomationStateSchema.safeParse(seeded).success);
  assert.doesNotMatch(JSON.stringify(seeded), /synthetic-team|synthetic-call|endpoint/);
});

test("seed replays preserve public progress, active tracking, review and the single approved retry", () => {
  const current = snapshot({
    openProblems: [problem("rules", 6, 3, ["public-a", "public-b"])],
    trackedRun: run({ id: "manual-score", cases: [runCase({ passed: false })] }),
  });
  let state = seedScoreAutomationFailure(createScoreAutomationState(), current, "manual-score");
  const replay = (saved: ScoreAutomationState) =>
    assert.deepEqual(seedScoreAutomationFailure(restore(saved), current, "manual-score"), saved);
  replay(state);
  for (const [index, caseId] of ["public-a", "public-b"].entries()) {
    const admitted = admit(state, snapshot({ now: now + 1 + index * 30_000 }), `practice-${caseId}`);
    assert.equal(admitted.admission.caseId, caseId);
    replay(admitted.state);
    state = planScoreAutomation(admitted.state, snapshot({
      now: now + 2 + index * 30_000,
      trackedRun: run({ id: `practice-${caseId}`, mode: "practice" }),
    })).state;
    replay(state);
  }
  assert.equal(state.phase, "review");
  assert.deepEqual(state.failure?.diagnosticRunIds, ["practice-public-a", "practice-public-b"]);
  state = resumeScoreAutomation(state, "manual-score");
  replay(state);
  const retry = admit(state, snapshot({ now: now + 300_000 }), "retry-score");
  replay(retry.state);
  assert.equal(retry.state.retryProblemId, null);
});

test("seed requires a terminal non-cancelled scored failure with an identified problem", () => {
  const failure = run({ id: "manual-score", cases: [runCase({ passed: false })] });
  const state = createScoreAutomationState();
  assert.throws(() => seedScoreAutomationFailure(state, snapshot(), "manual-score"),
    { code: "score_automation_seed_run_required" });
  assert.throws(() => seedScoreAutomationFailure(state, snapshot({ trackedRun: failure }), "../invalid"),
    { code: "score_automation_invalid_run_id" });
  for (const [observed, code] of [
    [{ ...failure, mode: "practice" }, "score_automation_run_lane_mismatch"],
    [{ ...failure, status: "queued", finished_at: null }, "score_automation_seed_not_terminal"],
    [{ ...failure, status: "running", finished_at: null }, "score_automation_seed_not_terminal"],
    [{ ...failure, status: "cancelled" }, "score_automation_seed_cancelled"],
    [{ ...failure, status: "canceled" }, "score_automation_seed_cancelled"],
    [{ ...failure, problem_id: null }, "score_automation_seed_invalid_problem"],
    [{ ...failure, problem_id: "switchboard" }, "score_automation_seed_invalid_problem"],
    [{ ...failure, cases: [runCase({ signal_codes: ["wall_clock"], attribution: "agent_issue" })] },
      "score_automation_seed_passed"],
    [{ ...failure, status: "failed", cases: [runCase()] }, "score_automation_seed_passed"],
  ] satisfies [ProsperRun, string][]) {
    assert.throws(() => seedScoreAutomationFailure(state, snapshot({ trackedRun: observed }), "manual-score"), { code });
  }
  const { problem_id: _problem, ...missingProblem } = failure;
  assert.throws(() => seedScoreAutomationFailure(state, snapshot({ trackedRun: missingProblem }), "manual-score"),
    { code: "score_automation_seed_invalid_problem" });
  assert.deepEqual(state, createScoreAutomationState());
});

test("seed never overwrites existing work or unpauses a stopped automation", () => {
  const current = snapshot({ trackedRun: run({ id: "manual-score", cases: [runCase({ passed: false })] }) });
  const active = admit().state;
  const settled = planScoreAutomation(active, snapshot({ trackedRun: run() })).state;
  for (const state of [
    active, settled, failedScore().state, reviewedRetry(),
    planScoreAutomation(createScoreAutomationState(), snapshot({ frozen: true })).state,
    planScoreAutomation(createScoreAutomationState(), snapshot({
      eligibility: { ...snapshot().eligibility, withdrawn: true },
    })).state,
  ]) {
    assert.throws(() => seedScoreAutomationFailure(state, current, "manual-score"),
      { code: "score_automation_seed_state_not_empty" });
  }
  const seeded = seedScoreAutomationFailure(createScoreAutomationState(), current, "manual-score");
  assert.throws(() => seedScoreAutomationFailure(seeded, {
    ...current, trackedRun: { ...current.trackedRun!, problem_id: "other" },
  }, "manual-score"), { code: "score_automation_run_problem_mismatch" });
  const frozen = planScoreAutomation(seeded, snapshot({ frozen: true })).state;
  assert.deepEqual(seedScoreAutomationFailure(frozen, current, "manual-score"), frozen);
});

test("unresolved seeds retain that evidence through the public batch and missing examples require review", () => {
  for (const cases of [
    [], [runCase({ passed: null })], [runCase({ passed: false, attribution: "harness_issue" })],
    [runCase({ passed: false, attribution: "mixed" })], [runCase(), runCase()],
  ]) {
    const current = snapshot({
      openProblems: [problem("rules", 6, 3, ["public-a"])],
      trackedRun: run({ id: "manual-score", status: "failed", cases }),
    });
    const seeded = seedScoreAutomationFailure(createScoreAutomationState(), current, "manual-score");
    assert.deepEqual(seeded.failure?.unresolvedRunIds, ["manual-score"]);
    const admitted = admit(seeded, snapshot({ now: now + 1 }), "practice-a");
    const completed = planScoreAutomation(admitted.state, snapshot({
      now: now + 2, trackedRun: run({ id: "practice-a", mode: "practice" }),
    }));
    assert.deepEqual(completed.decision, { kind: "review_required", reason: "unresolved_results" });
  }
  for (const openProblems of [[problem("rules", 6, 3, [])], []]) {
    const seeded = seedScoreAutomationFailure(createScoreAutomationState(), snapshot({
      openProblems, trackedRun: run({ id: "manual-score", cases: [runCase({ passed: false })] }),
    }), "manual-score");
    assert.equal(seeded.phase, "review");
    assert.equal(seeded.failure?.reviewReason, openProblems.length ? "no_public_cases" : "problem_unavailable");
    assert.deepEqual(seeded.failure?.diagnosticRunIds, []);
  }
});

test("seed cannot bypass freeze, withdrawal, an external active slot or practice cooldown", () => {
  const terminal = run({ id: "manual-score", cases: [runCase({ passed: false })] });
  for (const [current, expected] of [
    [snapshot({ frozen: true }), { kind: "complete", reason: "frozen" }],
    [snapshot({ eligibility: { ...snapshot().eligibility, withdrawn: true } }), { kind: "paused", reason: "withdrawn" }],
    [snapshot({ eligibility: { ...snapshot().eligibility, activeRun: true } }),
      { kind: "wait", reason: "active_run", waitMs: null }],
    [snapshot({ eligibility: { ...snapshot().eligibility, practiceWaitMs: 30_000, scoredWaitMs: 300_000 } }),
      { kind: "wait", reason: "cooldown", waitMs: 30_000 }],
  ] as const) {
    const seeded = seedScoreAutomationFailure(createScoreAutomationState(), { ...current, trackedRun: terminal }, "manual-score");
    assert.deepEqual(planScoreAutomation(seeded, { ...current, now: now + 1 }).decision, expected);
    assert.ok(scoreAutomationStateSchema.safeParse(seeded).success);
  }
});

test("selection uses published weighted problems, remaining credit, then number and stable ID", () => {
  const state = createScoreAutomationState();
  const current = snapshot({
    openProblems: [
      problem("later", 15, 4), problem("switchboard", 2, 5), problem("full", 18, 5),
      problem("zero", 1, 0), problem("earlier", 9, 4), problem("cheap", 3, 1),
    ],
    progress: [{ problemId: "full", credited: 4, cap: 4 }, { problemId: "closed", credited: 0, cap: 4 }],
  });
  assert.deepEqual(planScoreAutomation(state, current), {
    state, decision: { kind: "admit", lane: "scored", problemId: "earlier", caseId: null },
  });
  const reordered = { ...current, openProblems: current.openProblems.slice().reverse() };
  assert.deepEqual(planScoreAutomation(state, reordered), planScoreAutomation(state, current));
  assert.equal(planScoreAutomation(state, snapshot({
    openProblems: [problem("b", 9, 3), problem("a", 9, 3)],
  })).decision.kind, "admit");
  assert.deepEqual(planScoreAutomation(state, snapshot({
    openProblems: [problem("b", 9, 3), problem("a", 9, 3)],
  })).decision, { kind: "admit", lane: "scored", problemId: "a", caseId: null });
});

test("empty, capped and unscored rosters idle without declaring the event complete", () => {
  for (const current of [
    snapshot({ openProblems: [] }),
    snapshot({ progress: [{ problemId: "rules", credited: 4, cap: 4 }] }),
    snapshot({ progress: [{ problemId: "rules", credited: 0, cap: 0 }] }),
    snapshot({ openProblems: [problem("switchboard", 2, 5), problem("unscored", 3, 0)] }),
  ]) {
    const planned = planScoreAutomation(createScoreAutomationState(), current);
    assert.deepEqual(planned.decision, { kind: "idle", reason: "no_eligible_problems" });
    assert.equal(planned.state.phase, "scoring");
    assert.equal(planScoreAutomation(planned.state, snapshot()).decision.kind, "admit");
  }
});

test("missing progress entries mean zero only within a valid authoritative snapshot", () => {
  assert.equal(planScoreAutomation(createScoreAutomationState(), snapshot()).decision.kind, "admit");
  const missing: unknown = { ...snapshot(), progress: undefined };
  for (const invalid of [
    missing, { ...snapshot(), progress: null },
    snapshot({ progress: [{ problemId: "rules", credited: 5, cap: 4 }] }),
    snapshot({ progress: [{ problemId: "rules", credited: 0, cap: 5 }] }),
    snapshot({ progress: [{ problemId: "rules", credited: 0, cap: 4 }, { problemId: "rules", credited: 4, cap: 4 }] }),
    snapshot({ openProblems: [problem(), problem()] }),
    snapshot({ openProblems: [problem("rules", 6, 3, ["public-a", "public-a"])] }),
    snapshot({ eligibility: { ...snapshot().eligibility, scoredWaitMs: -1 } }),
    snapshot({ eligibility: { ...snapshot().eligibility, practiceWaitMs: Infinity } }),
  ]) {
    assert.throws(() => planScoreAutomation(createScoreAutomationState(), invalid as ScoreAutomationSnapshot),
      { code: "score_automation_invalid_snapshot" });
  }
  assert.ok(scoreAutomationSnapshotSchema.safeParse(snapshot()).success);
});

test("five-minute scored cooldown is global, ends at the exact boundary and recalculates targets", () => {
  const state = createScoreAutomationState();
  for (const elapsed of [0, 60_000, 299_999]) {
    const planned = planScoreAutomation(state, snapshot({
      now: now + elapsed, openProblems: [problem("other", 18, 5)],
      eligibility: { ...snapshot().eligibility, scoredWaitMs: 300_000 - elapsed },
    }));
    assert.deepEqual(planned.decision, { kind: "wait", reason: "cooldown", waitMs: 300_000 - elapsed });
    assert.deepEqual(planned.state, state);
  }
  const changed = snapshot({
    now: now + 300_000, openProblems: [problem("other", 18, 5), problem("new", 12, 4)],
    progress: [{ problemId: "other", credited: 1, cap: 1 }],
  });
  assert.deepEqual(planScoreAutomation(state, changed).decision,
    { kind: "admit", lane: "scored", problemId: "new", caseId: null });
  assert.deepEqual(planScoreAutomation(state, { ...changed, openProblems: [] }).decision,
    { kind: "idle", reason: "no_eligible_problems" });
});

test("external active runs block both lanes without being adopted or cancelled", () => {
  for (const state of [createScoreAutomationState(), failedScore().state]) {
    const planned = planScoreAutomation(state, snapshot({
      now: now + 1, eligibility: { ...snapshot().eligibility, activeRun: true },
    }));
    assert.deepEqual(planned.decision, { kind: "wait", reason: "active_run", waitMs: null });
    assert.deepEqual(planned.state, state);
  }
  assert.throws(() => planScoreAutomation(createScoreAutomationState(), snapshot({ trackedRun: run() })),
    { code: "score_automation_run_id_mismatch" });
});

test("receipt is not completion and queued/running tracked runs block even stale eligibility", () => {
  const { state, admission } = admit();
  assert.equal(state.phase, "scoring");
  assert.equal(state.failure, null);
  assert.deepEqual(recordScoreAdmission(restore(state), admission, "score-1"), state);
  for (const status of ["queued", "running"] as const) {
    const planned = planScoreAutomation(state, snapshot({
      trackedRun: run({ status, finished_at: null, cases: [] }),
    }));
    assert.deepEqual(planned.decision, { kind: "wait", reason: "tracked_run", waitMs: null });
    assert.deepEqual(planned.state, state);
  }
  assert.equal(planScoreAutomation(state, snapshot()).decision.kind, "wait");
  assert.throws(() => recordScoreAdmission(state, admission, "score-2"), { code: "score_automation_run_already_active" });
});

test("PASS overrides wall_clock and requires fresh credits without inferring a private increment", () => {
  const state = admit().state;
  const terminal = snapshot({
    progress: [{ problemId: "rules", credited: 3, cap: 4 }],
    trackedRun: run({ cases: [runCase({ signal_codes: ["wall_clock"], attribution: "agent_issue" })] }),
  });
  const finished = planScoreAutomation(state, terminal);
  assert.deepEqual(finished.decision, { kind: "wait", reason: "refresh", waitMs: null });
  assert.equal(finished.state.failure, null);
  assert.equal(finished.state.trackedRun?.settled, true);
  assert.deepEqual(planScoreAutomation(restore(finished.state), terminal), finished);
  assert.deepEqual(planScoreAutomation(finished.state, snapshot()).decision, finished.decision);
  assert.equal(planScoreAutomation(finished.state, snapshot({
    now: now + 300_000, progress: [{ problemId: "rules", credited: 3, cap: 4 }],
  })).decision.kind, "admit");
  assert.equal(planScoreAutomation(finished.state, snapshot({
    now: now + 300_000, progress: [{ problemId: "rules", credited: 4, cap: 4 }],
  })).decision.kind, "idle");
});

test("scored FAIL runs every public case sequentially, reviews, then prioritizes exactly one retry", () => {
  const failed = failedScore();
  let state = restore(failed.state);
  assert.equal(state.phase, "diagnostics");
  assert.deepEqual(state.failure, {
    problemId: "rules", scoreFailureRunId: "score-1", publicCaseIds: ["public-a", "public-b", "public-c"],
    diagnosticRunIds: [], unresolvedRunIds: [], reviewed: false, reviewReason: null,
  });
  assert.deepEqual(failed.decision, { kind: "wait", reason: "refresh", waitMs: null });
  assert.throws(() => resumeScoreAutomation(state, "score-1"), { code: "score_automation_review_not_ready" });
  for (const [index, caseId] of ["public-a", "public-b", "public-c"].entries()) {
    const at = now + (index + 1) * 30_000;
    const current = snapshot({
      now: at, openProblems: [problem("higher", 18, 5), problem()],
      eligibility: { ...snapshot().eligibility, scoredWaitMs: 300_000 - (at - now) },
    });
    const { state: admitted, admission } = admit(state, current, `practice-${index}`);
    assert.deepEqual(admission, { kind: "admit", lane: "practice", problemId: "rules", caseId });
    assert.deepEqual(recordScoreAdmission(restore(admitted), admission, `practice-${index}`), admitted);
    const finishedSnapshot = {
      ...current,
      trackedRun: run({
        id: `practice-${index}`, mode: "practice", cases: [runCase({ passed: index !== 1 })],
      }),
    };
    const finished = planScoreAutomation(admitted, finishedSnapshot);
    state = restore(finished.state);
    assert.deepEqual(planScoreAutomation(state, finishedSnapshot), finished);
    assert.deepEqual(state.failure?.publicCaseIds, ["public-a", "public-b", "public-c"].slice(index + 1));
    assert.deepEqual(state.failure?.diagnosticRunIds,
      Array.from({ length: index + 1 }, (_, item) => `practice-${item}`));
    assert.equal(finished.decision.kind, index === 2 ? "review_required" : "wait");
  }
  assert.deepEqual(planScoreAutomation(state, snapshot({ now: now + 300_000 })).decision,
    { kind: "review_required", reason: "diagnostics_complete" });
  assert.throws(() => resumeScoreAutomation(state, "different-failure"), { code: "score_automation_review_mismatch" });
  state = resumeScoreAutomation(state, "score-1");
  assert.equal(state.retryProblemId, "rules");
  assert.deepEqual(resumeScoreAutomation(restore(state), "score-1"), state);
  const current = snapshot({ now: now + 300_000, openProblems: [problem("higher", 18, 5), problem()] });
  const retry = admit(state, current, "score-retry");
  assert.equal(retry.admission.problemId, "rules");
  assert.equal(retry.state.retryProblemId, null);
  assert.deepEqual(resumeScoreAutomation(restore(retry.state), "score-1"), retry.state);
  const success = planScoreAutomation(retry.state, {
    ...current, trackedRun: run({ id: "score-retry" }),
  }).state;
  assert.deepEqual(resumeScoreAutomation(success, "score-1"), success);
  assert.deepEqual(planScoreAutomation(success, { ...current, now: current.now + 300_000 }).decision,
    { kind: "admit", lane: "scored", problemId: "higher", caseId: null });
});

test("practice waits thirty seconds, independent of scored cooldown, and cannot bypass the shared slot", () => {
  const state = failedScore().state;
  for (const elapsed of [1, 10_000, 29_999]) {
    assert.deepEqual(planScoreAutomation(state, snapshot({
      now: now + elapsed,
      eligibility: { ...snapshot().eligibility, scoredWaitMs: 300_000 - elapsed, practiceWaitMs: 30_000 - elapsed },
    })).decision, { kind: "wait", reason: "cooldown", waitMs: 30_000 - elapsed });
  }
  const current = snapshot({
    now: now + 30_000, eligibility: { ...snapshot().eligibility, scoredWaitMs: 270_000 },
  });
  assert.deepEqual(planScoreAutomation(state, current).decision,
    { kind: "admit", lane: "practice", problemId: "rules", caseId: "public-a" });
  assert.equal(planScoreAutomation(state, {
    ...current, eligibility: { ...current.eligibility, activeRun: true },
  }).decision.kind, "wait");
});

test("a reviewed retry rechecks publication and cap after cooldown rather than using a stale selection", () => {
  const state = reviewedRetry();
  const current = snapshot({
    now: now + 100_000, openProblems: [problem(), problem("other", 18, 5)],
    eligibility: { ...snapshot().eligibility, scoredWaitMs: 200_000 },
  });
  assert.equal(planScoreAutomation(state, current).decision.kind, "wait");
  for (const updated of [
    { ...current, openProblems: [problem("other", 18, 5)] },
    { ...current, progress: [{ problemId: "rules", credited: 4, cap: 4 }] },
    { ...current, progress: [{ problemId: "rules", credited: 1, cap: 1 }] },
    { ...current, openProblems: [problem("rules", 6, 0), problem("other", 18, 5)] },
  ]) {
    const next = admit(state, { ...updated, now: now + 300_000, eligibility: snapshot().eligibility }, "other-score");
    assert.equal(next.admission.problemId, "other");
    assert.equal(next.state.retryProblemId, null);
    assert.deepEqual(resumeScoreAutomation(next.state, "score-1"), next.state);
  }
});

test("terminal failures without a useful verdict and VOID stay unresolved and still collect public evidence", () => {
  for (const cases of [
    [], [runCase({ passed: null })],
    [runCase({ passed: false, attribution: "harness_issue" })],
    [runCase({ passed: false, attribution: "mixed" })],
    [runCase(), runCase()],
  ]) {
    const state = admit().state;
    const failed = planScoreAutomation(state, snapshot({
      trackedRun: run({ status: "failed", cases }),
    }));
    assert.equal(failed.state.phase, "diagnostics");
    assert.deepEqual(failed.state.failure?.unresolvedRunIds, ["score-1"]);
    assert.deepEqual(failed.state.failure?.publicCaseIds, ["public-a", "public-b", "public-c"]);
    assert.equal(failed.state.retryProblemId, null);
  }
  const terminalFailure = failedScore(["public-a"], [runCase({ passed: false, attribution: "agent_issue" })]);
  assert.deepEqual(terminalFailure.state.failure?.unresolvedRunIds, []);
});

test("empty or VOID public results are retained as unresolved, never retried or labelled diagnostic success", () => {
  for (const cases of [[], [runCase({ passed: null })], [runCase({ passed: false, attribution: "mixed" })]]) {
    const failed = failedScore(["public-a", "public-b"]);
    const first = admit(failed.state, snapshot({ now: now + 1 }), "practice-a").state;
    const unresolved = planScoreAutomation(first, snapshot({
      now: now + 2, trackedRun: run({ id: "practice-a", mode: "practice", status: "failed", cases }),
    }));
    assert.deepEqual(unresolved.state.failure?.unresolvedRunIds, ["practice-a"]);
    assert.deepEqual(unresolved.state.failure?.publicCaseIds, ["public-b"]);
    assert.equal(unresolved.state.phase, "diagnostics");
    const second = admit(restore(unresolved.state), snapshot({ now: now + 30_002 }), "practice-b");
    assert.equal(second.admission.caseId, "public-b");
    const reviewed = planScoreAutomation(second.state, snapshot({
      now: now + 30_003, trackedRun: run({ id: "practice-b", mode: "practice" }),
    }));
    assert.deepEqual(reviewed.decision, { kind: "review_required", reason: "unresolved_results" });
    assert.deepEqual(reviewed.state.failure?.diagnosticRunIds, ["practice-a", "practice-b"]);
    assert.deepEqual(reviewed.state.failure?.unresolvedRunIds, ["practice-a"]);
  }
});

test("remote cancellation in either spelling/lane pauses permanently instead of spawning a chain", () => {
  for (const status of ["cancelled", "canceled"] as const) {
    for (const lane of ["scored", "practice"] as const) {
      const state = lane === "scored" ? admit().state
        : admit(failedScore().state, snapshot({ now: now + 1 }), "practice-a").state;
      const id = state.trackedRun!.id;
      const terminal = snapshot({
        now: now + 2, trackedRun: run({ id, mode: lane, status, cases: [] }),
      });
      const stopped = planScoreAutomation(state, terminal);
      assert.deepEqual(stopped.decision, { kind: "paused", reason: "remote_cancelled" });
      assert.deepEqual(planScoreAutomation(restore(stopped.state), terminal), stopped);
      assert.deepEqual(planScoreAutomation(stopped.state, snapshot({ now: now + 600_000 })).decision, stopped.decision);
      if (lane === "scored") assert.equal(stopped.state.failure, null);
      else {
        assert.deepEqual(stopped.state.failure?.diagnosticRunIds, ["practice-a"]);
        assert.throws(() => resumeScoreAutomation(stopped.state, "score-1"), { code: "score_automation_review_not_ready" });
      }
    }
  }
});

test("a cancellation observed after an earlier terminal response still blocks another admission", () => {
  const settled = planScoreAutomation(admit().state, snapshot({ trackedRun: run() })).state;
  const planned = planScoreAutomation(settled, snapshot({
    now: now + 300_000, trackedRun: run({ status: "cancelled", cases: [] }),
  }));
  assert.deepEqual(planned.decision, { kind: "paused", reason: "remote_cancelled" });
  assert.deepEqual(planScoreAutomation(planned.state, snapshot({ now: now + 600_000 })).decision, planned.decision);
});

test("missing public examples require explicit review with insufficient evidence", () => {
  const failed = failedScore([]);
  assert.deepEqual(failed.decision, { kind: "review_required", reason: "no_public_cases" });
  assert.deepEqual(failed.state.failure?.diagnosticRunIds, []);
  assert.deepEqual(failed.state.failure?.publicCaseIds, []);
  assert.equal(planScoreAutomation(failed.state, snapshot({ now: now + 300_000 })).decision.kind, "review_required");
  const resumed = resumeScoreAutomation(restore(failed.state), "score-1");
  assert.equal(planScoreAutomation(resumed, snapshot({ now: now + 300_000 })).decision.kind, "admit");
});

test("closed diagnostic problems or removed public cases block instead of admitting unpublished work", () => {
  const state = failedScore().state;
  for (const [openProblems, reason] of [
    [[], "problem_unavailable"],
    [[problem("rules", 6, 3, ["public-b"])], "public_case_unavailable"],
    [[problem("rules", 6, 0)], "problem_unavailable"],
  ] as const) {
    const planned = planScoreAutomation(state, snapshot({
      now: now + 30_000, openProblems: [...openProblems],
    }));
    assert.deepEqual(planned.decision, { kind: "review_required", reason });
    assert.deepEqual(planned.state.failure?.publicCaseIds, ["public-a", "public-b", "public-c"]);
  }
  const closedAtFinish = planScoreAutomation(admit().state, snapshot({
    openProblems: [], trackedRun: run({ cases: [runCase({ passed: false })] }),
  }));
  assert.deepEqual(closedAtFinish.decision, { kind: "review_required", reason: "problem_unavailable" });
});

test("run identity and mode mismatches error explicitly without adopting or advancing anything", () => {
  const state = admit().state;
  for (const [observed, code] of [
    [run({ id: "external" }), "score_automation_run_id_mismatch"],
    [run({ mode: "practice" }), "score_automation_run_lane_mismatch"],
    [run({ problem_id: "other" }), "score_automation_run_problem_mismatch"],
  ] as const) {
    assert.throws(() => planScoreAutomation(state, snapshot({ trackedRun: observed })),
      (error: unknown) => error instanceof AppError && error.code === code);
  }
  assert.equal(state.trackedRun?.settled, false);
  // The API permits an absent problem_id; the receipt ID and lane still must match.
  assert.equal(planScoreAutomation(state, snapshot({ trackedRun: run({ problem_id: null }) })).decision.kind, "wait");
  const settled = planScoreAutomation(state, snapshot({ trackedRun: run() })).state;
  assert.throws(() => planScoreAutomation(settled, snapshot({
    now: now + 1, trackedRun: run({ status: "running", finished_at: null }),
  })), { code: "score_automation_run_status_regressed" });
});

test("freeze and withdrawal stop admissions in all phases and cannot be undone by newer snapshots or review", () => {
  for (const state of [createScoreAutomationState(), admit().state, failedScore().state, failedScore([]).state, reviewedRetry()]) {
    for (const reason of ["frozen", "withdrawn"] as const) {
      const current = snapshot({
        now: now + 300_000, frozen: reason === "frozen",
        eligibility: { ...snapshot().eligibility, withdrawn: reason === "withdrawn" },
      });
      const stopped = planScoreAutomation(state, current);
      assert.deepEqual(stopped.decision, { kind: reason === "frozen" ? "complete" : "paused", reason });
      assert.deepEqual(planScoreAutomation(restore(stopped.state), snapshot({ now: now + 600_000 })), stopped);
      if (state.failure?.reviewed) {
        assert.deepEqual(resumeScoreAutomation(stopped.state, "score-1"), stopped.state);
      } else if (state.failure) {
        assert.throws(() => resumeScoreAutomation(stopped.state, "score-1"),
          { code: "score_automation_review_not_ready" });
      }
    }
  }
  const frozen = planScoreAutomation(admit().state, snapshot({ frozen: true })).state;
  const finished = planScoreAutomation(frozen, snapshot({
    now: now + 1, trackedRun: run({ cases: [runCase({ passed: false })] }),
  }));
  assert.equal(finished.state.trackedRun?.settled, true);
  assert.deepEqual(finished.decision, { kind: "complete", reason: "frozen" });
  assert.ok(scoreAutomationStateSchema.safeParse(finished.state).success);
});

test("admission safety holds for both lane waits, team activity, withdrawal and freeze", () => {
  for (const state of [createScoreAutomationState(), failedScore().state]) {
    for (const activeRun of [false, true]) {
      for (const withdrawn of [false, true]) {
        for (const frozen of [false, true]) {
          for (const scoredWaitMs of [0, 0.5, 300_000]) {
            for (const practiceWaitMs of [0, 0.5, 30_000]) {
              const current = snapshot({
                now: now + 1, frozen, eligibility: { activeRun, withdrawn, scoredWaitMs, practiceWaitMs },
              });
              const planned = planScoreAutomation(state, current);
              assert.ok(scoreAutomationStateSchema.safeParse(planned.state).success);
              const laneWait = state.phase === "scoring" ? scoredWaitMs : practiceWaitMs;
              assert.equal(planned.decision.kind === "admit", !activeRun && !withdrawn && !frozen && laneWait === 0);
            }
          }
        }
      }
    }
  }
});

test("serializable state is strict, private-data-free and rejects corrupt transitions", () => {
  const state = failedScore().state;
  assert.deepEqual(restore(state), state);
  for (const invalid of [
    { ...state, version: 2 },
    { ...state, phase: "scoring" },
    { ...state, phase: "review" },
    { ...state, failure: null },
    { ...state, retryProblemId: "rules" },
    { ...state, phase: "paused", stopReason: null },
    { ...state, transcript: "private content" },
    { ...state, failure: { ...state.failure, privateexpected: "private content" } },
    { ...state, trackedRun: { ...state.trackedRun, caseId: "public-a" } },
    { ...state, failure: { ...state.failure, unresolvedRunIds: ["unrelated-run"] } },
  ]) {
    assert.equal(scoreAutomationStateSchema.safeParse(invalid).success, false);
    assert.throws(() => planScoreAutomation(invalid as ScoreAutomationState, snapshot()),
      { code: "score_automation_invalid_state" });
  }
  const rawRun = {
    ...run({ cases: [runCase({ passed: false })] }), privateexpected: "private-content", transcript: "private-content",
  };
  const planned = planScoreAutomation(admit().state, snapshot({ trackedRun: rawRun }));
  assert.doesNotMatch(JSON.stringify(planned.state), /private-content|synthetic-call|synthetic-team|endpoint|cases/);
});

test("pure planning does not mutate inputs, persist selection, or depend on the wall clock", () => {
  const state = createScoreAutomationState();
  const current = snapshot({ openProblems: [problem("lower", 3, 1), problem()] });
  const originalState = JSON.stringify(state);
  const originalSnapshot = JSON.stringify(current);
  Object.freeze(state);
  Object.freeze(current.openProblems);
  Object.freeze(current.progress);
  Object.freeze(current.eligibility);
  Object.freeze(current);
  const first = planScoreAutomation(state, current);
  assert.deepEqual(planScoreAutomation(state, current), first);
  assert.equal(JSON.stringify(state), originalState);
  assert.equal(JSON.stringify(current), originalSnapshot);
  assert.equal(first.state.trackedRun, null);
});

test("replayed receipts, stale reviews and admissions outside the diagnostic head are rejected safely", () => {
  const failed = failedScore().state;
  const head = planScoreAutomation(failed, snapshot({ now: now + 1 })).decision as ScoreAdmission;
  assert.throws(() => recordScoreAdmission(failed, { ...head, caseId: "public-b" } as ScoreAdmission, "practice-b"),
    { code: "score_automation_admission_mismatch" });
  assert.throws(() => recordScoreAdmission(failed, {
    kind: "admit", lane: "scored", problemId: "rules", caseId: null,
  }, "score-2"), { code: "score_automation_admission_mismatch" });
  assert.throws(() => recordScoreAdmission(failed, head, "../invalid"), { code: "score_automation_invalid_run_id" });
  const first = recordScoreAdmission(failed, head, "practice-a");
  assert.throws(() => recordScoreAdmission(first, { ...head, problemId: "other" }, "practice-a"),
    { code: "score_automation_admission_mismatch" });
  const finished = planScoreAutomation(first, snapshot({
    now: now + 2, trackedRun: run({ id: "practice-a", mode: "practice" }),
  })).state;
  assert.deepEqual(recordScoreAdmission(restore(finished), head, "practice-a"), finished);
  const second = admit(finished, snapshot({ now: now + 30_002 }), "practice-b").state;
  const secondFinished = planScoreAutomation(second, snapshot({
    now: now + 30_003, trackedRun: run({ id: "practice-b", mode: "practice" }),
  })).state;
  assert.throws(() => recordScoreAdmission(secondFinished, head, "practice-a"),
    { code: "score_automation_run_already_recorded" });
  const retried = admit(reviewedRetry(), snapshot({ now: now + 300_000 }), "score-retry").state;
  const failedAgain = planScoreAutomation(retried, snapshot({
    now: now + 300_001, trackedRun: run({ id: "score-retry", cases: [runCase({ passed: false })] }),
  })).state;
  assert.equal(failedAgain.failure?.scoreFailureRunId, "score-retry");
  assert.deepEqual(failedAgain.failure?.diagnosticRunIds, []);
  assert.throws(() => resumeScoreAutomation(failedAgain, "score-1"), { code: "score_automation_review_mismatch" });
});
