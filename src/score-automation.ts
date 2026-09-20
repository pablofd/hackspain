import { z } from "zod";
import { AppError } from "./errors.js";
import { idSchema } from "./prosper-types.js";
import { caseVerdict, runFinished, runSchema, type ProsperRun } from "./prosper-runs.js";

const ids = z.array(idSchema).max(1000).refine((values) => new Set(values).size === values.length);
const timestamp = z.number().int().nonnegative();
const reviewReason = z.enum([
  "diagnostics_complete", "unresolved_results", "no_public_cases", "problem_unavailable", "public_case_unavailable",
]);
const trackingSchema = z.strictObject({
  id: idSchema,
  lane: z.enum(["scored", "practice"]),
  problemId: idSchema,
  caseId: idSchema.nullable(),
  settled: z.boolean(),
}).refine((run) => run.lane === "scored" ? run.caseId === null : run.caseId !== null);

export const scoreAutomationStateSchema = z.strictObject({
  version: z.literal(1),
  phase: z.enum(["scoring", "diagnostics", "review", "paused", "complete"]),
  trackedRun: trackingSchema.nullable(),
  failure: z.strictObject({
    problemId: idSchema,
    scoreFailureRunId: idSchema,
    publicCaseIds: ids,
    diagnosticRunIds: ids,
    unresolvedRunIds: ids,
    reviewReason: reviewReason.nullable(),
    reviewed: z.boolean(),
  }).nullable(),
  retryProblemId: idSchema.nullable(),
  refreshAfter: timestamp.nullable(),
  stopReason: z.enum(["frozen", "withdrawn", "remote_cancelled"]).nullable(),
}).superRefine((state, context) => {
  const { failure, trackedRun: run, phase } = state;
  const stopped = phase === "paused" || phase === "complete";
  const invalid = () => context.addIssue({ code: "custom", message: "Inconsistent automation state." });
  if (phase === "complete" ? state.stopReason !== "frozen" : phase === "paused"
    ? !["withdrawn", "remote_cancelled"].includes(state.stopReason ?? "") : state.stopReason !== null) invalid();
  if (phase === "diagnostics" && (!failure || failure.reviewed || !failure.publicCaseIds.length ||
    failure.reviewReason !== null)) invalid();
  if (phase === "review" && (!failure || failure.reviewed || failure.reviewReason === null)) invalid();
  if (phase === "scoring" && failure && !failure.reviewed) invalid();
  if (state.retryProblemId !== null && (!failure?.reviewed ||
    state.retryProblemId !== failure.problemId || !stopped && phase !== "scoring")) invalid();
  if (failure && (failure.diagnosticRunIds.includes(failure.scoreFailureRunId) ||
    failure.unresolvedRunIds.some((id) => id !== failure.scoreFailureRunId &&
      !failure.diagnosticRunIds.includes(id)))) invalid();
  if (run?.lane === "practice" && (!failure || run.problemId !== failure.problemId ||
    !failure.diagnosticRunIds.includes(run.id) ||
    !run.settled && (run.caseId !== failure.publicCaseIds[0] || !stopped && phase !== "diagnostics"))) invalid();
  if (run?.lane === "scored" && !run.settled && !stopped && phase !== "scoring") invalid();
});
export type ScoreAutomationState = z.infer<typeof scoreAutomationStateSchema>;

export const scoreAutomationSnapshotSchema = z.object({
  now: timestamp,
  openProblems: z.array(z.object({
    id: idSchema, number: z.number().int().positive(), title: z.string().min(1).max(500),
    weight: z.number().int().min(0).max(5), publicCaseIds: ids,
  })).max(100).refine((problems) => new Set(problems.map((problem) => problem.id)).size === problems.length),
  progress: z.array(z.object({
    problemId: idSchema, credited: z.number().int().min(0).max(4), cap: z.number().int().min(0).max(4),
  })).max(100).refine((progress) => new Set(progress.map((entry) => entry.problemId)).size === progress.length),
  eligibility: z.object({
    activeRun: z.boolean(), scoredWaitMs: z.number().nonnegative(), practiceWaitMs: z.number().nonnegative(),
    withdrawn: z.boolean(),
  }),
  frozen: z.boolean(),
  trackedRun: runSchema.optional(),
});
export type ScoreAutomationSnapshot = z.infer<typeof scoreAutomationSnapshotSchema>;

export const scoreAdmissionSchema = z.discriminatedUnion("lane", [
  z.strictObject({
    kind: z.literal("admit"), lane: z.literal("scored"),
    problemId: idSchema.refine((id) => id !== "switchboard"), caseId: z.null(),
  }),
  z.strictObject({
    kind: z.literal("admit"), lane: z.literal("practice"), problemId: idSchema, caseId: idSchema,
  }),
]);
export type ScoreAdmission = z.infer<typeof scoreAdmissionSchema>;
export type ScoreAutomationDecision =
  | ScoreAdmission
  | { kind: "wait"; reason: "tracked_run" | "active_run" | "cooldown" | "refresh"; waitMs: number | null }
  | { kind: "idle"; reason: "no_eligible_problems" }
  | { kind: "review_required"; reason: z.infer<typeof reviewReason> }
  | { kind: "paused" | "complete"; reason: NonNullable<ScoreAutomationState["stopReason"]> };

function checked<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(code);
  return result.data;
}

export function createScoreAutomationState(): ScoreAutomationState {
  return {
    version: 1, phase: "scoring", trackedRun: null, failure: null, retryProblemId: null,
    refreshAfter: null, stopReason: null,
  };
}

function published(snapshot: ScoreAutomationSnapshot, id: string) {
  return snapshot.openProblems.find((problem) => problem.id === id && problem.id !== "switchboard" && problem.weight > 0);
}

function singleCaseVerdict(run: ProsperRun): ReturnType<typeof caseVerdict> {
  // Each admission represents one case; missing or unexpected batches are unresolved.
  return run.cases.length === 1 ? caseVerdict(run.cases[0]!) : "PENDING";
}

function observeRun(state: ScoreAutomationState, run: ProsperRun, snapshot: ScoreAutomationSnapshot): ScoreAutomationState {
  const tracked = state.trackedRun;
  if (!tracked || tracked.id !== run.id) throw new AppError("score_automation_run_id_mismatch");
  if (tracked.lane !== run.mode) throw new AppError("score_automation_run_lane_mismatch");
  if (run.problem_id != null && tracked.problemId !== run.problem_id) {
    throw new AppError("score_automation_run_problem_mismatch");
  }
  if (tracked.settled) {
    if (!runFinished(run)) throw new AppError("score_automation_run_status_regressed");
    if ((run.status === "cancelled" || run.status === "canceled") &&
      state.phase !== "paused" && state.phase !== "complete") {
      return { ...state, phase: "paused", stopReason: "remote_cancelled" };
    }
    return state;
  }
  if (!runFinished(run)) return state;
  let next: ScoreAutomationState = {
    ...state, trackedRun: { ...tracked, settled: true }, refreshAfter: snapshot.now,
  };
  if (run.status === "cancelled" || run.status === "canceled") {
    next = { ...next, phase: "paused", stopReason: "remote_cancelled" };
  } else {
    const verdict = singleCaseVerdict(run);
    const unresolved = verdict === "PENDING" || verdict === "VOID";
    if (tracked.lane === "scored" && verdict !== "PASS") {
      const problem = published(snapshot, tracked.problemId);
      const publicCaseIds = problem?.publicCaseIds.slice() ?? [];
      next = {
        ...next, phase: publicCaseIds.length ? "diagnostics" : "review", retryProblemId: null,
        failure: {
          problemId: tracked.problemId, scoreFailureRunId: run.id, publicCaseIds, diagnosticRunIds: [],
          unresolvedRunIds: unresolved ? [run.id] : [], reviewed: false,
          reviewReason: publicCaseIds.length ? null : problem ? "no_public_cases" : "problem_unavailable",
        },
      };
    } else if (tracked.lane === "practice") {
      const failure = state.failure!;
      const publicCaseIds = failure.publicCaseIds.slice(1);
      const unresolvedRunIds = [...failure.unresolvedRunIds, ...(unresolved ? [run.id] : [])];
      next = {
        ...next, phase: publicCaseIds.length ? "diagnostics" : "review",
        failure: {
          ...failure, publicCaseIds, unresolvedRunIds,
          reviewReason: publicCaseIds.length ? null : unresolvedRunIds.length
            ? "unresolved_results" : "diagnostics_complete",
        },
      };
    }
  }
  return state.phase === "paused" || state.phase === "complete"
    ? { ...next, phase: state.phase, stopReason: state.stopReason } : next;
}

/**
 * Every snapshot must contain freshly validated dashboard data; now is its observation time.
 * Persist the returned state before acting. A terminal observation requires a newer snapshot
 * before another admission, so its pre-completion credits/eligibility cannot be reused.
 * Hydrate the failed problem's publicCaseIds before reporting its terminal run: an empty
 * array means no published examples, not an index count whose details have not been fetched.
 */
export function planScoreAutomation(
  state: ScoreAutomationState,
  snapshot: ScoreAutomationSnapshot,
): { state: ScoreAutomationState; decision: ScoreAutomationDecision } {
  let next = checked(scoreAutomationStateSchema, state, "score_automation_invalid_state");
  const current = checked(scoreAutomationSnapshotSchema, snapshot, "score_automation_invalid_snapshot");
  if (current.trackedRun) next = observeRun(next, current.trackedRun, current);
  if (current.frozen) next = { ...next, phase: "complete", stopReason: "frozen" };
  else if (current.eligibility.withdrawn && next.phase !== "complete" && next.phase !== "paused") {
    next = { ...next, phase: "paused", stopReason: "withdrawn" };
  }
  const result = (decision: ScoreAutomationDecision) => ({ state: next, decision });
  if (next.phase === "paused" || next.phase === "complete") {
    return result({ kind: next.phase, reason: next.stopReason! });
  }
  if (next.phase === "review") return result({ kind: "review_required", reason: next.failure!.reviewReason! });
  if (next.trackedRun && !next.trackedRun.settled) {
    return result({ kind: "wait", reason: "tracked_run", waitMs: null });
  }
  if (next.refreshAfter !== null && current.now <= next.refreshAfter) {
    return result({ kind: "wait", reason: "refresh", waitMs: null });
  }

  let admission: ScoreAdmission;
  if (next.phase === "diagnostics") {
    const failure = next.failure!;
    const problem = published(current, failure.problemId);
    const caseId = failure.publicCaseIds[0]!;
    if (!problem || !problem.publicCaseIds.includes(caseId)) {
      const reason = problem ? "public_case_unavailable" : "problem_unavailable";
      next = { ...next, phase: "review", failure: { ...failure, reviewReason: reason } };
      return result({ kind: "review_required", reason });
    }
    admission = { kind: "admit", lane: "practice", problemId: failure.problemId, caseId };
  } else {
    const eligible = current.openProblems.filter((problem) => {
      const progress = current.progress.find((entry) => entry.problemId === problem.id);
      return problem.id !== "switchboard" && problem.weight > 0 &&
        (progress?.credited ?? 0) < (progress?.cap ?? 4);
    }).sort((a, b) => b.weight - a.weight || a.number - b.number ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const problem = eligible.find((candidate) => candidate.id === next.retryProblemId) ?? eligible[0];
    if (!problem) return result({ kind: "idle", reason: "no_eligible_problems" });
    admission = { kind: "admit", lane: "scored", problemId: problem.id, caseId: null };
  }
  if (current.eligibility.activeRun) return result({ kind: "wait", reason: "active_run", waitMs: null });
  const waitMs = admission.lane === "scored" ? current.eligibility.scoredWaitMs : current.eligibility.practiceWaitMs;
  return result(waitMs > 0 ? { kind: "wait", reason: "cooldown", waitMs } : admission);
}

/**
 * Explicitly import a selected terminal scored failure into an unused automation.
 * The runner verifies team ownership; runId must identify snapshot.trackedRun.
 * No admission receipt is fabricated, and replaying the same failure never resets diagnostics.
 */
export function seedScoreAutomationFailure(
  state: ScoreAutomationState, snapshot: ScoreAutomationSnapshot, runId: string,
): ScoreAutomationState {
  const next = checked(scoreAutomationStateSchema, state, "score_automation_invalid_state");
  const current = checked(scoreAutomationSnapshotSchema, snapshot, "score_automation_invalid_snapshot");
  const id = checked(idSchema, runId, "score_automation_invalid_run_id");
  const run = current.trackedRun;
  if (!run) throw new AppError("score_automation_seed_run_required");
  if (run.id !== id) throw new AppError("score_automation_run_id_mismatch");
  if (run.mode !== "scored") throw new AppError("score_automation_run_lane_mismatch");
  if (!run.problem_id || run.problem_id === "switchboard") throw new AppError("score_automation_seed_invalid_problem");
  if (!runFinished(run)) throw new AppError("score_automation_seed_not_terminal");
  if (run.status === "cancelled" || run.status === "canceled") throw new AppError("score_automation_seed_cancelled");
  if (singleCaseVerdict(run) === "PASS") throw new AppError("score_automation_seed_passed");
  if (next.failure?.scoreFailureRunId === id) {
    if (next.failure.problemId !== run.problem_id) throw new AppError("score_automation_run_problem_mismatch");
    return next;
  }
  if (next.phase !== "scoring" || next.trackedRun || next.failure || next.retryProblemId || next.refreshAfter !== null) {
    throw new AppError("score_automation_seed_state_not_empty");
  }
  return planScoreAutomation({
    ...next, trackedRun: { id, lane: "scored", problemId: run.problem_id, caseId: null, settled: false },
  }, current).state;
}

/** Register only an actual admission receipt, using the exact decision that produced it. */
export function recordScoreAdmission(
  state: ScoreAutomationState, admission: ScoreAdmission, runId: string,
): ScoreAutomationState {
  const next = checked(scoreAutomationStateSchema, state, "score_automation_invalid_state");
  const target = checked(scoreAdmissionSchema, admission, "score_automation_invalid_admission");
  const id = checked(idSchema, runId, "score_automation_invalid_run_id");
  const tracked = next.trackedRun;
  if (tracked?.id === id) {
    if (tracked.lane !== target.lane || tracked.problemId !== target.problemId || tracked.caseId !== target.caseId) {
      throw new AppError("score_automation_admission_mismatch");
    }
    return next;
  }
  if (tracked && !tracked.settled) throw new AppError("score_automation_run_already_active");
  if (next.failure?.scoreFailureRunId === id || next.failure?.diagnosticRunIds.includes(id)) {
    throw new AppError("score_automation_run_already_recorded");
  }
  if (target.lane === "scored" ? next.phase !== "scoring" : next.phase !== "diagnostics" ||
    target.problemId !== next.failure?.problemId || target.caseId !== next.failure.publicCaseIds[0]) {
    throw new AppError("score_automation_admission_mismatch");
  }
  return {
    ...next, trackedRun: { id, lane: target.lane, problemId: target.problemId, caseId: target.caseId, settled: false },
    refreshAfter: null, retryProblemId: target.lane === "scored" ? null : next.retryProblemId,
    failure: target.lane === "practice"
      ? { ...next.failure!, diagnosticRunIds: [...next.failure!.diagnosticRunIds, id] } : next.failure,
  };
}

/** Approval is tied to one failure ID; replaying it never schedules a second retry. */
export function resumeScoreAutomation(state: ScoreAutomationState, scoreFailureRunId: string): ScoreAutomationState {
  const next = checked(scoreAutomationStateSchema, state, "score_automation_invalid_state");
  if (!next.failure || next.failure.scoreFailureRunId !== scoreFailureRunId) {
    throw new AppError("score_automation_review_mismatch");
  }
  if (next.failure.reviewed) return next;
  if (next.phase !== "review") throw new AppError("score_automation_review_not_ready");
  return {
    ...next, phase: "scoring", failure: { ...next.failure, reviewed: true }, retryProblemId: next.failure.problemId,
  };
}
