import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { readEnvironment } from "../src/config.js";
import { AppError } from "../src/errors.js";

export function ngrokOptions(environment: NodeJS.ProcessEnv) {
  const input = z.object({
    NGROK_AUTHTOKEN: z.string().min(1).regex(/^\S+$/),
    NGROK_URL: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.url().refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password &&
          url.pathname === "/" && !url.search && !url.hash && !url.port;
      }).optional(),
    ),
    PORT: z.coerce.number().int().min(1).max(65535).default(7860),
  }).safeParse(environment);
  if (!input.success) {
    const fields = [...new Set(input.error.issues.map((issue) => issue.path.join(".")))];
    throw new AppError("ngrok_configuration_required",
      `Configure ${fields.join(", ")} in .env.local. Get an ngrok agent authtoken from https://dashboard.ngrok.com/get-started/your-authtoken; do not paste it into chat.`);
  }
  const { NGROK_AUTHTOKEN, NGROK_URL, PORT } = input.data;
  return {
    port: PORT,
    args: [
      "http", `http://127.0.0.1:${PORT}`, "--inspect=false", "--log=stdout", "--log-format=json",
      ...(NGROK_URL ? ["--url", NGROK_URL] : []),
    ],
    env: {
      ...Object.fromEntries(
        ["PATH", "HOME", "USER", "LANG", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]
          .flatMap((key) => environment[key] ? [[key, environment[key]]] : []),
      ),
      NGROK_AUTHTOKEN,
    },
  };
}

async function main(): Promise<void> {
  const options = ngrokOptions(readEnvironment());
  const binary = resolve(".tools/ngrok");
  try { accessSync(binary, constants.X_OK); }
  catch { throw new AppError("ngrok_not_installed", "Install the official ngrok binary at .tools/ngrok. See README.md."); }
  let health: unknown;
  try {
    const response = await fetch(`http://127.0.0.1:${options.port}/healthz`, {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) throw new AppError("agent_unavailable");
    health = await response.json();
  } catch {
    throw new AppError("agent_unavailable", "Start the voice agent with npm start before opening the tunnel.");
  }
  if (!z.object({ status: z.literal("ok"), capabilities: z.array(z.string()).refine((value) => value.includes("voice")) }).safeParse(health).success) {
    throw new AppError("unexpected_local_service", "The local port is not serving the expected voice agent.");
  }

  const child = spawn(binary, options.args, { env: options.env, stdio: ["ignore", "pipe", "pipe"] });
  for (const output of [child.stdout, child.stderr]) {
    createInterface({ input: output }).on("line", (line: string) => {
      console.log(line.replaceAll(options.env.NGROK_AUTHTOKEN, "[REDACTED]"));
    });
  }
  const interrupt = () => { child.kill("SIGINT"); };
  const terminate = () => { child.kill("SIGTERM"); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    await new Promise<void>((done, reject) => {
      child.once("error", () => reject(new AppError("ngrok_start_failed")));
      child.once("close", (code, signal) => {
        if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") done();
        else reject(new AppError("ngrok_exited", `ngrok exited with code ${code ?? "unknown"}; check the redacted output above.`));
      });
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error instanceof AppError ? error.message : "Tunnel startup failed; no credentials were logged.");
    process.exitCode = 1;
  });
}
