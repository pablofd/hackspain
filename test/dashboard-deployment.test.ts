import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { dashboardRequestOrigin } from "../src/dashboard/demo.js";
import { receptionistInstructions } from "../src/receptionist.js";
import { DashboardService } from "../src/dashboard/service.js";
import { dashboardConfig, dashboardDirectory, dashboardFetch } from "./dashboard-fixtures.js";

test("real configuration projects the runtime prompt without inference or credentials", async (t) => {
  const upstream = dashboardFetch();
  const config = dashboardConfig(dashboardDirectory(t), { AZURE_OPENAI_VOICE: "cedar" });
  const snapshot = await new DashboardService(config, upstream.request).snapshot();
  assert.equal(snapshot.agentConfiguration.voice, "cedar");
  assert.equal(snapshot.agentConfiguration.prompt, receptionistInstructions(new Date(snapshot.observedAt), true));
  assert.ok(upstream.requests.every(({ method }) => method === "GET"));
  assert.doesNotMatch(JSON.stringify(snapshot.agentConfiguration), /synthetic-dashboard-token|synthetic-prosper-key/);
});

test("Vercel origin is exact and opt-in, not arbitrary forwarded headers", () => {
  const request = new IncomingMessage(new Socket());
  request.headers = { host: "backend.example", origin: "https://dashboard.example" };
  assert.throws(() => dashboardRequestOrigin(request));
  assert.equal(dashboardRequestOrigin(request, "https://dashboard.example"), "https://dashboard.example");
  request.headers.origin = "https://evil.example";
  request.headers["x-forwarded-host"] = "dashboard.example";
  assert.throws(() => dashboardRequestOrigin(request, "https://dashboard.example"));
  assert.throws(() => dashboardConfig("/tmp", { DASHBOARD_PUBLIC_ORIGIN: "https://*.example/" }));
});

test("Vercel output includes only public assets and an authenticated API destination", (t) => {
  const directory = dashboardDirectory(t);
  cpSync("dashboard", `${directory}/dashboard`, { recursive: true, filter: (path) => !path.includes("/.local") });
  mkdirSync(`${directory}/scripts`);
  cpSync("scripts/build-dashboard-vercel.mjs", `${directory}/scripts/build-dashboard-vercel.mjs`);
  const build = () => execFileSync(process.execPath, ["scripts/build-dashboard-vercel.mjs"], {
    cwd: resolve(directory), env: { PATH: process.env.PATH, DASHBOARD_BACKEND_ORIGIN: "https://backend.example" },
  });
  build();
  const output = `${directory}/.vercel/output`;
  const config = JSON.parse(readFileSync(`${output}/config.json`, "utf8"));
  assert.equal(config.version, 3);
  assert.equal(config.routes[1].dest, "https://backend.example/api/dashboard/$1");
  assert.match(config.routes[0].headers["Content-Security-Policy"], /wss:\/\/backend.example/);
  assert.equal(config.routes[0].headers["Cache-Control"], "no-store");
  assert.equal(existsSync(`${output}/static/.local`), false);
  assert.equal(existsSync(`${output}/static/.env.local`), false);
  assert.match(readFileSync(`${output}/static/src/data/deployment.js`, "utf8"), /https:\/\/backend.example/);
});
