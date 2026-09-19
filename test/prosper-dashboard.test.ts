import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadDashboardSession, ProsperDashboardClient, type DashboardSession } from "../src/prosper-dashboard.js";

const session: DashboardSession = {
  origin: "https://prosper.example", team_id: "team-test",
  cookie: "session=synthetic-private-value", created_at: "2026-09-19T12:00:00Z",
};
const progress = {
  team_id: session.team_id, generated_at: "2026-09-19T15:00:00Z",
  stats: { best_points: 4, rank: 1, private_field: "not returned" },
  progress: [{ problem_id: "problem-a", passed: 7, credited: 4, credited_of: 4 }],
  eligibility: { active_run: false, withdrawn: false, public_wait: 0, private_wait: 16 },
  members: [{ email: "not-returned@example.test" }],
  integration: { headers: { Authorization: "not-returned" } },
};
const signal = () => new AbortController().signal;

test("dashboard reads are cookie authenticated, same-origin and expose only progress metadata", async () => {
  const client = new ProsperDashboardClient(session, async (input, init) => {
    assert.equal(String(input), "https://prosper.example/leaderboard/api/teams/team-test");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Cookie"), session.cookie);
    assert.equal(new Headers(init?.headers).get("X-Api-Key"), null);
    return Response.json(progress);
  });
  const result = await client.progress(signal());
  assert.equal(result.progress[0]?.credited, 4);
  assert.equal(result.eligibility.private_wait, 16);
  assert.ok(!JSON.stringify(result).includes("not-returned"));
  assert.ok(!JSON.stringify(result).includes("not returned"));
});

test("published index has case counts; detail supplies IDs without caller scenarios or expected answers", async () => {
  const client = new ProsperDashboardClient(session, async (input) =>
    String(input).endsWith("/problem-a")
      ? Response.json({ id: "problem-a", examples: [
        { case_id: "public-a", caller: "private", summary: "private", accepted: { patient_id: "private" } },
      ] })
      : Response.json({ problems: [{ id: "problem-a", title: "Synthetic problem", number: 1, weight: 3, examples: 1 }] }));
  assert.equal((await client.problems(signal()))[0]?.examples, 1);
  assert.deepEqual(await client.publicCases("problem-a", signal()), ["public-a"]);
  await assert.rejects(client.publicCases("../other", signal()), { code: "invalid_problem_id" });
});

test("wrong teams, impossible credits and duplicate progress entries fail instead of becoming zero", async () => {
  for (const body of [
    { ...progress, team_id: "another-team" },
    { ...progress, progress: [{ problem_id: "problem-a", passed: 2, credited: 4, credited_of: 4 }] },
    { ...progress, progress: [{ problem_id: "problem-a", passed: 5, credited: 5, credited_of: 4 }] },
    { ...progress, progress: [...progress.progress, ...progress.progress] },
    { ...progress, eligibility: { ...progress.eligibility, private_wait: -1 } },
  ]) {
    const client = new ProsperDashboardClient(session, async () => Response.json(body));
    await assert.rejects(client.progress(signal()), { code: "dashboard_invalid_progress" });
  }
});

test("login failures do not return empty progress or expose server details", async () => {
  for (const status of [401, 403]) {
    const client = new ProsperDashboardClient(session, async () => new Response("private cookie details", { status }));
    await assert.rejects(client.progress(signal()), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "dashboard_auth_required");
      assert.ok(!error.message.includes("private cookie"));
      return true;
    });
  }
});

test("dashboard network and malformed bodies are explicit read failures", async () => {
  const broken = new ProsperDashboardClient(session, async () => { throw new Error("private"); });
  await assert.rejects(broken.progress(signal()), { code: "dashboard_network_error" });
  const malformed = new ProsperDashboardClient(session, async () => new Response("not-json"));
  await assert.rejects(malformed.problems(signal()), { code: "dashboard_invalid_response" });
  const duplicate = new ProsperDashboardClient(session, async () =>
    Response.json({ id: "problem-a", examples: [{ case_id: "same" }, { case_id: "same" }] }));
  await assert.rejects(duplicate.publicCases("problem-a", signal()), { code: "dashboard_invalid_public_cases" });
});

test("the public freeze flag is read without exporting leaderboard identities", async () => {
  const client = new ProsperDashboardClient(session, async () => Response.json({
    generated_at: progress.generated_at, frozen: true, entries: [{ name: "not returned", points: 5 }],
  }));
  assert.deepEqual(await client.board(signal()), { generated_at: progress.generated_at, frozen: true });
});

test("sessions must be private, regular, non-symlinked files for the expected origin", (t) => {
  const directory = resolve(".local", `dashboard-session-test-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = resolve(directory, "session.json");
  writeFileSync(path, JSON.stringify(session), { mode: 0o600 });
  assert.deepEqual(loadDashboardSession(path, session.origin), session);
  assert.throws(() => loadDashboardSession(path, "https://other.example"), { code: "dashboard_session_invalid" });
  chmodSync(path, 0o644);
  assert.throws(() => loadDashboardSession(path, session.origin), { code: "dashboard_session_unsafe" });
  chmodSync(path, 0o600);
  const link = resolve(directory, "link.json");
  symlinkSync(path, link);
  assert.throws(() => loadDashboardSession(link, session.origin), { code: "dashboard_session_unsafe" });
  writeFileSync(path, JSON.stringify({ ...session, cookie: "invalid\r\nHeader: injected" }));
  assert.throws(() => loadDashboardSession(path, session.origin), { code: "dashboard_session_invalid" });
});
