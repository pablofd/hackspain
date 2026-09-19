import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readEnvironment } from "../src/config.js";
import { azureRealtimeUrl } from "../src/azure-realtime.js";
import { config } from "./helpers.js";

test("configuration errors name fields but never expose values", () => {
  assert.throws(() => config({ VOICE_ENDPOINT_TOKEN: "secret" }), (error: unknown) =>
    error instanceof Error && error.message.includes("VOICE_ENDPOINT_TOKEN") &&
      !error.message.includes("secret"));
  assert.throws(() => config({ AZURE_OPENAI_ENDPOINT: "https://example.org" }));
  assert.throws(() => config({ MAX_CONCURRENT_CALLS: "21" }));
});

test(".env.lang contributes only Azure settings; local and shell override it", () => {
  const directory = mkdtempSync(join(tmpdir(), "hackspain-config-"));
  try {
    writeFileSync(join(directory, ".env.lang"),
      "AZURE_OPENAI_ENDPOINT=https://lang.openai.azure.com\nAZURE_OPENAI_API_KEY=lang-key\nPORT=3000\nPROSPER_API_KEY=wrong\n");
    writeFileSync(join(directory, ".env.local"), "PORT=7860\nPROSPER_API_KEY=right\n");
    const env = readEnvironment(directory, { PORT: "9000" });
    assert.equal(env.PORT, "9000");
    assert.equal(env.PROSPER_API_KEY, "right");
    assert.equal(env.AZURE_OPENAI_API_KEY, "lang-key");
    const changed = readEnvironment(directory, { AZURE_OPENAI_ENDPOINT: "https://other.openai.azure.com" });
    assert.equal(changed.AZURE_OPENAI_API_KEY, undefined);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("Azure URL preserves the known working deployment protocol, without a key in the URL", () => {
  const url = new URL(azureRealtimeUrl(config({ AZURE_OPENAI_API_KEY: "private-test-value" })));
  assert.equal(url.protocol, "wss:");
  assert.equal(url.pathname, "/openai/realtime");
  assert.equal(url.searchParams.get("deployment"), "gpt-realtime-1.5");
  assert.equal(url.searchParams.get("api-version"), "2024-10-01-preview");
  assert.ok(!url.toString().includes("private-test-value"));
});

test("audio recording is opt-in and requires the private call-record store", () => {
  assert.equal(config().CALL_AUDIO_RECORDING_ENABLED, false);
  assert.throws(() => config({ CALL_RECORDING_ENABLED: "false", CALL_AUDIO_RECORDING_ENABLED: "true" }),
    /CALL_AUDIO_RECORDING_ENABLED/);
  const enabled = config({ CALL_RECORDING_ENABLED: "true", CALL_AUDIO_RECORDING_ENABLED: "true" });
  assert.equal(enabled.CALL_AUDIO_RECORDING_ENABLED, true);
});
