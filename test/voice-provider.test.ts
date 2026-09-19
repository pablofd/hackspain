import assert from "node:assert/strict";
import { test } from "node:test";
import { createConfiguredVoiceFactory, voiceProfile } from "../src/voice-provider.js";
import type { VoiceFactory } from "../src/azure-realtime.js";
import { ProsperClient } from "../src/prosper.js";
import { config } from "./helpers.js";

const unused: VoiceFactory = async () => { throw new Error("No connection expected"); };

test("Realtime remains the default and Live is never instantiated as a fallback", () => {
  const settings = config({ VOICE_OUTPUT_GAIN_DB: "9" });
  const client = new ProsperClient(settings);
  let realtime = 0;
  const factory = createConfiguredVoiceFactory(settings, client, {
    realtime: (received, api) => {
      assert.equal(received, settings); assert.equal(api, client); realtime += 1;
      return unused;
    },
    live: () => { throw new Error("Live must not start"); },
  });
  assert.equal(factory, unused);
  assert.equal(realtime, 1);
  assert.deepEqual(voiceProfile(settings), {
    connector: "realtime", deployment: "gpt-realtime-1.5", outputGainDb: 9,
  });
});

test("Live uses independent settings and leaves the Realtime deployment/gain unchanged", () => {
  const settings = config({
    VOICE_CONNECTOR: "live", VOICE_OUTPUT_GAIN_DB: "9",
    AZURE_OPENAI_LIVE_DEPLOYMENT: "live-custom", AZURE_OPENAI_LIVE_BACKEND_DEPLOYMENT: "backend-custom",
  });
  const factory = createConfiguredVoiceFactory(settings, new ProsperClient(settings), {
    realtime: () => { throw new Error("No implicit fallback"); },
    live: () => unused,
  });
  assert.equal(factory, unused);
  assert.equal(settings.AZURE_OPENAI_DEPLOYMENT, "gpt-realtime-1.5");
  assert.equal(settings.VOICE_OUTPUT_GAIN_DB, 9);
  assert.deepEqual(voiceProfile(settings), {
    connector: "live", deployment: "live-custom", backendDeployment: "backend-custom", outputGainDb: 0,
  });
});

test("a Live constructor failure is surfaced, not converted into a Realtime call", () => {
  const settings = config({ VOICE_CONNECTOR: "live" });
  assert.throws(() => createConfiguredVoiceFactory(settings, new ProsperClient(settings), {
    realtime: () => { throw new Error("Wrong fallback"); },
    live: () => { throw new Error("Explicit Live failure"); },
  }), /Explicit Live failure/);
});

test("a different Realtime deployment changes only the existing Realtime profile", () => {
  const settings = config({ VOICE_CONNECTOR: "realtime", AZURE_OPENAI_DEPLOYMENT: "gpt-realtime-2" });
  assert.equal(createConfiguredVoiceFactory(settings, new ProsperClient(settings), {
    realtime: (received) => {
      assert.equal(received.AZURE_OPENAI_DEPLOYMENT, "gpt-realtime-2");
      assert.equal(received.AZURE_OPENAI_API_VERSION, "2024-10-01-preview");
      return unused;
    },
    live: () => { throw new Error("Live must not start"); },
  }), unused);
  assert.deepEqual(voiceProfile(settings), { connector: "realtime", deployment: "gpt-realtime-2", outputGainDb: 0 });
});
