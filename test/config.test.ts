import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

test("output gain is opt-in, bounded and does not change the configured voice protocol", () => {
  assert.equal(config().VOICE_OUTPUT_GAIN_DB, 0);
  assert.equal(config({ VOICE_OUTPUT_GAIN_DB: "9" }).VOICE_OUTPUT_GAIN_DB, 9);
  for (const value of ["-1", "13", "NaN", "Infinity"]) {
    assert.throws(() => config({ VOICE_OUTPUT_GAIN_DB: value }), /VOICE_OUTPUT_GAIN_DB/);
  }
});

test("configuring output gain preserves endpoint credentials and rejects invalid changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "hackspain-output-gain-"));
  const path = join(directory, ".env.local");
  const original = "AZURE_OPENAI_ENDPOINT=https://synthetic.openai.azure.com\nVOICE_ENDPOINT_TOKEN=synthetic-existing-token-unchanged\nPROSPER_API_KEY=synthetic-preserved-key\n";
  writeFileSync(path, original, { mode: 0o600 });
  const command = ["--import", import.meta.resolve("tsx"), resolve("scripts/configure-local.ts"), "--output-gain-db"];
  try {
    const output = execFileSync(process.execPath, [...command, "9"], { cwd: directory, env: {}, encoding: "utf8" });
    const contents = readFileSync(path, "utf8");
    assert.ok(contents.startsWith(original));
    assert.match(contents, /VOICE_OUTPUT_GAIN_DB="9"/);
    assert.ok(!output.includes("synthetic-existing-token"));
    assert.throws(() => execFileSync(process.execPath, [...command, "99"], {
      cwd: directory, env: {}, stdio: "pipe",
    }));
    assert.equal(readFileSync(path, "utf8"), contents);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("the safe configurator persists only supported built-in Realtime voices", () => {
  const directory = mkdtempSync(join(tmpdir(), "hackspain-realtime-voice-"));
  const path = join(directory, ".env.local");
  const original = "AZURE_OPENAI_ENDPOINT=https://synthetic.openai.azure.com\nVOICE_ENDPOINT_TOKEN=synthetic-existing-token-unchanged\nPROSPER_API_KEY=synthetic-preserved-key\n";
  writeFileSync(path, original, { mode: 0o600 });
  const command = ["--import", import.meta.resolve("tsx"), resolve("scripts/configure-local.ts"), "--realtime-voice"];
  try {
    const output = execFileSync(process.execPath, [...command, "cedar"], { cwd: directory, env: {}, encoding: "utf8" });
    const contents = readFileSync(path, "utf8");
    assert.ok(contents.startsWith(original));
    assert.match(contents, /AZURE_OPENAI_VOICE="cedar"/);
    assert.ok(!output.includes("synthetic-existing-token"));
    assert.ok(!output.includes("synthetic-preserved-key"));
    assert.throws(() => execFileSync(process.execPath, [...command, "unknown"], {
      cwd: directory, env: {}, stdio: "pipe",
    }));
    assert.equal(readFileSync(path, "utf8"), contents);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("Live configuration is opt-in, separately bounded, and preserves the default Realtime profile", () => {
  const settings = config({ VOICE_CONNECTOR: "live", VOICE_OUTPUT_GAIN_DB: "9" });
  assert.equal(config().VOICE_CONNECTOR, "realtime");
  assert.equal(settings.AZURE_OPENAI_DEPLOYMENT, "gpt-realtime-1.5");
  assert.equal(settings.AZURE_OPENAI_API_VERSION, "2024-10-01-preview");
  assert.equal(settings.AZURE_OPENAI_LIVE_DEPLOYMENT, "gpt-live-1");
  assert.equal(settings.AZURE_OPENAI_LIVE_BACKEND_DEPLOYMENT, "gpt-5.4-mini");
  assert.equal(settings.AZURE_OPENAI_LIVE_VOICE, "coral");
  assert.equal(settings.VOICE_OUTPUT_GAIN_DB, 9);
  assert.equal(settings.VOICE_LIVE_OUTPUT_GAIN_DB, 0);
  assert.throws(() => config({ VOICE_CONNECTOR: "unknown" }), /VOICE_CONNECTOR/);
  for (const value of ["-1", "13", "NaN", "Infinity"]) {
    assert.throws(() => config({ VOICE_LIVE_OUTPUT_GAIN_DB: value }), /VOICE_LIVE_OUTPUT_GAIN_DB/);
  }
});

test("the explicit Live switch preserves Realtime settings and credentials through a switch back", () => {
  const directory = mkdtempSync(join(tmpdir(), "hackspain-voice-switch-"));
  const path = join(directory, ".env.local");
  const original = [
    "AZURE_OPENAI_ENDPOINT=https://synthetic.openai.azure.com",
    "VOICE_ENDPOINT_TOKEN=synthetic-existing-token-unchanged",
    "PROSPER_API_KEY=synthetic-preserved-key",
    "AZURE_OPENAI_DEPLOYMENT=gpt-realtime-1.5",
    "AZURE_OPENAI_API_VERSION=2024-10-01-preview",
    "VOICE_OUTPUT_GAIN_DB=9",
    "",
  ].join("\n");
  writeFileSync(path, original, { mode: 0o600 });
  const command = ["--import", import.meta.resolve("tsx"), resolve("scripts/configure-local.ts")];
  try {
    const output = execFileSync(process.execPath, [...command,
      "--voice-connector", "live", "--live-deployment", "live-synthetic",
      "--live-backend", "backend-synthetic", "--live-output-gain-db", "3",
    ], { cwd: directory, env: {}, encoding: "utf8" });
    assert.ok(readFileSync(path, "utf8").startsWith(original));
    const live = readEnvironment(directory, {});
    assert.equal(live.VOICE_CONNECTOR, "live");
    assert.equal(live.AZURE_OPENAI_LIVE_DEPLOYMENT, "live-synthetic");
    assert.equal(live.AZURE_OPENAI_LIVE_BACKEND_DEPLOYMENT, "backend-synthetic");
    assert.equal(live.VOICE_LIVE_OUTPUT_GAIN_DB, "3");
    assert.ok(!output.includes("synthetic-existing-token"));
    assert.ok(!output.includes("synthetic-preserved-key"));
    execFileSync(process.execPath, [...command, "--voice-connector", "realtime"], { cwd: directory, env: {}, stdio: "pipe" });
    assert.deepEqual(readEnvironment(directory, {}), { ...live, VOICE_CONNECTOR: "realtime" });
    const contents = readFileSync(path, "utf8");
    for (const args of [
      ["--voice-connector", "unknown"], ["--live-deployment", ""],
      ["--live-backend", "backend\nVOICE_ENDPOINT_TOKEN=changed"],
      ["--live-output-gain-db", "13"],
    ]) {
      assert.throws(() => execFileSync(process.execPath, [...command, ...args], { cwd: directory, env: {}, stdio: "pipe" }));
      assert.equal(readFileSync(path, "utf8"), contents);
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});
