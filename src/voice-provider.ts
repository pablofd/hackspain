import { createAzureVoiceFactory, type VoiceFactory } from "./azure-realtime.js";
import { createAzureLiveVoiceFactory } from "./azure-live.js";
import type { Config } from "./config.js";
import type { ProsperClient } from "./prosper.js";

export function voiceProfile(config: Config) {
  return config.VOICE_CONNECTOR === "live"
    ? {
      connector: "live" as const,
      deployment: config.AZURE_OPENAI_LIVE_DEPLOYMENT,
      backendDeployment: config.AZURE_OPENAI_LIVE_BACKEND_DEPLOYMENT,
      outputGainDb: config.VOICE_LIVE_OUTPUT_GAIN_DB,
    }
    : {
      connector: "realtime" as const,
      deployment: config.AZURE_OPENAI_DEPLOYMENT,
      outputGainDb: config.VOICE_OUTPUT_GAIN_DB,
    };
}

export function createConfiguredVoiceFactory(
  config: Config,
  prosper: ProsperClient,
  factories: {
    realtime?: typeof createAzureVoiceFactory;
    live?: typeof createAzureLiveVoiceFactory;
  } = {},
): VoiceFactory {
  return config.VOICE_CONNECTOR === "live"
    ? (factories.live ?? createAzureLiveVoiceFactory)(config, prosper)
    : (factories.realtime ?? createAzureVoiceFactory)(config, prosper);
}
