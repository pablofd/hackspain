import { fileURLToPath } from "node:url";
import { loadDashboardConfig } from "../src/dashboard/config.js";
import { DashboardService } from "../src/dashboard/service.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { DashboardDemoCalls } from "../src/dashboard/demo.js";
import { AppError, errorCode } from "../src/errors.js";
import { log } from "../src/telemetry.js";

async function main(): Promise<void> {
  const config = loadDashboardConfig();
  const demoCalls = new DashboardDemoCalls(config);
  const server = createDashboardServer(config, new DashboardService(config),
    fileURLToPath(new URL("../dashboard", import.meta.url)), { demoCalls });
  let port: number;
  try { port = await server.listen(); }
  catch (error) { await demoCalls.close(); throw error; }
  log("info", "dashboard.listening", { host: config.DASHBOARD_HOST, port, mode: "clinic_read_only_with_voice_demo" });
  const close = () => {
    void server.close().catch((error: unknown) => {
      log("error", "dashboard.shutdown_failed", { code: errorCode(error) });
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

void main().catch((error: unknown) => {
  log("error", "dashboard.start_failed", {
    code: errorCode(error),
    detail: error instanceof AppError ? error.message : "Dashboard startup failed; no credentials were logged.",
  });
  process.exitCode = 1;
});
