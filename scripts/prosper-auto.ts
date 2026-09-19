import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { AppError, errorCode } from "../src/errors.js";
import { loadDashboardSession, ProsperDashboardClient } from "../src/prosper-dashboard.js";
import { ProsperRunsClient, RunApiError, saveRunSnapshot, transientRunError } from "../src/prosper-runs.js";
import {
  ScoreAutomationRunner, reviewApprovalSchema, type AutomationStatus,
} from "../src/score-automation-runner.js";
import {
  acquireAutomationLease, readAutomationArtifact, writeAutomationArtifact,
} from "../src/score-automation-storage.js";

const usage = "Usage: npm run prosper:auto -- status | run | resume --failure-run ID --revision SHA --outcome fix_deployed|no_local_change";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "failure-run": { type: "string" }, revision: { type: "string" }, outcome: { type: "string" },
    },
  });
  const command = positionals[0] ?? "status";
  if (positionals.length > 1 || !["status", "run", "resume"].includes(command) ||
      command !== "resume" && Object.keys(values).length) {
    throw new AppError("invalid_automation_command", usage);
  }
  const approval = command === "resume" ? reviewApprovalSchema.safeParse({
    failureRunId: values["failure-run"], revision: values.revision, outcome: values.outcome,
    reviewedAt: new Date().toISOString(),
  }) : undefined;
  if (approval && !approval.success) throw new AppError("invalid_automation_review", usage);
  if (command === "status") {
    console.log(JSON.stringify({
      status: readAutomationArtifact("status") ?? null,
      state: readAutomationArtifact("state") ?? null,
      review: readAutomationArtifact("review") ?? null,
    }, null, 2));
    return;
  }

  const config = loadConfig();
  const session = loadDashboardSession(".local/prosper-dashboard-session.json", config.PROSPER_API_BASE_URL);
  const release = acquireAutomationLease();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let runner: ScoreAutomationRunner | undefined;
  let lastMessage = "";
  let lastDisplay = 0;
  const report = (status: AutomationStatus): void => {
    const message = JSON.stringify({
      event: status.event, phase: status.phase, reason: status.reason, points: status.points,
      remaining: status.remaining, trackedRun: status.trackedRun, error: status.error,
    });
    if (message !== lastMessage || Date.now() - lastDisplay >= 60_000) {
      console.log(JSON.stringify(status));
      lastMessage = message;
      lastDisplay = Date.now();
    }
  };
  try {
    runner = new ScoreAutomationRunner({
      teamId: session.team_id, dashboard: new ProsperDashboardClient(session), runs: new ProsperRunsClient(config),
      read: readAutomationArtifact, write: writeAutomationArtifact,
      saveRun: (run) => { saveRunSnapshot(run.id, run); }, now: Date.now, report,
      health: async (signal) => {
        let response: Response;
        try {
          response = await fetch(`http://127.0.0.1:${config.PORT}/healthz`, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: "error", cache: "no-store",
          });
        } catch { throw new AppError(signal.aborted ? "operation_aborted" : "automation_voice_unreachable"); }
        if (!response.ok) throw new AppError("automation_voice_unhealthy");
        let body: unknown;
        try { body = await response.json(); }
        catch { throw new AppError("automation_voice_invalid_health"); }
        const parsed = z.object({ status: z.literal("ok"), activeCalls: z.number().int().nonnegative() }).safeParse(body);
        if (!parsed.success) throw new AppError("automation_voice_invalid_health");
        return parsed.data;
      },
    });
    if (approval?.success) runner.approveReview(approval.data);
    for (;;) {
      controller.signal.throwIfAborted();
      try {
        const result = await runner.tick(controller.signal);
        if (result.stop) {
          if (result.status.event !== "complete") process.exitCode = 2;
          return;
        }
        await delay(result.waitMs, undefined, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const retry = transientRunError(error) ||
          error instanceof AppError && ["dashboard_network_error", "automation_voice_unreachable"].includes(error.code);
        const waitMs = retry ? Math.max(5000, error instanceof RunApiError ? error.retryAfterMs ?? 5000 : 5000) : undefined;
        runner.reportError(error, waitMs);
        if (waitMs === undefined) throw error;
        await delay(waitMs, undefined, { signal: controller.signal });
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      runner?.stopped();
      process.exitCode = 130;
    } else throw error;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    release();
  }
}

void main().catch((error: unknown) => {
  console.error(`${errorCode(error)}: ${error instanceof AppError ? error.message : "Automation stopped; credentials were not logged."}`);
  process.exitCode = 1;
});
