import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError, errorCode } from "./errors.js";
import type { ProsperDashboardClient, TeamProgress } from "./prosper-dashboard.js";
import { idSchema } from "./prosper-types.js";
import {
  RunApiError, caseVerdict, runCounts, runFinished, scoredRunEligibility,
  type ProsperRun, type ProsperRunsClient,
} from "./prosper-runs.js";
import {
  createScoreAutomationState, planScoreAutomation, recordScoreAdmission, resumeScoreAutomation,
  scoreAdmissionSchema, scoreAutomationStateSchema, type ScoreAdmission, type ScoreAutomationSnapshot,
} from "./score-automation.js";
import type { AutomationArtifact } from "./score-automation-storage.js";

export const SCORE_FREEZE_AT = Date.parse("2026-09-20T04:00:00Z");
const timestamp = z.iso.datetime({ offset: true });
export const reviewApprovalSchema = z.strictObject({
  failureRunId: idSchema,
  revision: z.string().regex(/^[a-f0-9]{7,40}$/),
  outcome: z.enum(["fix_deployed", "no_local_change"]),
  reviewedAt: timestamp,
});
export type ReviewApproval = z.infer<typeof reviewApprovalSchema>;

const receiptSchema = z.strictObject({
  runId: idSchema, admission: scoreAdmissionSchema, receivedAt: timestamp,
});
export const automationCheckpointSchema = z.strictObject({
  version: z.literal(1), teamId: idSchema, planner: scoreAutomationStateSchema,
  receipts: z.array(receiptSchema).max(1000)
    .refine((receipts) => new Set(receipts.map((receipt) => receipt.runId)).size === receipts.length),
  reviews: z.array(reviewApprovalSchema).max(1000),
});
type Checkpoint = z.infer<typeof automationCheckpointSchema>;

const journalBase = {
  version: z.literal(1), intentId: z.uuid(), teamId: idSchema, createdAt: timestamp,
  admission: scoreAdmissionSchema, previousRunIds: z.array(idSchema).max(10_000),
};
const admissionJournalSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...journalBase, status: z.literal("pending") }),
  z.strictObject({ ...journalBase, status: z.literal("accepted"), runId: idSchema, receivedAt: timestamp }),
  z.strictObject({ ...journalBase, status: z.literal("applied"), runId: idSchema, receivedAt: timestamp }),
  z.strictObject({ ...journalBase, status: z.literal("rejected"), error: z.string().regex(/^[a-z0-9_]+$/) }),
]);
type AdmissionJournal = z.infer<typeof admissionJournalSchema>;

export interface ScoreAutomationPorts {
  teamId: string;
  dashboard: Pick<ProsperDashboardClient, "problems" | "publicCases" | "progress" | "board">;
  runs: Pick<ProsperRunsClient, "list" | "get" | "startScored" | "startPractice">;
  read(name: AutomationArtifact): unknown | undefined;
  write(name: AutomationArtifact, data: unknown): void;
  saveRun(run: ProsperRun): void;
  health(signal: AbortSignal): Promise<{ activeCalls: number }>;
  now(): number;
  report(status: AutomationStatus): void;
}

export interface AutomationStatus {
  version: 1;
  observedAt: string;
  teamId: string;
  pid: number;
  phase: Checkpoint["planner"]["phase"];
  event: string;
  reason: string | null;
  points: number | null;
  remaining: { problemId: string; credited: number; cap: number; weight: number }[];
  trackedRun: { id: string; lane: string; problemId: string; status: string | null } | null;
  nextCheckAt: string | null;
  error: string | null;
}

export interface AutomationTick {
  stop: boolean;
  waitMs: number;
  status: AutomationStatus;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(code);
  return result.data;
}

export class ScoreAutomationRunner {
  private checkpoint: Checkpoint;
  private progress: TeamProgress | undefined;
  private remaining: AutomationStatus["remaining"] = [];
  private observedRun: ProsperRun | undefined;

  constructor(private readonly ports: ScoreAutomationPorts) {
    const saved = ports.read("state");
    this.checkpoint = saved === undefined ? {
      version: 1, teamId: ports.teamId, planner: createScoreAutomationState(), receipts: [], reviews: [],
    } : parse(automationCheckpointSchema, saved, "automation_invalid_checkpoint");
    if (this.checkpoint.teamId !== ports.teamId) throw new AppError("automation_team_mismatch");
    this.persist();
  }

  approveReview(approval: ReviewApproval): void {
    const checked = parse(reviewApprovalSchema, approval, "automation_invalid_review");
    const planner = resumeScoreAutomation(this.checkpoint.planner, checked.failureRunId);
    const previous = this.checkpoint.reviews.find((review) => review.failureRunId === checked.failureRunId);
    if (previous && (previous.revision !== checked.revision || previous.outcome !== checked.outcome)) {
      throw new AppError("automation_review_already_recorded");
    }
    this.checkpoint = {
      ...this.checkpoint, planner,
      reviews: previous ? this.checkpoint.reviews : [...this.checkpoint.reviews, checked],
    };
    this.persist();
    this.publish("review_approved", checked.outcome, 0, false);
  }

  async tick(signal: AbortSignal): Promise<AutomationTick> {
    signal.throwIfAborted();
    this.recoverReceipt();
    const snapshot = await this.snapshot(signal);
    const plan = planScoreAutomation(this.checkpoint.planner, snapshot);
    this.checkpoint = { ...this.checkpoint, planner: plan.state };
    this.persist();
    const decision = plan.decision;
    if (decision.kind === "review_required") {
      await this.saveReview(signal);
      return this.publish("review_required", decision.reason, 0, true);
    }
    if (decision.kind === "paused" || decision.kind === "complete") {
      return this.publish(decision.kind, decision.reason, 0, true);
    }
    if (decision.kind === "idle") return this.publish("idle", decision.reason, 60_000, false);
    if (decision.kind === "wait") {
      return this.publish("wait", decision.reason,
        decision.waitMs === null ? 10_000 : Math.min(30_000, Math.max(1000, decision.waitMs)), false);
    }
    if (decision.kind !== "admit") throw new AppError("automation_unknown_decision");
    return this.admit(decision, signal);
  }

  reportError(error: unknown, retryMs?: number): AutomationTick {
    return this.publish(retryMs === undefined ? "blocked" : "read_retry", null,
      retryMs ?? 0, retryMs === undefined, errorCode(error));
  }

  stopped(): void {
    this.publish("stopped", "local_command_stopped_remote_run_unchanged", 0, true);
  }

  private persist(): void {
    this.checkpoint = parse(automationCheckpointSchema, this.checkpoint, "automation_invalid_checkpoint");
    this.ports.write("state", this.checkpoint);
  }

  private validateTeam(run: ProsperRun): void {
    if (run.team_id !== this.ports.teamId) throw new AppError("automation_team_mismatch");
  }

  private journal(): AdmissionJournal | undefined {
    const value = this.ports.read("admission");
    if (value === undefined) return undefined;
    const journal = parse(admissionJournalSchema, value, "automation_invalid_journal");
    if (journal.teamId !== this.ports.teamId) throw new AppError("automation_team_mismatch");
    return journal;
  }

  private recoverReceipt(): void {
    const journal = this.journal();
    if (!journal || journal.status === "rejected") return;
    if (journal.status === "pending") {
      throw new AppError("automation_admission_unknown",
        "An admission intent has no confirmed receipt. Reconcile the remote run list; do not repeat the POST.");
    }
    if (journal.status === "applied") {
      const receipt = this.checkpoint.receipts.find((receipt) => receipt.runId === journal.runId);
      if (!receipt || JSON.stringify(receipt.admission) !== JSON.stringify(journal.admission)) {
        throw new AppError("automation_receipt_missing");
      }
      return;
    }
    this.applyReceipt(journal);
  }

  private applyReceipt(journal: Extract<AdmissionJournal, { status: "accepted" }>): void {
    const planner = recordScoreAdmission(this.checkpoint.planner, journal.admission, journal.runId);
    const receipts = this.checkpoint.receipts.some((receipt) => receipt.runId === journal.runId)
      ? this.checkpoint.receipts : [...this.checkpoint.receipts, {
        runId: journal.runId, admission: journal.admission, receivedAt: journal.receivedAt,
      }];
    this.checkpoint = { ...this.checkpoint, planner, receipts };
    this.persist();
    this.ports.write("admission", { ...journal, status: "applied" });
  }

  private async snapshot(signal: AbortSignal): Promise<ScoreAutomationSnapshot> {
    const tracked = this.checkpoint.planner.trackedRun;
    const [problems, progress, board, run] = await Promise.all([
      this.ports.dashboard.problems(signal),
      this.ports.dashboard.progress(signal),
      this.ports.dashboard.board(signal),
      tracked && !tracked.settled ? this.ports.runs.get(tracked.id, signal) : Promise.resolve(undefined),
    ]);
    if (progress.team_id !== this.ports.teamId) throw new AppError("automation_team_mismatch");
    this.progress = progress;
    if (run) {
      this.validateTeam(run);
      this.ports.saveRun(run);
      this.observedRun = run;
    }
    const needsFailureCases = run && run.mode === "scored" && runFinished(run) &&
      !["cancelled", "canceled"].includes(run.status) &&
      (run.cases.length !== 1 || caseVerdict(run.cases[0]!) !== "PASS");
    const caseProblemId = needsFailureCases ? tracked!.problemId
      : this.checkpoint.planner.phase === "diagnostics" ? this.checkpoint.planner.failure!.problemId : undefined;
    const problem = problems.find((problem) => problem.id === caseProblemId);
    const publicCaseIds = problem ? await this.ports.dashboard.publicCases(problem.id, signal) : [];
    if (problem && publicCaseIds.length !== problem.examples) throw new AppError("automation_case_roster_changed");
    this.remaining = problems.filter((problem) => problem.weight > 0 && problem.id !== "switchboard")
      .map((problem) => {
        const row = progress.progress.find((row) => row.problem_id === problem.id);
        return { problemId: problem.id, weight: problem.weight, credited: row?.credited ?? 0, cap: row?.credited_of ?? 4 };
      }).filter((problem) => problem.credited < problem.cap);
    return {
      now: this.ports.now(),
      openProblems: problems.map((problem) => ({
        id: problem.id, title: problem.title, number: problem.number, weight: problem.weight,
        publicCaseIds: problem.id === caseProblemId ? publicCaseIds : [],
      })),
      progress: progress.progress.map((row) => ({ problemId: row.problem_id, credited: row.credited, cap: row.credited_of })),
      eligibility: {
        activeRun: progress.eligibility.active_run, withdrawn: progress.eligibility.withdrawn,
        scoredWaitMs: progress.eligibility.private_wait * 1000,
        practiceWaitMs: progress.eligibility.public_wait * 1000,
      },
      frozen: board.frozen || this.ports.now() >= SCORE_FREEZE_AT,
      ...(run ? { trackedRun: run } : {}),
    };
  }

  private async admit(admission: ScoreAdmission, signal: AbortSignal): Promise<AutomationTick> {
    const [runs, health] = await Promise.all([this.ports.runs.list(signal), this.ports.health(signal)]);
    if (!runs.length) throw new AppError("automation_team_unverified",
      "A known team run is required to verify that the dashboard session and API key belong to the same team.");
    for (const run of runs) this.validateTeam(run);
    const eligibility = scoredRunEligibility(runs, this.ports.now());
    if (eligibility.active) return this.publish("wait", "active_run", 10_000, false);
    if (health.activeCalls > 0) return this.publish("wait", "local_call_active", 10_000, false);
    if (this.ports.now() >= SCORE_FREEZE_AT) return this.publish("wait", "refresh", 1000, false);
    if (admission.lane === "scored" && !eligibility.ready) {
      return this.publish("wait", "cooldown", Math.min(30_000, eligibility.eligibleAt - this.ports.now()), false);
    }
    const journal: Extract<AdmissionJournal, { status: "pending" }> = {
      version: 1, intentId: randomUUID(), teamId: this.ports.teamId,
      createdAt: new Date(this.ports.now()).toISOString(), admission,
      previousRunIds: runs.map((run) => run.id), status: "pending",
    };
    this.ports.write("admission", journal);
    let receipt: { id: string };
    try {
      receipt = admission.lane === "scored"
        ? await this.ports.runs.startScored(admission.problemId, signal)
        : await this.ports.runs.startPractice(admission.problemId, admission.caseId, signal);
    } catch (error) {
      if (error instanceof RunApiError && error.status < 500 && error.status !== 408) {
        this.ports.write("admission", { ...journal, status: "rejected", error: errorCode(error) });
        if (error.status === 409 || error.status === 429) {
          return this.publish("wait", "admission_rejected", Math.max(5000, error.retryAfterMs ?? 10_000),
            false, errorCode(error));
        }
      }
      throw error;
    }
    if (journal.previousRunIds.includes(receipt.id)) throw new AppError("automation_reused_run_id");
    const accepted = {
      ...journal, status: "accepted" as const, runId: receipt.id, receivedAt: new Date(this.ports.now()).toISOString(),
    };
    this.ports.write("admission", accepted);
    this.applyReceipt(accepted);
    this.observedRun = undefined;
    return this.publish("admitted", admission.lane, 5000, false);
  }

  private async saveReview(signal: AbortSignal): Promise<void> {
    const failure = this.checkpoint.planner.failure!;
    const ids = [failure.scoreFailureRunId, ...failure.diagnosticRunIds];
    const runs = await Promise.all(ids.map((id) => this.ports.runs.get(id, signal)));
    for (const run of runs) {
      this.validateTeam(run);
      if (!runFinished(run)) throw new AppError("automation_review_run_unfinished");
      this.ports.saveRun(run);
    }
    this.ports.write("review", {
      version: 1, teamId: this.ports.teamId, createdAt: new Date(this.ports.now()).toISOString(),
      failureRunId: failure.scoreFailureRunId, problemId: failure.problemId, reason: failure.reviewReason,
      remainingPublicCaseIds: failure.publicCaseIds, unresolvedRunIds: failure.unresolvedRunIds,
      runs: runs.map((run) => ({
        id: run.id, mode: run.mode, problemId: run.problem_id ?? failure.problemId,
        caseId: this.checkpoint.receipts.find((receipt) => receipt.runId === run.id)?.admission.caseId ?? null,
        status: run.status, counts: runCounts(run), createdAt: run.created_at, finishedAt: run.finished_at,
        cases: run.cases.map((item) => ({
          callId: item.call_id, verdict: caseVerdict(item), attribution: item.attribution, signals: item.signal_codes,
        })),
      })),
    });
  }

  private publish(event: string, reason: string | null, waitMs: number, stop: boolean, error: string | null = null): AutomationTick {
    const tracked = this.checkpoint.planner.trackedRun;
    const status: AutomationStatus = {
      version: 1, observedAt: new Date(this.ports.now()).toISOString(), teamId: this.ports.teamId, pid: process.pid,
      phase: this.checkpoint.planner.phase, event, reason,
      points: this.progress?.stats.best_points ?? null, remaining: this.remaining,
      trackedRun: tracked ? {
        id: tracked.id, lane: tracked.lane, problemId: tracked.problemId,
        status: this.observedRun?.id === tracked.id ? this.observedRun.status : null,
      } : null,
      nextCheckAt: stop ? null : new Date(this.ports.now() + waitMs).toISOString(), error,
    };
    this.ports.write("status", status);
    this.ports.report(status);
    return { stop, waitMs, status };
  }
}
