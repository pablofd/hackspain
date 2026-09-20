import { cp, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const raw = process.env.DASHBOARD_BACKEND_ORIGIN;
let origin;
try {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.origin !== raw) throw new Error();
  origin = url.origin;
} catch {
  throw new Error("Set DASHBOARD_BACKEND_ORIGIN to the public HTTPS origin of the dashboard adapter, without a trailing slash, path or credentials.");
}
const output = resolve(".vercel/output");
await mkdir(`${output}/static/src/data`, { recursive: true });
await cp("dashboard/index.html", `${output}/static/index.html`);
await cp("dashboard/src", `${output}/static/src`, { recursive: true });
await cp("dashboard/design", `${output}/static/design`, { recursive: true });
await writeFile(`${output}/static/src/data/deployment.js`,
  `export const dashboardBackendOrigin = ${JSON.stringify(origin)};\n`);
await writeFile(`${output}/config.json`, JSON.stringify({
  version: 3,
  routes: [
    {
      src: "/.*",
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "microphone=(self), camera=()",
        "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${origin.replace("https:", "wss:")}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
      },
      continue: true,
    },
    { src: "/api/dashboard/(.*)", dest: `${origin}/api/dashboard/$1` },
    { handle: "filesystem" },
    { src: "/.*", status: 404 },
  ],
}, null, 2));
console.log("Dashboard static output and authenticated API routing prepared; no credentials included.");
