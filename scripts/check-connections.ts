import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { ROOT_CONTEXT, context } from "@opentelemetry/api";
import { loadConfig } from "../src/config.js";
import { AppError, errorCode } from "../src/errors.js";
import { log, startTelemetry, withSpan } from "../src/telemetry.js";
import type { VoiceSession } from "../src/azure-realtime.js";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { voice: { type: "boolean", default: false } } });
  const config = loadConfig();
  const telemetry = startTelemetry(config);
  try {
    const [{ ProsperClient }, { createConfiguredVoiceFactory, voiceProfile }] = await Promise.all([
      import("../src/prosper.js"),
      import("../src/voice-provider.js"),
    ]);
    const clinic = await new ProsperClient(config).getClinic(ROOT_CONTEXT, AbortSignal.timeout(15_000));
    log("info", "prosper.access_verified", {
      clinic: clinic.clinic_name, locations: clinic.locations.length, providers: clinic.providers.length,
    });
    if (values.voice) {
      await withSpan("voice.connection_check", {}, ROOT_CONTEXT, async () => {
        const controller = new AbortController();
        const completion = Promise.withResolvers<void>();
        let session: VoiceSession | undefined;
        let audioBytes = 0;
        let audibleBytes = 0;
        let toolRequests = 0;
        let backendCompleted = false;
        const maybeComplete = () => {
          if (backendCompleted && audioBytes > 0 && audibleBytes > 0 && toolRequests > 0) completion.resolve();
        };
        const observedFetch: typeof fetch = async (input, init) => {
          if (init?.method?.toUpperCase() === "POST") throw new AppError("voice_check_submissions_disabled");
          toolRequests += 1;
          return fetch(input, init);
        };
        const factory = createConfiguredVoiceFactory(config, new ProsperClient(config, observedFetch));
        const timeout = setTimeout(() => {
          completion.reject(new AppError("voice_check_timeout"));
          controller.abort();
        }, 45_000);
        try {
          const connecting = factory({
            callId: `check-${randomUUID()}`,
            parent: context.active(),
            signal: controller.signal,
            greet: false,
            allowSubmissions: false,
            onAudio: ({ audio }) => {
              audioBytes += audio.length;
              audibleBytes += audio.reduce((count, sample) => count + (sample !== 0xff && sample !== 0x7f ? 1 : 0), 0);
              maybeComplete();
            },
            onAudioDone: () => {},
            onInterrupt: () => undefined,
            onFailure: (error) => completion.reject(error),
            onTurnDone: () => {
              backendCompleted = true;
              maybeComplete();
            },
          }).then((voice) => {
            session = voice;
            voice.sendText("Use get_clinic to check the official catalogue, then tell me briefly how many clinic locations there are.");
          });
          await Promise.all([connecting, completion.promise]);
          log("info", "azure.voice_verified", {
            ...voiceProfile(config), audioBytes, audibleBytes, toolRequests,
          });
        } finally {
          clearTimeout(timeout);
          controller.abort();
          await session?.close();
        }
      });
    }
  } finally {
    await telemetry.shutdown();
  }
  log("info", "connection_check.completed", {
    prosper: "connected",
    azureVoice: values.voice ? "connected" : "not_checked",
    azureAuthentication: values.voice
      ? config.AZURE_OPENAI_API_KEY ? "api_key" : "DefaultAzureCredential"
      : "not_checked",
    telemetryExport: telemetry.mode === "azure" ? "application_insights_configured" : "local_console",
    audioPlayback: "not_performed_by_this_check",
  });
}

void main().catch((error: unknown) => {
  log("error", "connection_check.failed", { code: errorCode(error) });
  process.exitCode = 1;
});
