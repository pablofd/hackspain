import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { z } from "zod";
import { AppError } from "./errors.js";
import { idSchema } from "./prosper-types.js";
import { RunApiError } from "./prosper-runs.js";
import { withSpan } from "./telemetry.js";

const timestamp = z.iso.datetime({ offset: true });
const title = z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/u);
const sessionSchema = z.object({
  origin: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash;
  }),
  team_id: idSchema,
  cookie: z.string().min(1).max(16_384).regex(/^[\x20-\x7e]+$/),
  created_at: timestamp,
});
export type DashboardSession = z.infer<typeof sessionSchema>;

export const publishedProblemSchema = z.object({
  id: idSchema, title, number: z.number().int().positive(),
  weight: z.number().int().min(0).max(5),
  examples: z.number().int().nonnegative().max(100),
});
export type PublishedProblem = z.infer<typeof publishedProblemSchema>;

export const teamProgressSchema = z.object({
  team_id: idSchema,
  generated_at: timestamp,
  stats: z.object({ best_points: z.number().nonnegative(), rank: z.number().int().nonnegative().nullable() }),
  progress: z.array(z.object({
    problem_id: idSchema,
    passed: z.number().int().nonnegative(),
    credited: z.number().int().min(0).max(4),
    credited_of: z.literal(4),
  }).refine((value) => value.credited <= value.passed)).max(1000)
    .refine((rows) => new Set(rows.map((row) => row.problem_id)).size === rows.length),
  eligibility: z.object({
    active_run: z.boolean(), withdrawn: z.boolean(),
    public_wait: z.number().nonnegative().max(86_400),
    private_wait: z.number().nonnegative().max(86_400),
  }),
});
export type TeamProgress = z.infer<typeof teamProgressSchema>;

export function loadDashboardSession(path: string, expectedOrigin: string): DashboardSession {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new AppError("dashboard_session_unsafe", "The dashboard session must be an owned private regular file (0600)."); }
  let data: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 32_768 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new AppError("dashboard_session_unsafe", "The dashboard session must be an owned private regular file (0600).");
    }
    try { data = JSON.parse(readFileSync(fd, "utf8")); }
    catch { throw new AppError("dashboard_session_invalid"); }
  } finally { closeSync(fd); }
  const parsed = sessionSchema.safeParse(data);
  if (!parsed.success || new URL(parsed.data.origin).origin !== new URL(expectedOrigin).origin) {
    throw new AppError("dashboard_session_invalid");
  }
  return parsed.data;
}

export class ProsperDashboardClient {
  constructor(
    private readonly session: DashboardSession,
    private readonly request: typeof fetch = fetch,
  ) {}

  async problems(signal: AbortSignal): Promise<PublishedProblem[]> {
    const parsed = z.object({ problems: z.array(publishedProblemSchema).max(1000) })
      .safeParse(await this.get("/leaderboard/api/problems", signal));
    if (!parsed.success || new Set(parsed.data.problems.map((problem) => problem.id)).size !== parsed.data.problems.length) {
      throw new AppError("dashboard_invalid_problems");
    }
    return parsed.data.problems;
  }

  async publicCases(problemId: string, signal: AbortSignal): Promise<string[]> {
    if (!idSchema.safeParse(problemId).success) throw new AppError("invalid_problem_id");
    const parsed = z.object({
      id: idSchema, examples: z.array(z.object({ case_id: idSchema })).max(100),
    }).safeParse(await this.get(`/leaderboard/api/problems/${encodeURIComponent(problemId)}`, signal));
    if (!parsed.success || parsed.data.id !== problemId) throw new AppError("dashboard_invalid_public_cases");
    const ids = parsed.data.examples.map((example) => example.case_id);
    if (new Set(ids).size !== ids.length) throw new AppError("dashboard_invalid_public_cases");
    return ids;
  }

  async progress(signal: AbortSignal): Promise<TeamProgress> {
    const parsed = teamProgressSchema.safeParse(await this.get(
      `/leaderboard/api/teams/${encodeURIComponent(this.session.team_id)}`, signal,
    ));
    if (!parsed.success || parsed.data.team_id !== this.session.team_id) throw new AppError("dashboard_invalid_progress");
    return parsed.data;
  }

  async board(signal: AbortSignal): Promise<{ generated_at: string; frozen: boolean }> {
    const parsed = z.object({ generated_at: timestamp, frozen: z.boolean() })
      .safeParse(await this.get("/leaderboard/api/board", signal));
    if (!parsed.success) throw new AppError("dashboard_invalid_board");
    return parsed.data;
  }

  private async get(path: string, signal: AbortSignal): Promise<unknown> {
    return withSpan("prosper.dashboard.read", {
      "http.request.method": "GET",
      "url.path": path.startsWith("/leaderboard/api/teams/") ? "/leaderboard/api/teams/{id}"
        : path.startsWith("/leaderboard/api/problems/") ? "/leaderboard/api/problems/{id}" : path,
    }, ROOT_CONTEXT, async () => {
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await this.request(new URL(path, this.session.origin), {
          method: "GET", headers: { Cookie: this.session.cookie, Accept: "application/json" },
          redirect: "error", cache: "no-store",
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        });
      } catch {
        throw new AppError(signal.aborted ? "operation_aborted" : "dashboard_network_error");
      }
      if (response.status === 401 || response.status === 403) {
        throw new AppError("dashboard_auth_required", "Refresh the private dashboard session before continuing.");
      }
      if (!response.ok) throw new RunApiError(response.status);
      let text: string;
      try { text = await response.text(); }
      catch { throw new AppError(signal.aborted ? "operation_aborted" : "dashboard_network_error"); }
      if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new AppError("dashboard_response_too_large");
      try { return JSON.parse(text) as unknown; }
      catch { throw new AppError("dashboard_invalid_response"); }
    });
  }
}
