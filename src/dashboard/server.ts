import { readFile, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { AppError, errorCode } from "../errors.js";
import { validAuthorization } from "../server.js";
import { log } from "../telemetry.js";
import type { DashboardConfig } from "./config.js";
import type { DashboardService } from "./service.js";
import { dashboardRequestHost, dashboardRequestOrigin, demoWebSocketPath, type DashboardDemoCalls } from "./demo.js";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
};
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "microphone=(self), camera=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

async function requireEmptyBody(request: IncomingMessage): Promise<void> {
  if (Number(request.headers["content-length"] ?? 0) !== 0) {
    request.resume();
    throw new AppError("dashboard_invalid_demo_request");
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      request.removeListener("data", data);
      request.removeListener("end", end);
      request.removeListener("error", failed);
      request.removeListener("aborted", failed);
    };
    const failed = () => { cleanup(); reject(new AppError("dashboard_invalid_demo_request")); };
    const data = (chunk: Buffer) => {
      if (chunk.length) { failed(); request.resume(); }
    };
    const end = () => { cleanup(); resolve(); };
    request.on("data", data);
    request.once("end", end);
    request.once("error", failed);
    request.once("aborted", failed);
  });
}

export function createDashboardServer(
  config: DashboardConfig,
  service: Pick<DashboardService, "snapshot" | "patients" | "appointments" | "transcript">,
  staticDirectory: string,
  options: { demoCalls?: DashboardDemoCalls } = {},
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
        if (request.method === "POST" && url.pathname === "/api/dashboard/demo-call" && !url.search) {
          if (!options.demoCalls) throw new AppError("dashboard_demo_disabled");
          await requireEmptyBody(request);
          json(response, 201, await options.demoCalls.issueTicket(dashboardRequestOrigin(request)));
          return;
        }
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET");
          json(response, 405, { error: "dashboard_read_only" });
          return;
        }
        if (url.pathname === "/api/dashboard/snapshot" && !url.search) {
          json(response, 200, {
            ...await service.snapshot(),
            demoCall: options.demoCalls?.status() ?? {
              enabled: false, activeCalls: 0, maxConcurrentCalls: 1, maxDurationSeconds: 180, submissionsAllowed: false,
            },
          });
          return;
        }
        const transcript = /^\/api\/dashboard\/calls\/([^/]*)\/transcript$/.exec(url.pathname);
        if (transcript) {
          if (url.search) throw new AppError("dashboard_invalid_transcript_request");
          let callId: string;
          try { callId = decodeURIComponent(transcript[1] ?? ""); }
          catch { throw new AppError("dashboard_invalid_call_id"); }
          json(response, 200, await service.transcript(callId));
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
      const host = dashboardRequestHost(request);
      response.writeHead(200, {
        ...headers,
        "Content-Security-Policy": headers["Content-Security-Policy"].replace(
          "connect-src 'self'", `connect-src 'self' ws://${host} wss://${host}`,
        ),
        "Content-Type": mime[extname(path)] ?? "application/octet-stream",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    })().catch((error: unknown) => {
      const code = errorCode(error);
      log("warn", "dashboard.request_failed", { code });
      if (!response.headersSent) {
        const status = code === "dashboard_transcript_not_found" ? 404 :
          code === "dashboard_demo_origin_denied" ? 403 : code === "dashboard_demo_busy" ? 409 :
          code === "dashboard_invalid_call_id" || code === "dashboard_invalid_transcript_request" ||
          code === "dashboard_invalid_patient_search" || code === "dashboard_invalid_patient_id" ||
          code === "dashboard_invalid_demo_request" || code === "dashboard_invalid_request_host" ? 400 : 503;
        json(response, status, { error: code });
      }
      else response.destroy();
    });
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== demoWebSocketPath || !options.demoCalls) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    options.demoCalls.upgrade(request, socket, head);
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
      await options.demoCalls?.close();
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    },
  };
}
