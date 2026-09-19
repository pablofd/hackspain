import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { z } from "zod";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import { idSchema } from "./prosper-types.js";
import { withSpan } from "./telemetry.js";

const runTime = z.iso.datetime({ offset: true });
const runCaseSchema = z.object({
  call_id: idSchema.nullable(),
  passed: z.boolean().nullable(),
  attribution: z.enum(["none", "agent_issue", "harness_issue", "mixed", "inconclusive"]).nullable(),
  signal_codes: z.array(z.string().regex(/^[a-z0-9_]+$/).max(100)).max(100),
});
const endpointSchema = z.url().refine((value) => ["ws:", "wss:"].includes(new URL(value).protocol))
  .transform((value) => {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  });
export const runSchema = z.object({
  id: idSchema,
  team_id: idSchema,
  problem_id: idSchema.nullable().optional(),
  mode: z.enum(["scored", "practice"]),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled", "canceled"]),
  endpoint: endpointSchema,
  created_at: runTime,
  started_at: runTime.nullable(),
  finished_at: runTime.nullable(),
  cases: z.array(runCaseSchema).max(1000),
});
export type ProsperRun = z.infer<typeof runSchema>;
export type ProsperRunCase = z.infer<typeof runCaseSchema>;

export function validateScoredProblem(problemId: string): void {
  if (!idSchema.safeParse(problemId).success) throw new AppError("invalid_problem_id");
  if (problemId === "switchboard") throw new AppError("unscored_problem", "Switchboard does not award points.");
}

export class RunApiError extends AppError {
  constructor(readonly status: number, readonly retryAfterMs?: number) {
    super(`prosper_run_http_${status}`, `Run API returned HTTP ${status}${retryAfterMs === undefined
      ? "." : `; retry after ${Math.ceil(retryAfterMs / 1000)} seconds.`}`);
  }
}

export class ProsperRunsClient {
  constructor(
    private readonly config: Pick<Config, "PROSPER_API_BASE_URL" | "PROSPER_API_KEY">,
    private readonly request: typeof fetch = fetch,
  ) {}

  async list(signal: AbortSignal): Promise<ProsperRun[]> {
    return withSpan("prosper.runs.list", { "http.request.method": "GET", "url.path": "/api/v1/runs" },
      ROOT_CONTEXT, async () => {
        const result = z.object({ runs: z.array(runSchema).max(10_000) }).safeParse(
          await this.read("/api/v1/runs", signal),
        );
        if (!result.success) throw new AppError("prosper_run_invalid_response");
        return result.data.runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      });
  }

  async get(id: string, signal: AbortSignal): Promise<ProsperRun> {
    if (!idSchema.safeParse(id).success) throw new AppError("invalid_run_id");
    return withSpan("prosper.runs.get", { "http.request.method": "GET", "url.path": "/api/v1/runs/{id}" },
      ROOT_CONTEXT, async () => {
        const result = runSchema.safeParse(await this.read(`/api/v1/runs/${encodeURIComponent(id)}`, signal));
        if (!result.success || result.data.id !== id) throw new AppError("prosper_run_invalid_response");
        return result.data;
      });
  }

  async startScored(problemId: string, signal: AbortSignal): Promise<{ id: string }> {
    validateScoredProblem(problemId);
    return withSpan("prosper.runs.admit", { "http.request.method": "POST", "url.path": "/api/v1/runs" },
      ROOT_CONTEXT, async () => {
        const response = await this.send("/api/v1/runs", signal, { lane: "scored", problem_id: problemId });
        if (!response.ok) {
          if (response.status >= 500 || response.status === 408) throw new AppError("prosper_run_admission_unknown",
            "Run admission may have succeeded. Inspect the run list before starting another run.");
          throw this.httpError(response);
        }
        let body: unknown;
        try { body = await this.json(response, signal); }
        catch { throw new AppError("prosper_run_admission_unknown",
          "Run admission may have succeeded. Inspect the run list before starting another run."); }
        const result = z.object({ id: idSchema }).safeParse(body);
        if (!result.success) throw new AppError("prosper_run_admission_unknown",
        "Run admission may have succeeded. Inspect the run list before starting another run.");
        return result.data;
      });
  }

  private async read(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.send(path, signal);
    if (!response.ok) throw this.httpError(response);
    return this.json(response, signal);
  }

  private async send(path: string, signal: AbortSignal, body?: { lane: "scored"; problem_id: string }): Promise<Response> {
    signal.throwIfAborted();
    try {
      return await this.request(new URL(path, this.config.PROSPER_API_BASE_URL), {
        method: body ? "POST" : "GET",
        headers: {
          "X-Api-Key": this.config.PROSPER_API_KEY, Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      if (body) throw new AppError("prosper_run_admission_unknown",
        "Run admission may have succeeded. Inspect the run list before starting another run.");
      if (signal.aborted) throw new AppError("operation_aborted");
      throw new AppError("prosper_run_network_error");
    }
  }

  private httpError(response: Response): RunApiError {
    const retry = response.headers.get("retry-after");
    const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : undefined;
    const at = retry && seconds === undefined ? Date.parse(retry) : NaN;
    const delay = seconds === undefined ? Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
      : seconds * 1000;
    if (delay !== undefined && delay > 2_147_483_647) throw new AppError("prosper_run_retry_after_too_long");
    return new RunApiError(response.status, delay !== undefined && Number.isFinite(delay) ? delay : undefined);
  }

  private async json(response: Response, signal: AbortSignal): Promise<unknown> {
    let text: string;
    try { text = await response.text(); }
    catch { throw new AppError(signal.aborted ? "operation_aborted" : "prosper_run_network_error"); }
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new AppError("prosper_run_response_too_large");
    try { return JSON.parse(text) as unknown; }
    catch { throw new AppError("prosper_run_invalid_response"); }
  }
}

export function runFinished(run: ProsperRun): boolean {
  return ["completed", "failed", "cancelled", "canceled"].includes(run.status);
}

export function caseVerdict(value: ProsperRunCase): "PASS" | "FAIL" | "VOID" | "PENDING" {
  if (value.passed === true) return "PASS";
  if (value.passed === null) return "PENDING";
  return value.attribution === "harness_issue" || value.attribution === "mixed" ? "VOID" : "FAIL";
}

export function runCounts(run: ProsperRun) {
  const states = run.cases.map(caseVerdict);
  return {
    reported: states.length,
    passed: states.filter((value) => value === "PASS").length,
    failed: states.filter((value) => value === "FAIL").length,
    voided: states.filter((value) => value === "VOID").length,
    pending: states.filter((value) => value === "PENDING").length,
  };
}

export function scoredRunEligibility(runs: readonly ProsperRun[], now = Date.now()) {
  const active = runs.find((run) => !runFinished(run));
  const finished = runs.flatMap((run) => run.mode === "scored" && run.finished_at !== null
    ? [Date.parse(run.finished_at)] : []);
  const eligibleAt = finished.length ? Math.max(...finished) + 12 * 60_000 : now;
  return { active, eligibleAt, ready: !active && now >= eligibleAt };
}

export function transientRunError(error: unknown): boolean {
  return error instanceof AppError && error.code === "prosper_run_network_error" ||
    error instanceof RunApiError && (error.status >= 500 || error.status === 408 || error.status === 429);
}

export function formatRun(run: ProsperRun, details = false): string {
  const counts = runCounts(run);
  const lines = [
    `Run ${run.id} | ${run.mode} | ${run.status.toUpperCase()}`,
    runFinished(run)
      ? `PASS ${counts.passed} | FAIL ${counts.failed} | VOID ${counts.voided} | PENDING ${counts.pending}`
      : `Published verdicts ${counts.passed + counts.failed + counts.voided} | PASS ${counts.passed} | FAIL ${counts.failed} | VOID ${counts.voided} | total not supplied yet`,
  ];
  if (run.problem_id) lines.push(`Problem: ${run.problem_id}`);
  if (run.started_at) lines.push(`Started: ${run.started_at}${run.finished_at ? ` | Finished: ${run.finished_at}` : ""}`);
  if (details) {
    lines.push("CASE  RESULT   CALL ID                               ATTRIBUTION    SIGNALS");
    run.cases.forEach((value, index) => lines.push(
      `${String(index + 1).padStart(2, "0")}    ${caseVerdict(value).padEnd(8)} ${(value.call_id ?? "-").padEnd(37)} ${(value.attribution ?? "-").padEnd(14)} ${value.signal_codes.join(", ") || "-"}`,
    ));
    lines.push("Signals do not override verdicts. This endpoint does not expose weighted points.");
  }
  return lines.join("\n");
}

function secureDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) {
    throw new AppError("prosper_run_unsafe_path");
  }
  chmodSync(path, 0o700);
}

export function saveRunSnapshot(id: string, run?: ProsperRun): string {
  if (!idSchema.safeParse(id).success || run && run.id !== id) throw new AppError("invalid_run_id");
  const local = resolve(".local");
  secureDirectory(local);
  const directory = join(local, "runs");
  secureDirectory(directory);
  const path = join(directory, `run-${id}.json`);
  const observedAt = new Date().toISOString();
  let admissionReceivedAt = run ? undefined : observedAt;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) {
      throw new AppError("prosper_run_unsafe_path");
    }
    let existing: unknown;
    try { existing = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new AppError("prosper_run_invalid_snapshot"); }
    const previous = z.object({
      schemaVersion: z.literal(1), run_id: idSchema, observed_at: runTime,
      admission_received_at: runTime.optional(), state: z.literal("admitted").optional(),
    }).safeParse(existing);
    if (!previous.success || previous.data.run_id !== id) throw new AppError("prosper_run_invalid_snapshot");
    admissionReceivedAt = previous.data.admission_received_at ??
      (previous.data.state === "admitted" ? previous.data.observed_at : admissionReceivedAt);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const temporary = join(directory, `.run-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    try {
      writeFileSync(fd, JSON.stringify({
        schemaVersion: 1, run_id: id, observed_at: observedAt,
        ...(admissionReceivedAt ? { admission_received_at: admissionReceivedAt } : {}),
        ...(run ? { run: runSchema.parse(run) } : { state: "admitted" }),
      }, null, 2) + "\n");
    } finally { closeSync(fd); }
    renameSync(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) unlinkSync(temporary);
  }
  return path;
}
