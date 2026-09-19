import assert from "node:assert/strict";
import { test } from "node:test";
import { AudioQueue, createMuLawGain } from "../src/audio.js";
import { decodeMuLaw } from "../src/call-audio.js";
import { decodeAudio, parsePacket } from "../src/protocol.js";

test("audio is split into exact 20 ms mu-law frames, with a padded final frame", () => {
  const queue = new AudioQueue();
  queue.push({ audio: Buffer.alloc(321, 0x80), itemId: "item", contentIndex: 0 });
  assert.equal(queue.next()?.length, 160);
  assert.equal(queue.next()?.length, 160);
  assert.equal(queue.next(), undefined);
  queue.finish("item");
  const final = queue.next();
  assert.equal(final?.length, 160);
  assert.equal(final?.[0], 0x80);
  assert.equal(final?.[159], 0xff);
  assert.equal(queue.next(), undefined);
  assert.equal(queue.interrupt(), undefined);
});

test("optional mu-law gain preserves duration, silence and polarity with bounded quantized amplification", () => {
  const all = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  assert.equal(createMuLawGain(0)(all), all);
  const gained = createMuLawGain(9)(all);
  assert.equal(gained.length, all.length);
  assert.equal(gained[0xff], 0xff);
  assert.equal(gained[0x7f], 0x7f);
  for (let index = 0; index < 256; index += 1) {
    const before = decodeMuLaw(index);
    const after = decodeMuLaw(gained[index]!);
    assert.equal(Math.sign(after), Math.sign(before));
    assert.ok(Math.abs(after) >= Math.abs(before));
    assert.ok(Math.abs(after) <= 32124);
    if (before && Math.abs(before) < 8000) {
      assert.ok(Math.abs(20 * Math.log10(Math.abs(after / before)) - 9) < 0.6);
    }
  }
  for (const value of [-1, 13, NaN, Infinity]) {
    assert.throws(() => createMuLawGain(value), { code: "invalid_output_gain" });
  }
});
test("barge-in drops pending and late audio and reports only playback already sent", () => {
  const queue = new AudioQueue();
  queue.push({ audio: Buffer.alloc(640, 0x80), itemId: "old", contentIndex: 0 });
  queue.next();
  assert.deepEqual(queue.interrupt(), { itemId: "old", contentIndex: 0, audioEndMs: 20 });
  queue.push({ audio: Buffer.alloc(160), itemId: "old", contentIndex: 0 });
  assert.equal(queue.next(), undefined);
  queue.push({ audio: Buffer.alloc(160, 0x82), itemId: "new", contentIndex: 0 });
  assert.equal(queue.next()?.[0], 0x82);
});

test("audio queue is bounded", () => {
  const queue = new AudioQueue(1);
  assert.throws(() => queue.push({ audio: Buffer.alloc(320), itemId: "item", contentIndex: 0 }));
});

test("completed speech gets exactly 1200 ms of paced endpointing silence, never an endless idle stream", () => {
  const queue = new AudioQueue(1500, 60);
  assert.equal(queue.next(), undefined);
  queue.push({ audio: Buffer.alloc(320, 0x80), itemId: "complete", contentIndex: 0 });
  queue.finish("complete");
  assert.deepEqual(queue.next(), Buffer.alloc(160, 0x80));
  assert.deepEqual(queue.next(), Buffer.alloc(160, 0x80));
  for (let frame = 0; frame < 60; frame += 1) {
    assert.deepEqual(queue.next(), Buffer.alloc(160, 0xff));
  }
  assert.equal(queue.next(), undefined);
  assert.equal(queue.next(), undefined);
  assert.equal(queue.interrupt(), undefined, "Transport silence must not extend provider audio truncation");
});

test("endpointing silence waits for audio.done rather than ending a temporarily empty stream", () => {
  const queue = new AudioQueue(1500, 60);
  queue.push({ audio: Buffer.alloc(160, 0x80), itemId: "streaming", contentIndex: 0 });
  queue.next();
  assert.equal(queue.next(), undefined);
  queue.push({ audio: Buffer.alloc(80, 0x82), itemId: "streaming", contentIndex: 0 });
  assert.equal(queue.next(), undefined);
  queue.finish("streaming");
  const tail = queue.next();
  assert.deepEqual(tail?.subarray(0, 80), Buffer.alloc(80, 0x82));
  assert.deepEqual(tail?.subarray(80), Buffer.alloc(80, 0xff));
  assert.deepEqual(queue.next(), Buffer.alloc(160, 0xff));
});

test("new speech bypasses an old silence tail and interruption drops both speech and padding", () => {
  const queue = new AudioQueue(1500, 60);
  queue.push({ audio: Buffer.alloc(160, 0x80), itemId: "first", contentIndex: 0 });
  queue.finish("first");
  queue.next();
  assert.deepEqual(queue.next(), Buffer.alloc(160, 0xff));
  queue.push({ audio: Buffer.alloc(320, 0x82), itemId: "second", contentIndex: 0 });
  queue.finish("second");
  assert.deepEqual(queue.next(), Buffer.alloc(160, 0x82));
  assert.deepEqual(queue.interrupt(), { itemId: "second", contentIndex: 0, audioEndMs: 20 });
  assert.equal(queue.next(), undefined);
  queue.finish("second");
  assert.equal(queue.next(), undefined);
});

test("interrupting a completed silence tail does not truncate or resurrect already played content", () => {
  const queue = new AudioQueue(1500, 60);
  queue.push({ audio: Buffer.alloc(160, 0x80), itemId: "first", contentIndex: 0 });
  queue.finish("first");
  queue.next();
  queue.next();
  assert.equal(queue.interrupt(), undefined);
  assert.equal(queue.next(), undefined);
  queue.push({ audio: Buffer.alloc(160, 0x82), itemId: "second", contentIndex: 0 });
  assert.deepEqual(queue.next(), Buffer.alloc(160, 0x82));
  assert.equal(queue.next(), undefined);
});

test("interruption reports played and every queued unheard item for complete context truncation", () => {
  const queue = new AudioQueue();
  queue.push({ audio: Buffer.alloc(320, 0x80), itemId: "playing", contentIndex: 0 });
  queue.finish("playing");
  queue.push({ audio: Buffer.alloc(160, 0x82), itemId: "unheard", contentIndex: 0 });
  queue.push({ audio: Buffer.alloc(80, 0x83), itemId: "partial-unheard", contentIndex: 0 });
  queue.next();
  assert.deepEqual(queue.interruptAll(), [
    { itemId: "playing", contentIndex: 0, audioEndMs: 20 },
    { itemId: "unheard", contentIndex: 0, audioEndMs: 0 },
    { itemId: "partial-unheard", contentIndex: 0, audioEndMs: 0 },
  ]);
  for (const itemId of ["playing", "unheard", "partial-unheard"]) {
    queue.push({ audio: Buffer.alloc(160, 0x84), itemId, contentIndex: 0 });
  }
  assert.equal(queue.next(), undefined);
  assert.deepEqual(queue.interruptAll(), []);
});

test("switching items pads the previous tail without mixing their samples", () => {
  const queue = new AudioQueue();
  queue.push({ audio: Buffer.alloc(81, 0x80), itemId: "first", contentIndex: 0 });
  queue.push({ audio: Buffer.alloc(160, 0x82), itemId: "second", contentIndex: 0 });
  const first = queue.next();
  assert.deepEqual(first?.subarray(0, 81), Buffer.alloc(81, 0x80));
  assert.deepEqual(first?.subarray(81), Buffer.alloc(79, 0xff));
  assert.deepEqual(queue.interrupt(), { itemId: "second", contentIndex: 0, audioEndMs: 0 });
  assert.equal(queue.next(), undefined);
  queue.push({ audio: Buffer.alloc(160), itemId: "second", contentIndex: 0 });
  assert.equal(queue.next(), undefined);
});

test("content changes do not merge tails, and truncation excludes silence padding", () => {
  const queue = new AudioQueue();
  queue.push({ audio: Buffer.alloc(241, 0x80), itemId: "item", contentIndex: 0 });
  queue.push({ audio: Buffer.alloc(160, 0x82), itemId: "item", contentIndex: 1 });
  assert.equal(queue.next()?.length, 160);
  const tail = queue.next();
  assert.deepEqual(tail?.subarray(0, 81), Buffer.alloc(81, 0x80));
  assert.deepEqual(tail?.subarray(81), Buffer.alloc(79, 0xff));
  assert.deepEqual(queue.interrupt(), { itemId: "item", contentIndex: 0, audioEndMs: 30 });
  assert.equal(queue.next(), undefined);
});

test("playback accounting starts again for a new content index", () => {
  const queue = new AudioQueue();
  queue.push({ audio: Buffer.alloc(320), itemId: "item", contentIndex: 0 });
  queue.push({ audio: Buffer.alloc(320), itemId: "item", contentIndex: 1 });
  queue.next();
  queue.next();
  queue.next();
  assert.deepEqual(queue.interrupt(), { itemId: "item", contentIndex: 1, audioEndMs: 20 });
});

test("switching at capacity does not consume or corrupt the old partial tail", () => {
  const queue = new AudioQueue(1);
  queue.push({ audio: Buffer.alloc(81, 0x80), itemId: "first", contentIndex: 0 });
  assert.throws(() => queue.push({ audio: Buffer.alloc(160), itemId: "second", contentIndex: 0 }),
    { code: "audio_output_backpressure" });
  assert.equal(queue.next(), undefined);
  queue.finish("first");
  queue.finish("first");
  assert.deepEqual(queue.next()?.subarray(0, 81), Buffer.alloc(81, 0x80));
  assert.equal(queue.next(), undefined);
});

test("an unheard partial tail is truncated at zero and cannot be resurrected by finish", () => {
  const queue = new AudioQueue();
  queue.push({ audio: Buffer.alloc(159), itemId: "item", contentIndex: 0 });
  assert.deepEqual(queue.interrupt(), { itemId: "item", contentIndex: 0, audioEndMs: 0 });
  queue.finish("item");
  queue.push({ audio: Buffer.alloc(160), itemId: "item", contentIndex: 0 });
  assert.equal(queue.next(), undefined);
});

test("invalid JSON, mismatched call ids and invalid base64 are rejected", () => {
  assert.throws(() => parsePacket("{"));
  assert.throws(() => decodeAudio("%%%"));
  assert.throws(() => parsePacket(JSON.stringify({
    event: "start",
    start: {
      callSid: "real", streamSid: "stream",
      customParameters: { call_id: "invented" },
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
    },
  })));
});
