import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  CALL_AUDIO_HEADER_BYTES,
  CALL_AUDIO_MAX_BYTES,
  CALL_AUDIO_MAX_SAMPLES,
  createCallAudioWriter,
  decodeMuLaw,
  readCallAudioSampleCount,
  type CallAudioDirection,
} from "../src/call-audio.js";
import { AppError } from "../src/errors.js";

function fixture(t: TestContext) {
  const root = join(".local", `call-audio-test-${crypto.randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "synthetic.wav");
  const fd = fs.openSync(path, "wx+", 0o600);
  t.after(() => {
    fs.closeSync(fd);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { fd, path, writer: createCallAudioWriter(fd) };
}

function frame(value: number): Buffer {
  return Buffer.alloc(160, value);
}

function sample(wav: Buffer, position: number, channel: 0 | 1): number {
  return wav.readInt16LE(CALL_AUDIO_HEADER_BYTES + position * 4 + channel * 2);
}

function safeError(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test("decodes exact G.711 mu-law values, both zero codes, signs and full scale", () => {
  for (const [encoded, decoded] of [
    [0xff, 0], [0x7f, 0], [0xfe, 8], [0x7e, -8], [0xfd, 16], [0x7d, -16],
    [0xf0, 120], [0x70, -120], [0xef, 132], [0x6f, -132], [0xd5, 716], [0x55, -716],
    [0x80, 32_124], [0x00, -32_124],
  ]) {
    assert.equal(decodeMuLaw(encoded!), decoded);
  }
  for (let encoded = 0; encoded < 128; encoded += 1) {
    assert.equal(decodeMuLaw(encoded) + decodeMuLaw(encoded + 128), 0);
  }
  for (const invalid of [-1, 256, 0.5, NaN, Infinity, "255"]) {
    assert.throws(() => decodeMuLaw(invalid as number), safeError("call_recording_invalid_audio"));
  }
});

test("writes a standard PCM16 little-endian stereo 8kHz header, valid even while active", (t) => {
  const { writer, path, fd } = fixture(t);
  assert.equal(fs.statSync(path).size, 44);
  assert.equal(readCallAudioSampleCount(fd, 44), 0);
  writer.append("caller", frame(0xfe), 0);
  const wav = fs.readFileSync(path);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 8_000);
  assert.equal(wav.readUInt32LE(28), 32_000);
  assert.equal(wav.readUInt16LE(32), 4);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), 640);
  assert.equal(wav.length, 684);
  assert.equal(readCallAudioSampleCount(fd, wav.length), 160);
  for (let index = 0; index < 160; index += 1) {
    assert.equal(sample(wav, index, 0), 8);
    assert.equal(sample(wav, index, 1), 0);
  }
});

test("overlapping channels preserve each other and do not mutate mu-law input", (t) => {
  const { writer, path } = fixture(t);
  const caller = frame(0x80);
  const agent = frame(0x00);
  writer.append("caller", caller, 0);
  writer.append("agent", agent, 0);
  const wav = fs.readFileSync(path);
  assert.ok(caller.equals(frame(0x80)));
  assert.ok(agent.equals(frame(0x00)));
  assert.equal(wav.length, 684);
  for (let index = 0; index < 160; index += 1) {
    assert.equal(sample(wav, index, 0), 32_124);
    assert.equal(sample(wav, index, 1), -32_124);
  }
});

test("timestamps preserve gaps and advance overlapping frames only within their own channel", (t) => {
  const { writer, path } = fixture(t);
  writer.append("caller", frame(0xfe), 100);
  writer.append("agent", frame(0x7e), 0);
  writer.append("caller", frame(0xfd), 90);
  writer.append("caller", frame(0xfc), 160);
  writer.append("agent", frame(0x7d), 15);
  writer.append("agent", frame(0x7c), 105);
  const wav = fs.readFileSync(path);
  for (let index = 0; index < 1_440; index += 1) {
    const caller = index >= 800 && index < 960 ? 8
      : index >= 960 && index < 1_120 ? 16 : index >= 1_280 ? 24 : 0;
    const agent = index < 160 ? -8 : index < 320 ? -16
      : index >= 840 && index < 1_000 ? -24 : 0;
    assert.equal(sample(wav, index, 0), caller, `caller sample ${index}`);
    assert.equal(sample(wav, index, 1), agent, `agent sample ${index}`);
  }
  assert.equal(writer.summary().durationMs, 180);
  assert.equal(writer.summary().caller.samples, 480);
  assert.equal(writer.summary().agent.samples, 480);
});

test("sub-millisecond offsets round down to the 8kHz sample grid", (t) => {
  const { writer, path } = fixture(t);
  writer.append("agent", frame(0x7e), 0.249);
  const wav = fs.readFileSync(path);
  assert.equal(wav.length, 44 + 161 * 4);
  assert.equal(sample(wav, 0, 1), 0);
  assert.equal(sample(wav, 1, 1), -8);
  assert.equal(writer.summary().durationMs, 20.125);
});

test("statistics measure captured samples, not sparse gaps, with finite RMS and null silent dBFS", (t) => {
  const { writer } = fixture(t);
  const captured = frame(0xff);
  captured.fill(0xfe, 80, 120);
  captured.fill(0x7e, 120);
  writer.append("caller", captured, 1_000);
  writer.append("agent", frame(0x7f), 0);
  const summary = writer.summary();
  assert.equal(summary.durationMs, 1_020);
  assert.deepEqual(summary.caller, {
    frames: 1, samples: 160, zeroSamples: 80, peakAmplitude: 8,
    rms: Math.sqrt(32), dbfs: 20 * Math.log10(Math.sqrt(32) / 32_768),
  });
  assert.deepEqual(summary.agent, { frames: 1, samples: 160, zeroSamples: 160, peakAmplitude: 0, rms: 0, dbfs: null });
  assert.doesNotThrow(() => JSON.stringify(summary));
  const empty = fixture(t).writer.summary();
  assert.equal(empty.durationMs, 0);
  assert.deepEqual(empty.caller, { frames: 0, samples: 0, zeroSamples: 0, peakAmplitude: 0, rms: 0, dbfs: null });
});

test("duration and file size are bounded even for sparse offsets and repeated overlap", (t) => {
  const { writer, fd, path } = fixture(t);
  writer.append("caller", frame(0xfe), 184_980);
  assert.equal(fs.statSync(path).size, CALL_AUDIO_MAX_BYTES);
  assert.equal(CALL_AUDIO_MAX_BYTES, 5_920_044);
  assert.equal(readCallAudioSampleCount(fd, CALL_AUDIO_MAX_BYTES), CALL_AUDIO_MAX_SAMPLES);
  assert.equal(writer.summary().durationMs, 185_000);
  assert.throws(() => writer.append("caller", frame(0xfe), 0), safeError("call_recording_audio_too_long"));
  assert.equal(fs.statSync(path).size, CALL_AUDIO_MAX_BYTES);
  assert.equal(writer.summary().caller.frames, 1);
  const late = fixture(t);
  assert.throws(() => late.writer.append("agent", frame(0xff), 184_981), safeError("call_recording_audio_too_long"));
  assert.equal(fs.statSync(late.path).size, 44);
  const huge = fixture(t);
  assert.throws(() => huge.writer.append("caller", frame(0xff), 1e308), safeError("call_recording_audio_too_long"));
  assert.equal(fs.statSync(huge.path).size, 44);
});

test("invalid directions, frames and timestamps fail explicitly before writing", (t) => {
  const cases: [unknown, unknown, unknown][] = [
    ["other", frame(0xff), 0], [null, frame(0xff), 0],
    ["caller", null, 0], ["agent", new Array(160).fill(255), 0],
    ["caller", Buffer.alloc(0), 0], ["caller", Buffer.alloc(159), 0], ["caller", Buffer.alloc(161), 0],
    ["caller", frame(0xff), -1], ["agent", frame(0xff), NaN],
    ["caller", frame(0xff), Infinity], ["caller", frame(0xff), "0"],
  ];
  for (const [direction, audio, elapsedMs] of cases) {
    const { writer, path } = fixture(t);
    assert.throws(
      () => writer.append(direction as CallAudioDirection, audio as Uint8Array, elapsedMs as number),
      safeError("call_recording_invalid_audio"),
    );
    assert.equal(fs.statSync(path).size, 44);
    assert.throws(() => writer.append("caller", frame(0xff), 0), safeError("call_recording_invalid_audio"));
  }
});

test("bounded short positional reads and writes preserve both channels and headers", (t) => {
  const { writer, path, fd } = fixture(t);
  const originalWrite = fs.writeSync;
  const originalRead = fs.readSync;
  let largestBuffer = 0;
  t.mock.method(fs, "writeSync", (descriptor: number, buffer: Uint8Array, offset: number, length: number, position: number) => {
    largestBuffer = Math.max(largestBuffer, buffer.byteLength);
    return originalWrite(descriptor, buffer, offset, Math.min(length, 7), position);
  });
  t.mock.method(fs, "readSync", (descriptor: number, buffer: Uint8Array, offset: number, length: number, position: number) => {
    largestBuffer = Math.max(largestBuffer, buffer.byteLength);
    return originalRead(descriptor, buffer, offset, Math.min(length, 5), position);
  });
  writer.append("agent", frame(0x7e), 0);
  writer.append("caller", frame(0xfe), 0);
  assert.equal(readCallAudioSampleCount(fd, 684), 160);
  assert.equal(largestBuffer, 640);
  const wav = fs.readFileSync(path);
  assert.equal(sample(wav, 159, 0), 8);
  assert.equal(sample(wav, 159, 1), -8);
});

test("header validation rejects malformed, truncated, oversized and mismatched files", (t) => {
  const { fd, path, writer } = fixture(t);
  writer.append("caller", frame(0xff), 0);
  const canonical = fs.readFileSync(path);
  for (const byte of [0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40]) {
    const changed = Buffer.from(canonical);
    changed[byte] = changed[byte]! ^ 1;
    fs.writeSync(fd, changed, 0, changed.length, 0);
    assert.equal(readCallAudioSampleCount(fd, changed.length), undefined);
  }
  for (const size of [-1, 0, 43, 45, 684.5, NaN, Infinity, CALL_AUDIO_MAX_BYTES + 4]) {
    assert.equal(readCallAudioSampleCount(fd, size), undefined);
  }
  fs.ftruncateSync(fd, 20);
  assert.equal(readCallAudioSampleCount(fd, canonical.length), undefined);
});

test("zero writes, unexpected EOF and thrown I/O errors produce safe sticky failures", (t) => {
  const zero = fixture(t);
  const zeroWrite = t.mock.method(fs, "writeSync", () => 0);
  assert.throws(() => zero.writer.append("caller", frame(0xff), 0), safeError("call_recording_io_failed"));
  zeroWrite.mock.restore();
  assert.throws(() => zero.writer.append("caller", frame(0xff), 0), safeError("call_recording_io_failed"));
  const truncated = fixture(t);
  truncated.writer.append("caller", frame(0xfe), 0);
  fs.ftruncateSync(truncated.fd, 44);
  assert.throws(() => truncated.writer.append("agent", frame(0xff), 0), safeError("call_recording_io_failed"));
  const failed = fixture(t);
  const failingWrite = t.mock.method(fs, "writeSync", () => { throw new Error("synthetic-private-path"); });
  assert.throws(() => failed.writer.append("caller", frame(0xff), 0), safeError("call_recording_io_failed"));
  failingWrite.mock.restore();
  assert.throws(() => createCallAudioWriter(failed.fd), safeError("call_recording_io_failed"));
});
