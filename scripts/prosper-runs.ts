import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { AppError, errorCode } from "../src/errors.js";
import {
  ProsperRunsClient, RunApiError, formatRun, scoredRunEligibility, runCounts, runFinished,
  saveRunSnapshot, transientRunError, validateScoredProblem, type ProsperRun,
} from "../src/prosper-runs.js";

const usage = "Usage: npm run prosper -- list | status --run-id ID | watch --run-id ID | score --problem ID [--wait] [--watch] [--json]";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "run-id": { type: "string" },
      problem: { type: "string" },
      wait: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const command = positionals[0] ?? "list";
  if (command === "run-all") {
    throw new AppError("prosper_run_all_removed",
      "The platform now scores one selected problem per run. Use score --problem ID; no run was admitted.");
  }
  if (positionals.length > 1 || !["list", "status", "watch", "score"].includes(command)) {
    throw new AppError("invalid_run_command", usage);
  }
  if (["status", "watch"].includes(command) && !values["run-id"]) throw new AppError("missing_run_id", usage);
  if (command === "score" && !values.problem) throw new AppError("missing_problem_id", usage);
  if (command === "score" && values.problem) validateScoredProblem(values.problem);
  if (values.problem && command !== "score") throw new AppError("invalid_run_arguments", usage);
  if (values["run-id"] && ["list", "score"].includes(command)) throw new AppError("invalid_run_arguments", usage);
  if (values.wait && command !== "score" || values.watch && command !== "score") {
    throw new AppError("invalid_run_arguments", usage);
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const signal = controller.signal;
  const client = new ProsperRunsClient(loadConfig());
  const progress = (message: string) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    if (values.json) console.error(line);
    else console.log(line);
  };
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (;;) {
      signal.throwIfAborted();
      try { return await operation(); }
      catch (error) {
        if (signal.aborted || !transientRunError(error)) throw error;
        const wait = error instanceof RunApiError && error.retryAfterMs !== undefined
          ? Math.max(error.retryAfterMs, 5000) : 5000;
        progress(`API unavailable (${errorCode(error)}); last result is stale. Retrying this GET in ${Math.ceil(wait / 1000)}s.`);
        await delay(wait, undefined, { signal });
      }
    }
  };
  try {
    if (command === "list") {
      const runs = await read(() => client.list(signal));
      if (values.json) console.log(JSON.stringify({ runs }));
      else for (const run of runs.slice(0, 10)) console.log(`${formatRun(run)}\n`);
      return;
    }
    let id = values["run-id"];
    if (command === "score") {
      let lastWaitMessage = "";
      let lastWaitDisplay = 0;
      for (;;) {
        const runs = await read(() => client.list(signal));
        const eligibility = scoredRunEligibility(runs);
        if (eligibility.ready) break;
        const message = eligibility.active
          ? `Team slot occupied by ${eligibility.active.id} (${eligibility.active.status}).`
          : `Scored-run cooldown until ${new Date(eligibility.eligibleAt).toISOString()}.`;
        if (!values.wait) throw new AppError("prosper_run_not_ready", `${message} Use --wait to wait without admitting duplicates.`);
        if (message !== lastWaitMessage || Date.now() - lastWaitDisplay >= 60_000) {
          progress(message);
          lastWaitMessage = message;
          lastWaitDisplay = Date.now();
        }
        await delay(eligibility.active ? 10_000 : Math.min(30_000, Math.max(1000, eligibility.eligibleAt - Date.now())),
          undefined, { signal });
      }
      const admission = await client.startScored(values.problem!, signal);
      id = admission.id;
      progress(`ADMITTED ${id} | requested problem ${values.problem}. No automatic POST retry; use this ID to resume monitoring.`);
      const path = saveRunSnapshot(id);
      progress(`Admission receipt saved at ${path}.`);
    }
    if (!id) throw new AppError("missing_run_id", usage);
    const shouldWatch = command === "watch" || values.watch;
    let previous = "";
    let lastDisplay = 0;
    const displayed = new Set<string>();
    for (;;) {
      const run: ProsperRun = await read(() => client.get(id, signal));
      const path = saveRunSnapshot(run.id, run);
      if (command === "score" && (run.mode !== "scored" || run.problem_id && run.problem_id !== values.problem)) {
        throw new AppError("prosper_run_lane_mismatch",
          `Run ${run.id} did not confirm the requested scored lane/problem. Inspect it before starting another; it was not automatically cancelled.`);
      }
      if (!shouldWatch || runFinished(run)) {
        if (values.json) console.log(JSON.stringify({ run, counts: runCounts(run), snapshot: path }));
        else console.log(`${formatRun(run, true)}\nSnapshot: ${path}`);
        if (run.status === "failed" || run.status === "cancelled" || run.status === "canceled") process.exitCode = 1;
        return;
      }
      const state = JSON.stringify({ status: run.status, counts: runCounts(run) });
      if (state !== previous || Date.now() - lastDisplay >= 60_000) {
        progress(formatRun(run));
        previous = state;
        lastDisplay = Date.now();
      }
      for (const item of run.cases) {
        if (item.passed === null) continue;
        const key = JSON.stringify(item);
        if (displayed.has(key)) continue;
        displayed.add(key);
        const verdict = item.passed ? "PASS" : ["mixed", "harness_issue"].includes(item.attribution ?? "") ? "VOID" : "FAIL";
        progress(`${verdict} ${item.call_id ?? "not-dialled"} | ${item.attribution ?? "-"} | ${item.signal_codes.join(", ") || "no signals"}`);
      }
      await delay(5000, undefined, { signal });
    }
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

void main().catch((error: unknown) => {
  const aborted = error instanceof Error && error.name === "AbortError" ||
    error instanceof AppError && error.code === "operation_aborted";
  console.error(aborted ? "Command stopped; any admitted run was NOT cancelled." :
    `${errorCode(error)}: ${error instanceof AppError ? error.message : "Command failed; no credentials were logged."}`);
  process.exitCode = aborted ? 130 : 1;
});
