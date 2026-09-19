import { parseConfig } from "../src/config.js";

export function config(overrides: NodeJS.ProcessEnv = {}) {
  return parseConfig({
    AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
    PROSPER_API_KEY: "test-prosper-key",
    VOICE_ENDPOINT_TOKEN: "test-endpoint-token-at-least-32-characters",
    PORT: "0",
    CALL_RECORDING_ENABLED: "false",
    ...overrides,
  });
}
