import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createCallRecordStore,
  type CallRecordEvent,
  type CallRecordStoreOptions,
} from "../src/call-records.js";
import { AppError } from "../src/errors.js";

const FINISH = { reason: "test_complete", inputBytes: 16, outputBytes: 32 };
const UUID = "00000000-0000-4000-8000-000000000001";
const STARTED_AT = new Date("2026-09-01T12:00:00.000Z");
const DAY_MS = 86_400_000;

function fixture(t: TestContext): { root: string; directory: string; options: CallRecordStoreOptions } {
  // Keep isolated fixtures in the project, never in the operating system's temporary directories.
  const root = join(".local", `call-records-test-${crypto.randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "calls");
  return { root, directory, options: { directory, retentionDays: 7, secrets: [] } };
}

function files(directory: string): string[] {
  return fs.readdirSync(directory).map((name) => join(directory, name));
}

function singleFile(directory: string): string {
  const entries = files(directory);
  assert.equal(entries.length, 1);
  return entries[0]!;
}

function records(path: string): Record<string, unknown>[] {
  const content = fs.readFileSync(path, "utf8");
  assert.ok(content.endsWith("\n"), "NDJSON ends with a newline");
  return content.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function safeError(code?: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof AppError);
    assert.match(error.code, /^call_recording_[a-z_]+$/);
    assert.equal(error.message, error.code);
    assert.equal(error.cause, undefined);
    if (code !== undefined) assert.equal(error.code, code);
    return true;
  };
}

function ownFilename(callId: string, uuid = UUID): string {
  return `call-v1-${callId}-${STARTED_AT.getTime()}-${uuid}.ndjson`;
}

test("records lifecycle and all supported events as private append-only NDJSON", (t) => {
  const { options, directory } = fixture(t);
  const store = createCallRecordStore(options);
  const recorder = store.start("call_safe-01", STARTED_AT);
  const path = singleFile(directory);
  const startPrefix = fs.readFileSync(path);
  const events: CallRecordEvent[] = [
    { type: "transcript", speaker: "user", itemId: "input-1", text: "synthetic input" },
    { type: "transcript", speaker: "assistant", itemId: "output-1", text: "synthetic output" },
    { type: "transcript", speaker: "assistant", itemId: "partial-output", text: "unfinished synthetic output", partial: true },
    { type: "interruption", itemId: "output-1", audioEndMs: 12.5 },
    { type: "interruption", itemId: "partial-output", audioEndMs: 0, reason: "output_limit" },
    { type: "interruption" },
    { type: "tool", name: "availability", status: "ok" },
    { type: "tool", name: "booking", status: "error", code: "test_failure" },
    { type: "action", stage: "proposed", proposalId: "proposal-1", action: { kind: "booking" } },
    { type: "action", stage: "confirmed", proposalId: "proposal-1", action: null },
    { type: "action", stage: "accepted", proposalId: "proposal-1", action: { id: 1 } },
    { type: "action", stage: "duplicate", proposalId: "proposal-1", action: { id: 1 } },
    { type: "action", stage: "failed", proposalId: "proposal-1", action: {}, code: "test_failure" },
    { type: "action", stage: "unknown", proposalId: "proposal-1", action: [] },
    { type: "error", code: "test_failure" },
  ];
  for (const event of events) recorder.append(event);
  recorder.finish(FINISH);
  recorder.finish({ reason: "ignored", inputBytes: 0, outputBytes: 0 });
  assert.equal(singleFile(directory), path);
  assert.ok(fs.readFileSync(path).subarray(0, startPrefix.length).equals(startPrefix));
  const data = records(path);
  assert.deepEqual(data.map((row) => row.type), ["start", ...events.map((event) => event.type), "end"]);
  for (const row of data) {
    assert.equal(row.callId, "call_safe-01");
    assert.equal(row.schemaVersion, 1);
    assert.equal(typeof row.timestamp, "string");
    assert.ok(Number.isFinite(Date.parse(row.timestamp as string)));
  }
  assert.equal(data[0]?.timestamp, STARTED_AT.toISOString());
  assert.equal(data[0]?.assistantTranscriptSource, "generated_audio");
  assert.equal(data.find((row) => row.itemId === "partial-output" && row.type === "transcript")?.partial, true);
  assert.equal(data.find((row) => row.itemId === "partial-output" && row.type === "interruption")?.reason, "output_limit");
  assert.equal(data.at(-1)?.inputBytes, FINISH.inputBytes);
  assert.equal(data.at(-1)?.outputBytes, FINISH.outputBytes);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.throws(() => recorder.append({ type: "error", code: "late" }), safeError("call_recording_closed"));
});

test("redacts raw newline/quote secrets in nested strings and keys before serialization", (t) => {
  const { options, directory } = fixture(t);
  const secret = "synthetic\n\"redaction\\token";
  const keys = [secret, "test-token", "", "test-token"];
  const recorder = createCallRecordStore({ ...options, secrets: keys }).start("redaction", STARTED_AT);
  keys.length = 0;
  recorder.append({ type: "transcript", speaker: "user", itemId: "test-token", text: `prefix ${secret} suffix` });
  recorder.append({
    type: "action", stage: "proposed", proposalId: "test-token",
    action: { [secret]: [{ text: secret, other: "test-token" }], flag: true, count: 3 },
    code: "test-token",
  });
  recorder.finish({ ...FINISH, reason: secret });
  const content = fs.readFileSync(singleFile(directory), "utf8");
  assert.ok(!content.includes(secret));
  assert.ok(!content.includes(JSON.stringify(secret).slice(1, -1)));
  assert.ok(!content.includes("test-token"));
  const data = records(singleFile(directory));
  assert.equal(data[1]?.text, "prefix [REDACTED] suffix");
  assert.equal(data.at(-1)?.reason, "[REDACTED]");
  assert.ok(content.includes("[REDACTED]"));
});

test("independent calls with identical IDs and timestamps use unpredictable exclusive files", (t) => {
  const { options, directory } = fixture(t);
  const store = createCallRecordStore(options);
  const first = store.start("same-id", STARTED_AT);
  const second = store.start("same-id", STARTED_AT);
  first.append({ type: "tool", name: "first_only", status: "ok" });
  second.append({ type: "error", code: "second_only" });
  second.finish(FINISH);
  first.finish(FINISH);
  const entries = files(directory);
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0], entries[1]);
  for (const path of entries) {
    assert.match(path, /call-v1-same-id-\d+-[0-9a-f-]{36}\.ndjson$/);
    assert.equal(records(path).length, 3);
  }
  assert.deepEqual(entries.map((path) => records(path)[1]?.type).sort(), ["error", "tool"]);
});

test("rejects invalid IDs, dates, directory traversal and unsafe retention values", (t) => {
  const { options, root, directory } = fixture(t);
  const store = createCallRecordStore(options);
  for (const id of ["", ".", "..", "../escape", "a/b", "a\\b", "/absolute", "a\nb", "a\0b", "a b", "x".repeat(129)]) {
    assert.throws(() => store.start(id, STARTED_AT), safeError("call_recording_invalid_call"));
  }
  assert.throws(() => store.start("valid", new Date(NaN)), safeError("call_recording_invalid_call"));
  assert.equal(files(directory).length, 0);
  for (const retentionDays of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createCallRecordStore({ ...options, retentionDays }), safeError("call_recording_invalid_options"));
  }
  for (const invalidDirectory of ["", "/", `${root}/../escape`, `${root}/nul\0`, `${root}\\calls`]) {
    assert.throws(
      () => createCallRecordStore({ ...options, directory: invalidDirectory }),
      safeError("call_recording_invalid_options"),
    );
  }
  assert.doesNotThrow(() => createCallRecordStore({
    ...options, retentionDays: Math.floor(Number.MAX_SAFE_INTEGER / DAY_MS),
  }));
});

test("rejects symlink storage directories and ancestor components without changing their targets", (t) => {
  const { options, root } = fixture(t);
  const target = join(root, "target");
  fs.mkdirSync(target, { mode: 0o755 });
  const mode = fs.statSync(target).mode;
  const link = join(root, "link");
  fs.symlinkSync(resolve(target), link, "dir");
  for (const directory of [link, join(link, "calls")]) {
    assert.throws(
      () => createCallRecordStore({ ...options, directory }),
      safeError("call_recording_unsafe_path"),
    );
  }
  assert.equal(fs.statSync(target).mode, mode);
  assert.deepEqual(fs.readdirSync(target), []);
});

test("rechecks directory components and rejects storage replacement after initialization", (t) => {
  const { options, root, directory } = fixture(t);
  const store = createCallRecordStore(options);
  const original = join(root, "original");
  fs.renameSync(directory, original);
  fs.mkdirSync(directory, { mode: 0o700 });
  assert.throws(() => store.start("changed", STARTED_AT), safeError("call_recording_storage_changed"));
  fs.rmdirSync(directory);
  fs.symlinkSync(resolve(original), directory, "dir");
  assert.throws(() => store.start("symlink", STARTED_AT), safeError("call_recording_unsafe_path"));
  assert.deepEqual(fs.readdirSync(original), []);
});

test("exclusive no-follow creation refuses existing regular files and symlinks", (t) => {
  const { options, root, directory } = fixture(t);
  const store = createCallRecordStore(options);
  t.mock.method(crypto, "randomUUID", () => UUID);
  const first = store.start("collision", STARTED_AT);
  first.finish(FINISH);
  const path = singleFile(directory);
  const original = fs.readFileSync(path);
  assert.throws(() => store.start("collision", STARTED_AT), safeError("call_recording_io_failed"));
  assert.ok(fs.readFileSync(path).equals(original));
  const target = join(root, "unrelated");
  fs.writeFileSync(target, "unchanged", { mode: 0o644 });
  const targetMode = fs.statSync(target).mode;
  fs.symlinkSync(resolve(target), join(directory, ownFilename("symlink")));
  assert.throws(() => store.start("symlink", STARTED_AT), safeError("call_recording_io_failed"));
  assert.equal(fs.readFileSync(target, "utf8"), "unchanged");
  assert.equal(fs.statSync(target).mode, targetMode);
});

test("secures pre-existing storage directories and this module's regular call files", (t) => {
  const { options, directory } = fixture(t);
  fs.mkdirSync(directory, { mode: 0o755 });
  const first = createCallRecordStore(options).start("permissions", STARTED_AT);
  first.finish(FINISH);
  const path = singleFile(directory);
  fs.chmodSync(path, 0o666);
  fs.chmodSync(directory, 0o777);
  const unrelated = join(directory, "unrelated.txt");
  fs.writeFileSync(unrelated, "unchanged", { mode: 0o644 });
  createCallRecordStore(options);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(unrelated).mode & 0o777, 0o644);
});

test("retention removes only expired complete own files, preserving active, unrelated and linked entries", (t) => {
  const { options, root, directory } = fixture(t);
  const store = createCallRecordStore(options);
  const expired = new Date(Date.now() - 8 * DAY_MS);
  const old = store.start("expired", STARTED_AT);
  old.finish(FINISH);
  const oldPath = singleFile(directory);
  fs.utimesSync(oldPath, expired, expired);
  const active = store.start("active", STARTED_AT);
  const activePath = files(directory).find((path) => path.includes("call-v1-active-"))!;
  fs.utimesSync(activePath, expired, expired);
  const recent = store.start("recent", STARTED_AT);
  recent.finish(FINISH);
  const hardLinked = store.start("hardlinked", STARTED_AT);
  hardLinked.finish(FINISH);
  const hardLinkedPath = files(directory).find((path) => path.includes("call-v1-hardlinked-"))!;
  fs.utimesSync(hardLinkedPath, expired, expired);
  const outside = join(root, "outside.ndjson");
  fs.linkSync(hardLinkedPath, outside);
  const symlink = join(directory, ownFilename("symlink"));
  fs.symlinkSync(resolve(outside), symlink);
  const unrelated = join(directory, "unrelated.ndjson");
  fs.writeFileSync(unrelated, "unrelated");
  fs.utimesSync(unrelated, expired, expired);
  const malformed = join(directory, ownFilename("malformed"));
  fs.writeFileSync(malformed, "not-json\n");
  fs.utimesSync(malformed, expired, expired);
  const nested = join(directory, ownFilename("directory"));
  fs.mkdirSync(nested);
  const nestedFile = join(nested, ownFilename("nested"));
  fs.writeFileSync(nestedFile, fs.readFileSync(oldPath));
  fs.utimesSync(nestedFile, expired, expired);
  createCallRecordStore(options);
  assert.ok(!fs.existsSync(oldPath));
  for (const path of [activePath, hardLinkedPath, outside, symlink, unrelated, malformed, nestedFile]) {
    assert.ok(fs.existsSync(path));
  }
  assert.ok(fs.lstatSync(symlink).isSymbolicLink());
  assert.ok(files(directory).some((path) => path.includes("call-v1-recent-")));
  active.finish(FINISH);
});

test("retention preserves incomplete calls even when no recorder remains active", (t) => {
  const { options, directory } = fixture(t);
  const recorder = createCallRecordStore(options).start("incomplete", STARTED_AT);
  const path = singleFile(directory);
  assert.throws(() => recorder.append({
    type: "action", stage: "failed", proposalId: "one", action: 1n,
  }), safeError("call_recording_serialization_failed"));
  const old = new Date(Date.now() - 8 * DAY_MS);
  fs.utimesSync(path, old, old);
  createCallRecordStore(options);
  assert.ok(fs.existsSync(path));
  assert.equal(records(path).length, 1);
});

test("serialization errors are explicit, sanitized and release the call descriptor", (t) => {
  const { options, directory } = fixture(t);
  const store = createCallRecordStore(options);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let getterInvoked = false;
  const getter = Object.defineProperty({}, "private", {
    enumerable: true,
    get() { getterInvoked = true; throw new Error("synthetic-private-detail"); },
  });
  const values: unknown[] = [cyclic, 1n, undefined, NaN, Infinity, () => "value", new Date(), getter, Buffer.from("audio")];
  const originalClose = fs.closeSync;
  const closed: number[] = [];
  t.mock.method(fs, "closeSync", (fd: number) => { closed.push(fd); originalClose(fd); });
  for (const [index, action] of values.entries()) {
    const recorder = store.start(`serialization-${index}`, STARTED_AT);
    closed.length = 0;
    assert.throws(() => recorder.append({
      type: "action", stage: "proposed", proposalId: "one", action,
    }), safeError("call_recording_serialization_failed"));
    assert.equal(closed.length, 1);
    assert.throws(() => fs.fstatSync(closed[0]!), { code: "EBADF" });
    assert.throws(() => recorder.finish(FINISH), safeError("call_recording_serialization_failed"));
    assert.equal(closed.length, 1);
  }
  assert.equal(getterInvoked, false);
  assert.ok(files(directory).every((path) => records(path).length === 1));
});

test("record and call byte limits fail without truncating events or leaking descriptors", (t) => {
  const { options, directory } = fixture(t);
  const store = createCallRecordStore(options);
  const oversized = store.start("oversized", STARTED_AT);
  const oversizedPath = singleFile(directory);
  assert.throws(() => oversized.append({
    type: "transcript", speaker: "user", itemId: "one", text: "é".repeat(64 * 1024),
  }), safeError("call_recording_record_too_large"));
  assert.equal(records(oversizedPath).length, 1);
  assert.throws(() => oversized.finish(FINISH), safeError("call_recording_record_too_large"));
  const full = store.start("full", STARTED_AT);
  let written = 0;
  assert.throws(() => {
    for (; written < 200; written += 1) full.append({
      type: "transcript", speaker: "assistant", itemId: String(written), text: "x".repeat(60 * 1024),
    });
  }, safeError("call_recording_call_too_large"));
  assert.ok(written > 100 && written < 150);
  const fullPath = files(directory).find((path) => path !== oversizedPath)!;
  assert.ok(fs.statSync(fullPath).size <= 8 * 1024 * 1024);
  assert.equal(records(fullPath).length, written + 1);
  assert.throws(() => full.finish(FINISH), safeError("call_recording_call_too_large"));
});

test("handles short writes and explicitly closes on write or flush failures", (t) => {
  const { options, directory } = fixture(t);
  const store = createCallRecordStore(options);
  const originalWrite = fs.writeSync;
  const short = store.start("short", STARTED_AT);
  const shortWrite = t.mock.method(fs, "writeSync", (fd: number, buffer: Uint8Array, offset: number, length: number) =>
    originalWrite(fd, buffer, offset, Math.min(length, 7)));
  short.append({ type: "error", code: "short_write_ok" });
  short.finish(FINISH);
  shortWrite.mock.restore();
  assert.equal(records(singleFile(directory)).length, 3);
  const failed = store.start("write-failed", STARTED_AT);
  let failingFd = -1;
  const failureWrite = t.mock.method(fs, "writeSync", (fd: number) => {
    failingFd = fd;
    throw new Error("synthetic-private-detail");
  });
  assert.throws(() => failed.append({ type: "error", code: "not_written" }), safeError("call_recording_io_failed"));
  failureWrite.mock.restore();
  assert.throws(() => fs.fstatSync(failingFd), { code: "EBADF" });
  assert.throws(() => failed.finish(FINISH), safeError("call_recording_io_failed"));
  const flushFailed = store.start("flush-failed", STARTED_AT);
  let flushingFd = -1;
  t.mock.method(fs, "fsyncSync", (fd: number) => {
    flushingFd = fd;
    throw new Error("synthetic-private-detail");
  });
  assert.throws(() => flushFailed.finish(FINISH), safeError("call_recording_io_failed"));
  assert.throws(() => fs.fstatSync(flushingFd), { code: "EBADF" });
  assert.throws(() => flushFailed.finish(FINISH), safeError("call_recording_io_failed"));
});

test("start write failure releases its descriptor and reports no raw filesystem error", (t) => {
  const { options } = fixture(t);
  const store = createCallRecordStore(options);
  let failingFd = -1;
  t.mock.method(fs, "writeSync", (fd: number) => {
    failingFd = fd;
    throw Object.assign(new Error("synthetic-private-path"), { code: "EIO" });
  });
  assert.throws(() => store.start("start-failed", STARTED_AT), safeError("call_recording_io_failed"));
  assert.throws(() => fs.fstatSync(failingFd), { code: "EBADF" });
});

test("invalid runtime events and invalid end counters fail safely and close", (t) => {
  const { options, directory } = fixture(t);
  const store = createCallRecordStore(options);
  const invalid = store.start("invalid-event", STARTED_AT);
  assert.throws(
    () => invalid.append({ type: "audio", data: "not_permitted" } as unknown as CallRecordEvent),
    safeError("call_recording_invalid_event"),
  );
  const recorder = store.start("invalid-end", STARTED_AT);
  const originalClose = fs.closeSync;
  const closed: number[] = [];
  t.mock.method(fs, "closeSync", (fd: number) => { closed.push(fd); originalClose(fd); });
  assert.throws(
    () => recorder.finish({ ...FINISH, inputBytes: Number.MAX_SAFE_INTEGER + 1 }),
    safeError("call_recording_invalid_event"),
  );
  assert.equal(closed.length, 1);
  assert.throws(() => fs.fstatSync(closed[0]!), { code: "EBADF" });
  assert.ok(files(directory).every((path) => records(path).length === 1));
});

function audioPair(directory: string, callId: string): { record: string; audio: string } {
  const record = files(directory).find((path) => path.includes(`call-v1-${callId}-`) && path.endsWith(".ndjson"))!;
  assert.ok(record);
  return { record, audio: record.replace(/\.ndjson$/, ".wav") };
}

function expirePair(pair: { record: string; audio: string }): void {
  const expired = new Date(Date.now() - 8 * DAY_MS);
  fs.utimesSync(pair.record, expired, expired);
  fs.utimesSync(pair.audio, expired, expired);
}

function trackFileClosures(t: TestContext): number[] {
  const originalClose = fs.closeSync;
  const closed: number[] = [];
  t.mock.method(fs, "closeSync", (fd: number) => {
    if (fs.fstatSync(fd).isFile()) closed.push(fd);
    originalClose(fd);
  });
  return closed;
}

test("audio is opt-in and disabled appendAudio leaves the original NDJSON lifecycle unchanged", (t) => {
  const { options, directory } = fixture(t);
  for (const recordAudio of [undefined, false]) {
    const recorder = createCallRecordStore({ ...options, ...(recordAudio === undefined ? {} : { recordAudio }) })
      .start(recordAudio === undefined ? "default-off" : "explicit-off", STARTED_AT);
    recorder.appendAudio("caller", Buffer.alloc(160, 0xff), 0);
    recorder.appendAudio("agent", Buffer.alloc(160, 0x80), 20);
    recorder.appendAudio("caller", Buffer.alloc(0), NaN);
    recorder.finish(FINISH);
    recorder.appendAudio("caller", Buffer.alloc(160, 0xff), 100);
  }
  assert.equal(files(directory).length, 2);
  for (const path of files(directory)) {
    assert.ok(path.endsWith(".ndjson"));
    const data = records(path);
    assert.deepEqual(data.map((row) => row.type), ["start", "end"]);
    assert.ok(data.every((row) => !Object.hasOwn(row, "audio")));
  }
  assert.throws(() => createCallRecordStore({
    ...options, recordAudio: "true" as unknown as boolean,
  }), safeError("call_recording_invalid_options"));
});

test("opt-in audio uses a private matching WAV and redacted NDJSON with exact finite signal metadata", (t) => {
  const { options, directory } = fixture(t);
  const recorder = createCallRecordStore({ ...options, secrets: ["synthetic-secret"], recordAudio: true })
    .start("with-audio", STARTED_AT);
  const pair = audioPair(directory, "with-audio");
  assert.equal(files(directory).length, 2);
  assert.equal(fs.statSync(pair.audio).mode & 0o7777, 0o600);
  assert.equal(fs.statSync(pair.audio).nlink, 1);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(pair.audio).size, 44);
  const filename = pair.audio.slice(pair.audio.lastIndexOf("/") + 1);
  const metadata = { filename, format: "pcm_s16le", sampleRate: 8_000, channels: ["caller", "agent"] };
  assert.deepEqual(records(pair.record)[0]?.audio, metadata);
  recorder.append({ type: "transcript", speaker: "user", itemId: "one", text: "synthetic-secret" });
  recorder.appendAudio("caller", Buffer.alloc(160, 0xff), 0);
  recorder.appendAudio("agent", Buffer.alloc(160, 0x80), 20);
  assert.equal(fs.readFileSync(pair.audio).readUInt32LE(40), 1_280);
  recorder.finish(FINISH);
  const original = fs.readFileSync(pair.record);
  const wav = fs.readFileSync(pair.audio);
  recorder.finish(FINISH);
  assert.ok(original.equals(fs.readFileSync(pair.record)));
  assert.ok(wav.equals(fs.readFileSync(pair.audio)));
  assert.throws(() => recorder.appendAudio("caller", Buffer.alloc(160), 0), safeError("call_recording_closed"));
  const data = records(pair.record);
  assert.equal(data[1]?.text, "[REDACTED]");
  assert.deepEqual(data.at(-1)?.audio, {
    ...metadata, durationMs: 40,
    caller: { frames: 1, samples: 160, zeroSamples: 160, peakAmplitude: 0, rms: 0, dbfs: null },
    agent: {
      frames: 1, samples: 160, zeroSamples: 0, peakAmplitude: 32_124, rms: 32_124,
      dbfs: 20 * Math.log10(32_124 / 32_768),
    },
  });
});

test("audio option is snapshotted and identical concurrent call IDs remain isolated", (t) => {
  const { options, directory } = fixture(t);
  const mutable = { ...options, recordAudio: true };
  const store = createCallRecordStore(mutable);
  mutable.recordAudio = false;
  const first = store.start("same", STARTED_AT);
  const second = store.start("same", STARTED_AT);
  first.appendAudio("caller", Buffer.alloc(160, 0xfe), 0);
  second.appendAudio("agent", Buffer.alloc(160, 0x7e), 0);
  first.finish(FINISH);
  second.finish(FINISH);
  assert.equal(files(directory).length, 4);
  for (const path of files(directory).filter((path) => path.endsWith(".ndjson"))) {
    const audio = records(path)[0]?.audio as { filename: string };
    assert.equal(path.replace(/\.ndjson$/, ".wav"), join(directory, audio.filename));
  }
});

test("invalid audio and duration overflow close both descriptors and remain sticky", (t) => {
  const { options } = fixture(t);
  const store = createCallRecordStore({ ...options, recordAudio: true });
  const closed = trackFileClosures(t);
  for (const [name, audio, elapsedMs, code] of [
    ["frame", Buffer.alloc(159), 0, "call_recording_invalid_audio"],
    ["time", Buffer.alloc(160), NaN, "call_recording_invalid_audio"],
    ["limit", Buffer.alloc(160), 185_000, "call_recording_audio_too_long"],
  ] as const) {
    const recorder = store.start(name, STARTED_AT);
    closed.length = 0;
    assert.throws(() => recorder.appendAudio("caller", audio, elapsedMs), safeError(code));
    assert.equal(closed.length, 2);
    for (const fd of closed) assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
    assert.throws(() => recorder.finish(FINISH), safeError(code));
    assert.throws(() => recorder.appendAudio("caller", Buffer.alloc(160), 0), safeError(code));
    assert.equal(closed.length, 2);
  }
});

test("audio and transcript write, read, serialization and flush failures close both descriptors", (t) => {
  const { options } = fixture(t);
  const store = createCallRecordStore({ ...options, recordAudio: true });
  const closed = trackFileClosures(t);
  for (const mode of ["audio-write", "audio-read", "text-write", "serialize", "flush"] as const) {
    const recorder = store.start(mode, STARTED_AT);
    recorder.appendAudio("caller", Buffer.alloc(160, 0xfe), 0);
    closed.length = 0;
    const throwPrivate = () => { throw new Error("synthetic-private-detail"); };
    const mock = mode === "flush" ? t.mock.method(fs, "fsyncSync", throwPrivate)
      : mode === "audio-read" ? t.mock.method(fs, "readSync", throwPrivate)
        : mode === "serialize" ? undefined : t.mock.method(fs, "writeSync", throwPrivate);
    const action = mode === "flush" ? () => recorder.finish(FINISH)
      : mode === "serialize" ? () => recorder.append({ type: "action", stage: "failed", proposalId: "one", action: 1n })
        : mode === "text-write" ? () => recorder.append({ type: "error", code: "safe" })
          : () => recorder.appendAudio("agent", Buffer.alloc(160), 0);
    const code = mode === "serialize" ? "call_recording_serialization_failed" : "call_recording_io_failed";
    assert.throws(action, safeError(code));
    mock?.mock.restore();
    assert.equal(closed.length, 2);
    for (const fd of closed) assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
    assert.throws(() => recorder.finish(FINISH), safeError(code));
  }
});

test("partial audio writes or start header failures close both files without a complete end record", (t) => {
  const { options, directory } = fixture(t);
  const store = createCallRecordStore({ ...options, recordAudio: true });
  const closed = trackFileClosures(t);
  const originalWrite = fs.writeSync;
  for (const phase of ["header", "start", "frame"] as const) {
    const recorder = phase === "frame" ? store.start(phase, STARTED_AT) : undefined;
    closed.length = 0;
    let writes = 0;
    const mock = t.mock.method(fs, "writeSync", (
      fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null = null,
    ) => {
      writes += 1;
      if (phase === "start" && writes === 1) return originalWrite(fd, buffer, offset, length, position);
      if (phase !== "start" && writes === 1) return originalWrite(fd, buffer, offset, 7, position);
      throw new Error("synthetic-private-path");
    });
    assert.throws(
      () => recorder === undefined ? store.start(phase, STARTED_AT) : recorder.appendAudio("caller", Buffer.alloc(160), 0),
      safeError("call_recording_io_failed"),
    );
    mock.mock.restore();
    assert.equal(closed.length, 2);
    for (const fd of closed) assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
    const pair = audioPair(directory, phase);
    assert.ok(!fs.readFileSync(pair.record, "utf8").includes('"type":"end"'));
  }
});

test("companion creation is exclusive and no-follow, closing the new transcript on collision", (t) => {
  const { options, directory, root } = fixture(t);
  const store = createCallRecordStore({ ...options, recordAudio: true });
  t.mock.method(crypto, "randomUUID", () => UUID);
  const closed = trackFileClosures(t);
  const target = join(root, "outside.wav");
  fs.writeFileSync(target, "unchanged", { mode: 0o644 });
  for (const kind of ["regular", "symlink"] as const) {
    const path = join(directory, ownFilename(kind).replace(/\.ndjson$/, ".wav"));
    if (kind === "regular") fs.writeFileSync(path, "existing", { mode: 0o644 });
    else fs.symlinkSync(resolve(target), path);
    closed.length = 0;
    assert.throws(() => store.start(kind, STARTED_AT), safeError("call_recording_io_failed"));
    assert.equal(closed.length, 1);
    assert.throws(() => fs.fstatSync(closed[0]!), { code: "EBADF" });
    assert.equal(fs.readFileSync(path, "utf8"), kind === "regular" ? "existing" : "unchanged");
    assert.equal(fs.statSync(path).mode & 0o777, 0o644);
  }
});

test("retention removes complete expired audio pairs, including when audio is now disabled", (t) => {
  const { options, directory } = fixture(t);
  const store = createCallRecordStore({ ...options, recordAudio: true });
  for (const name of ["signal", "empty"]) {
    const recorder = store.start(name, STARTED_AT);
    if (name === "signal") recorder.appendAudio("caller", Buffer.alloc(160, 0xfe), 1_000);
    recorder.finish(FINISH);
    expirePair(audioPair(directory, name));
  }
  createCallRecordStore(options);
  assert.deepEqual(files(directory), []);
});

test("retention leaves unrelated and orphan WAVs, and still prunes old NDJSON-only records", (t) => {
  const { options, directory } = fixture(t);
  const legacy = createCallRecordStore(options).start("legacy", STARTED_AT);
  legacy.finish(FINISH);
  const legacyPair = audioPair(directory, "legacy");
  fs.writeFileSync(legacyPair.audio, "unrelated matching basename", { mode: 0o600 });
  expirePair(legacyPair);
  const orphan = createCallRecordStore({ ...options, recordAudio: true }).start("orphan", STARTED_AT);
  orphan.finish(FINISH);
  const orphanPair = audioPair(directory, "orphan");
  expirePair(orphanPair);
  fs.unlinkSync(orphanPair.record);
  createCallRecordStore(options);
  assert.ok(!fs.existsSync(legacyPair.record));
  assert.ok(fs.existsSync(legacyPair.audio));
  assert.ok(fs.existsSync(orphanPair.audio));
});

test("retention conservatively preserves active, incomplete and suspicious audio pairs", (t) => {
  const { options, directory, root } = fixture(t);
  const store = createCallRecordStore({ ...options, recordAudio: true });
  const expected: string[] = [];
  const active = store.start("active-audio", STARTED_AT);
  expirePair(audioPair(directory, "active-audio"));
  expected.push(...Object.values(audioPair(directory, "active-audio")));
  for (const kind of [
    "incomplete", "missing", "header", "oversize", "hardlink-audio", "hardlink-record", "symlink", "mode", "recent-audio",
  ]) {
    const recorder = store.start(kind, STARTED_AT);
    recorder.appendAudio("caller", Buffer.alloc(160, 0xfe), 0);
    if (kind === "incomplete") {
      assert.throws(() => recorder.append({ type: "action", stage: "failed", proposalId: "one", action: 1n }));
    } else recorder.finish(FINISH);
    const pair = audioPair(directory, kind);
    expirePair(pair);
    expected.push(pair.record);
    if (kind === "missing") {
      fs.unlinkSync(pair.audio);
      continue;
    }
    expected.push(pair.audio);
    if (kind === "header") {
      const fd = fs.openSync(pair.audio, "r+");
      fs.writeSync(fd, Buffer.from("NOPE"), 0, 4, 0);
      fs.closeSync(fd);
      expirePair(pair);
    } else if (kind === "oversize") {
      fs.truncateSync(pair.audio, 6_000_000);
      expirePair(pair);
    } else if (kind === "hardlink-audio" || kind === "hardlink-record") {
      const outside = join(root, `${kind}-outside`);
      fs.linkSync(kind === "hardlink-audio" ? pair.audio : pair.record, outside);
      expected.push(outside);
    } else if (kind === "symlink") {
      const outside = join(root, "symlink-outside.wav");
      fs.renameSync(pair.audio, outside);
      fs.chmodSync(outside, 0o644);
      fs.symlinkSync(resolve(outside), pair.audio);
      expected.push(outside);
    } else if (kind === "mode") {
      fs.chmodSync(pair.audio, 0o644);
    } else if (kind === "recent-audio") {
      const now = new Date();
      fs.utimesSync(pair.audio, now, now);
    }
  }
  createCallRecordStore(options);
  for (const path of expected) assert.ok(fs.existsSync(path), path);
  assert.equal(fs.statSync(audioPair(directory, "mode").audio).mode & 0o777, 0o644);
  assert.equal(fs.statSync(join(root, "symlink-outside.wav")).mode & 0o777, 0o644);
  active.finish(FINISH);
});

test("retention never trusts a different or traversing companion filename in record metadata", (t) => {
  const { options, directory } = fixture(t);
  const store = createCallRecordStore({ ...options, recordAudio: true });
  for (const filename of ["unrelated.wav", "../outside.wav"]) {
    const callId = filename.startsWith("..") ? "traversal" : "mismatched";
    const recorder = store.start(callId, STARTED_AT);
    recorder.finish(FINISH);
    const pair = audioPair(directory, callId);
    const data = records(pair.record);
    for (const record of data) (record.audio as { filename: string }).filename = filename;
    fs.writeFileSync(pair.record, `${data.map((record) => JSON.stringify(record)).join("\n")}\n`);
    expirePair(pair);
  }
  fs.writeFileSync(join(directory, "unrelated.wav"), Buffer.alloc(44), { mode: 0o600 });
  createCallRecordStore(options);
  assert.equal(files(directory).length, 5);
});

test("retention rechecks WAV identity after validating its header before deleting either file", (t) => {
  const { options, directory, root } = fixture(t);
  const recorder = createCallRecordStore({ ...options, recordAudio: true }).start("race", STARTED_AT);
  recorder.appendAudio("caller", Buffer.alloc(160, 0xfe), 0);
  recorder.finish(FINISH);
  const pair = audioPair(directory, "race");
  const original = fs.readFileSync(pair.audio);
  expirePair(pair);
  const displaced = join(root, "displaced.wav");
  const originalRead = fs.readSync;
  let replaced = false;
  t.mock.method(fs, "readSync", (fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => {
    const count = originalRead(fd, buffer, offset, length, position);
    if (length === 44 && !replaced) {
      replaced = true;
      fs.renameSync(pair.audio, displaced);
      fs.writeFileSync(pair.audio, original, { mode: 0o600, flag: "wx" });
      expirePair(pair);
    }
    return count;
  });
  createCallRecordStore(options);
  assert.equal(replaced, true);
  assert.ok(fs.existsSync(pair.record));
  assert.ok(fs.existsSync(pair.audio));
  assert.ok(fs.existsSync(displaced));
});
