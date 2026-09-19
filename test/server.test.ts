import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import WebSocket from "ws";
import { z } from "zod";
import { createCallRecordStore } from "../src/call-records.js";
import type { VoiceFactory } from "../src/azure-realtime.js";
import { decodeAudio, parsePacket } from "../src/protocol.js";
import { createVoiceServer, validAuthorization } from "../src/server.js";
import { config } from "./helpers.js";

function start(callId: string) {
  return {
    event: "start",
    start: {
      callSid: callId, streamSid: `stream-${callId}`,
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
    },
  };
}

test("endpoint authentication is required and never accepts a prefix match", () => {
  const token = "test-token";
  assert.ok(validAuthorization(`Bearer ${token}`, token));
  assert.ok(!validAuthorization(undefined, token));
  assert.ok(!validAuthorization(`Bearer ${token}suffix`, token));
  assert.ok(!validAuthorization(`Basic ${token}`, token));
});

async function exerciseConcurrentCalls(count: number, recordAudio = false): Promise<void> {
  const directory = recordAudio ? mkdtempSync(join(tmpdir(), "hackspain-parallel-audio-")) : undefined;
  const settings = config(recordAudio ? { CALL_RECORDING_ENABLED: "true", CALL_AUDIO_RECORDING_ENABLED: "true" } : {});
  const store = directory ? createCallRecordStore({ directory, retentionDays: 7, secrets: [], recordAudio: true }) : undefined;
  const opened = new Set<string>();
  const closed = new Set<string>();
  const factory: VoiceFactory = async (call) => {
    await delay(40);
    opened.add(call.callId);
    return {
      sendAudio(payload) {
        call.onAudio({ audio: decodeAudio(payload), itemId: call.callId, contentIndex: 0 });
        call.onAudioDone(call.callId);
      },
      sendText() {},
      async close() { closed.add(call.callId); },
    };
  };
  const server = createVoiceServer(settings, factory, "console", store);
  const port = await server.listen();
  try {
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const id = `call-${index}`;
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Authorization: `Bearer ${settings.VOICE_ENDPOINT_TOKEN}` },
      });
      await once(client, "open");
      const response = once(client, "message");
      client.send(JSON.stringify(start(id)));
      client.send(JSON.stringify({
        event: "media", streamSid: `stream-${id}`,
        media: { payload: Buffer.alloc(160, 0x80 + index).toString("base64") },
      }));
      const [raw] = await response;
      const packet = parsePacket(String(raw));
      assert.ok(packet.event === "media");
      assert.equal(packet.streamSid, `stream-${id}`);
      assert.deepEqual(decodeAudio(packet.media.payload), Buffer.alloc(160, 0x80 + index));
      const ended = once(client, "close");
      client.send(JSON.stringify({ event: "stop", streamSid: `stream-${id}` }));
      await ended;
    }));
    assert.equal(opened.size, count);
    assert.deepEqual(closed, opened);
    const health: unknown = await fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.json());
    assert.deepEqual(health, {
      status: "ok", activeCalls: 0, telemetry: "console",
      capabilities: ["voice", "clinic", "book", "reschedule", "cancel", "register", "outcomes"],
      localRecording: recordAudio,
      localAudioRecording: recordAudio,
    });
    if (directory) {
      const files = readdirSync(directory);
      assert.equal(files.filter((name) => name.endsWith(".wav")).length, count);
      for (const filename of files.filter((name) => name.endsWith(".ndjson"))) {
        const records = readFileSync(join(directory, filename), "utf8").trim().split("\n");
        const end = z.object({ audio: z.object({
          caller: z.object({ frames: z.number(), samples: z.number(), peakAmplitude: z.number() }),
          agent: z.object({ frames: z.number(), samples: z.number(), peakAmplitude: z.number(), zeroSamples: z.number() }),
        }) }).parse(JSON.parse(records.at(-1) ?? ""));
        assert.equal(end.audio.caller.frames, 1);
        assert.ok(end.audio.agent.frames >= 1);
        assert.equal(end.audio.caller.samples, 160);
        assert.equal(end.audio.agent.samples, end.audio.agent.frames * 160);
        assert.equal(end.audio.agent.zeroSamples, end.audio.agent.samples - 160);
        assert.equal(end.audio.caller.peakAmplitude, end.audio.agent.peakAmplitude);
      }
    }
  } finally {
    await server.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

for (const count of [10, 20]) {
  test(`${count} concurrent calls keep isolated ids, buffers and cleanup`, { timeout: 10_000 },
    () => exerciseConcurrentCalls(count));
}

test("ten concurrent calls keep independent private audio recordings", { timeout: 10_000 },
  () => exerciseConcurrentCalls(10, true));

test("the wire includes exactly four seconds of end-of-turn silence, not an endless idle stream", { timeout: 10000 }, async () => {
  const settings = config();
  const messages: Buffer[] = [];
  let speak: (() => void) | undefined;
  const ready = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const server = createVoiceServer(settings, async (call) => {
    speak = () => {
      call.onAudio({ audio: Buffer.alloc(320, 0x80), itemId: "synthetic-question", contentIndex: 0 });
      call.onAudioDone("synthetic-question");
    };
    ready.resolve();
    return { sendAudio() {}, sendText() {}, async close() {} };
  }, "console");
  const port = await server.listen();
  try {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: `Bearer ${settings.VOICE_ENDPOINT_TOKEN}` },
    });
    client.on("message", (raw) => {
      const packet = parsePacket(String(raw));
      assert.equal(packet.event, "media");
      if (packet.event !== "media") return;
      assert.equal(packet.streamSid, "stream-endpointing");
      messages.push(decodeAudio(packet.media.payload));
      if (messages.length === 202) completed.resolve();
    });
    await once(client, "open");
    client.send(JSON.stringify(start("endpointing")));
    await ready.promise;
    await delay(60);
    assert.equal(messages.length, 0);
    assert.ok(speak);
    speak();
    await completed.promise;
    await delay(80);
    assert.equal(messages.length, 202);
    assert.deepEqual(messages.slice(0, 2), [Buffer.alloc(160, 0x80), Buffer.alloc(160, 0x80)]);
    assert.ok(messages.slice(2).every((frame) => frame.length === 160 && frame.every((sample) => sample === 0xff)));
    const ended = once(client, "close");
    client.send(JSON.stringify({ event: "stop", streamSid: "stream-endpointing" }));
    await ended;
  } finally {
    await server.close();
  }
});

test("a connection over the configured cap is rejected before starting Azure", { timeout: 5000 }, async () => {
  const settings = config({ MAX_CONCURRENT_CALLS: "1" });
  let opened = false;
  const server = createVoiceServer(settings, async () => {
    opened = true;
    throw new Error("Should not be called");
  }, "console");
  const port = await server.listen();
  const first = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Authorization: `Bearer ${settings.VOICE_ENDPOINT_TOKEN}` },
  });
  try {
    await once(first, "open");
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const second = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Authorization: `Bearer ${settings.VOICE_ENDPOINT_TOKEN}` },
      });
      second.once("unexpected-response", (_request, response) => {
        response.resume();
        second.terminate();
        resolve(response.statusCode);
      });
      second.once("error", reject);
    });
    assert.equal(status, 503);
    assert.equal(opened, false);
  } finally {
    first.close();
    await server.close();
  }
});

test("disconnecting while Azure opens aborts and cleans up the eventual session", { timeout: 5000 }, async () => {
  const settings = config();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const cleaned = Promise.withResolvers<void>();
  const server = createVoiceServer(settings, async (call) => {
    call.signal.addEventListener("abort", () => release.resolve(), { once: true });
    started.resolve();
    await release.promise;
    return {
      sendAudio() { throw new Error("Audio must not reach a closed call"); },
      sendText() {},
      async close() { cleaned.resolve(); },
    };
  }, "console");
  const port = await server.listen();
  try {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: `Bearer ${settings.VOICE_ENDPOINT_TOKEN}` },
    });
    await once(client, "open");
    client.send(JSON.stringify(start("disconnect")));
    await started.promise;
    client.close();
    await cleaned.promise;
  } finally {
    await server.close();
  }
});

test("unauthorized upgrades and invalid media do not start an Azure session", { timeout: 5000 }, async () => {
  let opened = false;
  const settings = config();
  const server = createVoiceServer(settings, async () => {
    opened = true;
    throw new Error("Should not be called");
  }, "console");
  const port = await server.listen();
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      client.once("unexpected-response", (_request, response) => {
        response.resume();
        client.terminate();
        resolve(response.statusCode);
      });

      client.once("error", reject);
    });
    assert.equal(status, 401);
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: `Bearer ${settings.VOICE_ENDPOINT_TOKEN}` },
    });
    await once(client, "open");
    const ended = once(client, "close");
    client.send(JSON.stringify({ event: "start", start: { callSid: "invalid" } }));
    await ended;
    assert.equal(opened, false);
  } finally {
    await server.close();
  }
});

test("records transcripts and accepted actions privately through the actual server lifecycle", { timeout: 5000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "hackspain-recorded-server-"));
  const store = createCallRecordStore({
    directory, retentionDays: 7, secrets: ["synthetic-test-secret"],
  });
  const settings = config();
  const ready = Promise.withResolvers<void>();
  const server = createVoiceServer(settings, async (call) => {
    assert.equal(call.allowSubmissions, true);
    assert.ok(call.startedAt instanceof Date);
    call.onRecord?.({ type: "transcript", speaker: "user", itemId: "test-user", text: "Synthetic question" });
    call.onRecord?.({ type: "transcript", speaker: "assistant", itemId: "test-agent", text: "Synthetic response" });
    ready.resolve();
    return {
      sendAudio() {},
      sendText() {},
      async close() {
        call.onRecord?.({
          type: "action", stage: "accepted", proposalId: "proposal-test",
          action: { action: "NO_ACTION", reason: "out_of_scope" },
        });
      },
    };
  }, "console", store);
  const port = await server.listen();
  try {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: `Bearer ${settings.VOICE_ENDPOINT_TOKEN}` },
    });
    await once(client, "open");
    client.send(JSON.stringify(start("recorded")));
    await ready.promise;
    const ended = once(client, "close");
    client.send(JSON.stringify({ event: "stop", streamSid: "stream-recorded" }));
    await ended;
    await server.close();
    const file = readdirSync(directory).find((name) => name.endsWith(".ndjson"));
    assert.ok(file);
    const path = join(directory, file);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const records = readFileSync(path, "utf8").trim().split("\n").map((line) =>
      z.object({ type: z.string() }).passthrough().parse(JSON.parse(line)));
    assert.equal(records[0]?.type, "start");
    assert.equal(records.filter((record) => record.type === "transcript").length, 2);
    assert.ok(records.some((record) => record.type === "action" && record.stage === "accepted"));
    assert.equal(records.at(-1)?.type, "end");
    assert.equal(records.at(-1)?.reason, "prosper_stop");
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("records caller frames and only emitted agent frames in a private stereo WAV", { timeout: 5000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "hackspain-audio-server-"));
  const settings = config({ CALL_RECORDING_ENABLED: "true", CALL_AUDIO_RECORDING_ENABLED: "true" });
  const store = createCallRecordStore({ directory, retentionDays: 7, secrets: [], recordAudio: true });
  const server = createVoiceServer(settings, async (call) => ({
    sendAudio() {
      call.onAudio({ audio: Buffer.alloc(480, 0x80), itemId: "not-played", contentIndex: 0 });
      call.onInterrupt();
      call.onAudio({ audio: Buffer.alloc(160, 0x00), itemId: "played", contentIndex: 0 });
      call.onAudioDone("played");
    },
    sendText() {},
    async close() {},
  }), "console", store);
  const port = await server.listen();
  try {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: `Bearer ${settings.VOICE_ENDPOINT_TOKEN}` },
    });
    await once(client, "open");
    const response = once(client, "message");
    client.send(JSON.stringify(start("audio-recorded")));
    client.send(JSON.stringify({
      event: "media", streamSid: "stream-audio-recorded",
      media: { payload: Buffer.alloc(160, 0x80).toString("base64") },
    }));
    const [raw] = await response;
    const packet = parsePacket(String(raw));
    assert.ok(packet.event === "media");
    assert.deepEqual(decodeAudio(packet.media.payload), Buffer.alloc(160, 0x00));
    const privateWave = readdirSync(directory).find((name) => name.endsWith(".wav"));
    assert.ok(privateWave);
    assert.equal((await fetch(`http://127.0.0.1:${port}/.local/calls/${privateWave}`)).status, 404);
    const ended = once(client, "close");
    client.send(JSON.stringify({ event: "stop", streamSid: "stream-audio-recorded" }));
    await ended;
    await server.close();
    const textFile = readdirSync(directory).find((name) => name.endsWith(".ndjson"));
    assert.ok(textFile);
    const wavFile = textFile.replace(/\.ndjson$/, ".wav");
    const wave = readFileSync(join(directory, wavFile));
    assert.equal(statSync(join(directory, wavFile)).mode & 0o777, 0o600);
    assert.equal(wave.toString("ascii", 0, 4), "RIFF");
    assert.equal(wave.toString("ascii", 8, 12), "WAVE");
    assert.equal(wave.readUInt16LE(20), 1);
    assert.equal(wave.readUInt16LE(22), 2);
    assert.equal(wave.readUInt32LE(24), 8000);
    assert.equal(wave.readUInt32LE(40), wave.length - 44);
    let callerSamples = 0;
    let agentSamples = 0;
    for (let offset = 44; offset < wave.length; offset += 4) {
      const caller = wave.readInt16LE(offset);
      const agent = wave.readInt16LE(offset + 2);
      assert.ok(caller === 0 || caller === 32124);
      assert.ok(agent === 0 || agent === -32124, "Unplayed generated audio must not enter the recording");
      callerSamples += Number(caller !== 0);
      agentSamples += Number(agent !== 0);
    }
    assert.equal(callerSamples, 160);
    assert.equal(agentSamples, 160);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
