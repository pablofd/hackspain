import { readFile, realpath } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { AppError, errorCode } from "../errors.js";
import { validAuthorization } from "../server.js";
import { log } from "../telemetry.js";
import type { DashboardConfig } from "./config.js";
import type { DashboardService } from "./service.js";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
};
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

export function createDashboardServer(
  config: DashboardConfig,
  service: Pick<DashboardService, "snapshot" | "patients" | "appointments">,
  staticDirectory: string,
) {
  const root = resolve(staticDirectory);
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://dashboard.local");
      if (url.pathname.startsWith("/api/")) {
        if (!validAuthorization(request.headers.authorization, config.DASHBOARD_TOKEN)) {
          json(response, 401, { error: "dashboard_unauthorized" });
          return;
        }
        if (request.headers["sec-fetch-site"] === "cross-site") {
          json(response, 403, { error: "dashboard_cross_origin_denied" });
          return;
        }
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET");
          json(response, 405, { error: "dashboard_read_only" });
          return;
        }
        if (url.pathname === "/api/dashboard/snapshot" && !url.search) {
          json(response, 200, await service.snapshot());
          return;
        }
        if (url.pathname === "/api/dashboard/patients") {
          if ([...url.searchParams.keys()].length !== 1) throw new AppError("dashboard_invalid_patient_search");
          json(response, 200, await service.patients(Object.fromEntries(url.searchParams)));
          return;
        }
        const appointments = /^\/api\/dashboard\/patients\/([A-Za-z0-9_-]{1,128})\/appointments$/.exec(url.pathname);
        if (appointments?.[1] && !url.search) {
          json(response, 200, await service.appointments(appointments[1]));
          return;
        }
        json(response, 404, { error: "dashboard_not_found" });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        json(response, 405, { error: "dashboard_read_only" });
        return;
      }
      const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (relative !== "index.html" && !/^(src|design)\/[A-Za-z0-9_/-]+\.(js|css|svg|json)$/.test(relative)) {
        json(response, 404, { error: "dashboard_not_found" });
        return;
      }
      let path: string;
      try { path = await realpath(resolve(root, relative)); }
      catch { json(response, 404, { error: "dashboard_not_found" }); return; }
      if (!path.startsWith(`${root}${sep}`)) {
        json(response, 404, { error: "dashboard_not_found" });
        return;
      }
      const body = await readFile(path);
      response.writeHead(200, { ...headers, "Content-Type": mime[extname(path)] ?? "application/octet-stream" });
      response.end(request.method === "HEAD" ? undefined : body);
    })().catch((error: unknown) => {
      const code = errorCode(error);
      log("warn", "dashboard.request_failed", { code });
      if (!response.headersSent) json(response, code.startsWith("dashboard_invalid_") ? 400 : 503, { error: code });
      else response.destroy();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return {
    async listen(): Promise<number> {
      await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(config.DASHBOARD_PORT, config.DASHBOARD_HOST, () => {
          server.removeListener("error", reject);
          done();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new AppError("dashboard_invalid_listen_address");
      return address.port;
    },
    async close(): Promise<void> {
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    },
  };
}
