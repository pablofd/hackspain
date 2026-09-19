import { loadConfig } from "./config.js";
import { AppError, errorCode } from "./errors.js";
import { log, startTelemetry } from "./telemetry.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const telemetry = startTelemetry(config);
  const [{ createVoiceServer }, { createConfiguredVoiceFactory, voiceProfile }, { ProsperClient }] = await Promise.all([
    import("./server.js"),
    import("./voice-provider.js"),
    import("./prosper.js"),
  ]);
  const server = createVoiceServer(config, createConfiguredVoiceFactory(config, new ProsperClient(config)), telemetry.mode);
  try {
    const port = await server.listen();
    log("info", "server.listening", {
      host: config.HOST, port, telemetry: telemetry.mode, ...voiceProfile(config),
    });
  } catch (error) {
    await telemetry.shutdown();
    throw error;
  }
  const shutdown = () => {
    void (async () => {
      await server.close();
      await telemetry.shutdown();
    })().catch((error: unknown) => {
      log("error", "server.shutdown_failed", { code: errorCode(error) });
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
  log("error", "server.start_failed", {
    code: errorCode(error),
    detail: error instanceof AppError ? error.message : "Startup failed; no credentials were logged.",
  });
  process.exitCode = 1;
});
