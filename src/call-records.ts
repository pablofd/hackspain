import crypto from "node:crypto";
import fs, { constants, type Stats } from "node:fs";
import { parse, resolve, sep } from "node:path";
import {
  CallAudioFailure,
  CALL_AUDIO_FRAME_SAMPLES,
  createCallAudioWriter,
  readCallAudioSampleCount,
  type CallAudioDirection,
  type CallAudioWriter,
} from "./call-audio.js";
import { AppError } from "./errors.js";

export type CallRecordEvent =
  // Assistant text describes generated audio, not verified playback; retain interruptions alongside it.
  | { type: "transcript"; speaker: "user" | "assistant"; itemId: string; text: string }
  | { type: "interruption"; itemId?: string; audioEndMs?: number }
  | { type: "tool"; name: string; status: "ok" | "error"; code?: string; details?: unknown }
  | {
    type: "action";
    stage: "proposed" | "confirmed" | "accepted" | "duplicate" | "failed" | "unknown";
    proposalId: string;
    action: unknown;
    code?: string;
  }
  | { type: "error"; code: string };

export interface CallRecordFinish {
  reason: string;
  inputBytes: number;
  outputBytes: number;
}

export interface CallRecorder {
  append(event: CallRecordEvent): void;
  appendAudio(direction: CallAudioDirection, audio: Uint8Array, elapsedMs: number): void;
  finish(summary: CallRecordFinish): void;
}

export interface CallRecordStoreOptions {
  directory: string;
  retentionDays: number;
  secrets: readonly string[];
  recordAudio?: boolean;
}

export interface CallRecordStore {
  start(callId: string, startedAt: Date): CallRecorder;
}

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_CALL_BYTES = 8 * 1024 * 1024;
const DAY_MS = 86_400_000;
const SAFE_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OWN_FILE = /^call-v1-([A-Za-z0-9][A-Za-z0-9_-]{0,127})-(-?\d{1,16})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.ndjson$/;
const activeFiles = new Set<string>();

type FailureCode =
  | "call_recording_invalid_options"
  | "call_recording_invalid_call"
  | "call_recording_invalid_event"
  | "call_recording_unsafe_path"
  | "call_recording_storage_changed"
  | "call_recording_unsupported_platform"
  | "call_recording_serialization_failed"
  | "call_recording_record_too_large"
  | "call_recording_call_too_large"
  | "call_recording_io_failed"
  | "call_recording_closed";

class RecordFailure extends AppError {
  constructor(code: FailureCode) {
    super(code);
  }
}

function safeFailure(error: unknown, fallback: FailureCode): AppError {
  return new AppError(error instanceof RecordFailure || error instanceof CallAudioFailure ? error.code : fallback);
}

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function identity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

// Node has no openat API. Linux's descriptor paths pin each parent while O_NOFOLLOW checks its child.
function descriptorPath(fd: number, child?: string): string {
  return `/proc/self/fd/${fd}${child === undefined ? "" : `/${child}`}`;
}

function openDirectory(directory: string, create: boolean, expected?: string): { fd: number; id: string } {
  let fd: number | undefined;
  try {
    const root = parse(directory).root;
    fd = fs.openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    for (const component of directory.slice(root.length).split(sep)) {
      const child = descriptorPath(fd, component);
      if (create) {
        try {
          fs.mkdirSync(child, { mode: 0o700 });
        } catch (error) {
          if (!errno(error, "EEXIST")) throw error;
        }
      }
      const next = fs.openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const previous = fd;
      fd = next;
      fs.closeSync(previous);
    }
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory() || stat.uid !== process.getuid!()) {
      throw new RecordFailure("call_recording_unsafe_path");
    }
    const id = identity(stat);
    if (expected !== undefined && id !== expected) {
      throw new RecordFailure("call_recording_storage_changed");
    }
    fs.fchmodSync(fd, 0o700);
    const result = { fd, id };
    fd = undefined;
    return result;
  } catch (error) {
    if (errno(error, "ELOOP") || errno(error, "ENOTDIR")) {
      throw new RecordFailure("call_recording_unsafe_path");
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function createFile(
  directory: string,
  directoryId: string,
  filename: string,
  randomAccess = false,
): { fd: number; id: string } {
  let directoryFd: number | undefined;
  let fileFd: number | undefined;
  try {
    directoryFd = openDirectory(directory, false, directoryId).fd;
    fileFd = fs.openSync(
      descriptorPath(directoryFd, filename),
      (randomAccess ? constants.O_RDWR : constants.O_WRONLY | constants.O_APPEND)
        | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const stat = fs.fstatSync(fileFd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!()) {
      throw new RecordFailure("call_recording_unsafe_path");
    }
    fs.fchmodSync(fileFd, 0o600);
    const closing = directoryFd;
    directoryFd = undefined;
    fs.closeSync(closing);
    const result = { fd: fileFd, id: identity(stat) };
    fileFd = undefined;
    return result;
  } finally {
    try {
      if (fileFd !== undefined) fs.closeSync(fileFd);
    } finally {
      if (directoryFd !== undefined) fs.closeSync(directoryFd);
    }
  }
}

function encodeRecord(record: unknown, secrets: readonly string[]): Buffer {
  let budget = MAX_RECORD_BYTES;
  const ancestors = new Set<object>();
  const marker = secrets.some((secret) => "[REDACTED]".includes(secret)) ? "" : "[REDACTED]";
  function spend(bytes: number): void {
    budget -= bytes;
    if (budget < 0) throw new RecordFailure("call_recording_record_too_large");
  }
  function redact(value: string): string {
    for (const secret of secrets) value = value.split(secret).join(marker);
    if (secrets.some((secret) => value.includes(secret))) {
      throw new RecordFailure("call_recording_serialization_failed");
    }
    spend(Buffer.byteLength(value) + 2);
    return value;
  }
  function visit(value: unknown, depth: number): unknown {
    spend(1);
    if (depth > 64) throw new RecordFailure("call_recording_serialization_failed");
    if (typeof value === "string") return redact(value);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null || ancestors.has(value)) {
      throw new RecordFailure("call_recording_serialization_failed");
    }
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if ((!array && prototype !== Object.prototype && prototype !== null)
      || Object.getOwnPropertySymbols(value).length !== 0) {
      throw new RecordFailure("call_recording_serialization_failed");
    }
    ancestors.add(value);
    try {
      if (array) {
        if (value.length > MAX_RECORD_BYTES) throw new RecordFailure("call_recording_record_too_large");
        const result: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const property = Object.getOwnPropertyDescriptor(value, String(index));
          if (property === undefined || !("value" in property)) {
            throw new RecordFailure("call_recording_serialization_failed");
          }
          result.push(visit(property.value, depth + 1));
        }
        return result;
      }
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(value)) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (property === undefined || !("value" in property)) {
          throw new RecordFailure("call_recording_serialization_failed");
        }
        const redactedKey = redact(key);
        if (Object.hasOwn(result, redactedKey)) throw new RecordFailure("call_recording_serialization_failed");
        result[redactedKey] = visit(property.value, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  }
  const data = Buffer.from(`${JSON.stringify(visit(record, 0))}\n`);
  if (data.length > MAX_RECORD_BYTES) throw new RecordFailure("call_recording_record_too_large");
  return data;
}

function validString(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new RecordFailure("call_recording_invalid_event");
}

function validCount(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RecordFailure("call_recording_invalid_event");
  }
}

function eventFields(event: CallRecordEvent): Record<string, unknown> {
  if (event === null || typeof event !== "object") throw new RecordFailure("call_recording_invalid_event");
  switch (event.type) {
    case "transcript":
      validString(event.itemId);
      validString(event.text);
      if (event.speaker !== "user" && event.speaker !== "assistant") {
        throw new RecordFailure("call_recording_invalid_event");
      }
      return { type: event.type, speaker: event.speaker, itemId: event.itemId, text: event.text };
    case "interruption": {
      const fields: Record<string, unknown> = { type: event.type };
      if (event.itemId !== undefined) {
        validString(event.itemId);
        fields.itemId = event.itemId;
      }
      if (event.audioEndMs !== undefined) {
        if (!Number.isFinite(event.audioEndMs) || event.audioEndMs < 0) {
          throw new RecordFailure("call_recording_invalid_event");
        }
        fields.audioEndMs = event.audioEndMs;
      }
      return fields;
    }
    case "tool":
      validString(event.name);
      if (event.status !== "ok" && event.status !== "error") throw new RecordFailure("call_recording_invalid_event");
      if (event.code !== undefined) validString(event.code);
      return {
        type: event.type, name: event.name, status: event.status,
        ...(event.code === undefined ? {} : { code: event.code }),
        ...(event.details === undefined ? {} : { details: event.details }),
      };
    case "action":
      if (!["proposed", "confirmed", "accepted", "duplicate", "failed", "unknown"].includes(event.stage)) {
        throw new RecordFailure("call_recording_invalid_event");
      }
      validString(event.proposalId);
      if (event.code !== undefined) validString(event.code);
      return {
        type: event.type, stage: event.stage, proposalId: event.proposalId, action: event.action,
        ...(event.code === undefined ? {} : { code: event.code }),
      };
    case "error":
      validString(event.code);
      return { type: event.type, code: event.code };
    default:
      throw new RecordFailure("call_recording_invalid_event");
  }
}

type AudioFile = { fd: number; id: string; filename: string };

function audioMetadata(filename: string): Record<string, unknown> {
  return { filename, format: "pcm_s16le", sampleRate: 8_000, channels: ["caller", "agent"] };
}

function recorderFor(
  fd: number,
  id: string,
  callId: string,
  startedAt: string,
  secrets: readonly string[],
  audioFile?: AudioFile,
): CallRecorder {
  let descriptor: number | undefined = fd;
  let audioDescriptor = audioFile?.fd;
  let audioWriter: CallAudioWriter | undefined;
  let bytes = 0;
  let finished = false;
  let failure: AppError | undefined;
  activeFiles.add(id);
  if (audioFile !== undefined) activeFiles.add(audioFile.id);

  function close(): void {
    try {
      if (descriptor !== undefined) {
        const closing = descriptor;
        descriptor = undefined;
        fs.closeSync(closing);
        activeFiles.delete(id);
      }
    } finally {
      if (audioDescriptor !== undefined) {
        const closing = audioDescriptor;
        audioDescriptor = undefined;
        fs.closeSync(closing);
        activeFiles.delete(audioFile!.id);
      }
    }
  }
  function abort(error: unknown, fallback: FailureCode): never {
    failure = safeFailure(error, fallback);
    try {
      close();
    } catch (closeError) {
      failure = safeFailure(closeError, "call_recording_io_failed");
    }
    throw failure;
  }
  function write(fields: () => Record<string, unknown>, timestamp: string): void {
    if (failure !== undefined) throw failure;
    if (descriptor === undefined) throw new AppError("call_recording_closed");
    let data: Buffer;
    try {
      data = encodeRecord({ schemaVersion: 1, callId, timestamp, ...fields() }, secrets);
      if (bytes + data.length > MAX_CALL_BYTES) throw new RecordFailure("call_recording_call_too_large");
    } catch (error) {
      abort(error, "call_recording_serialization_failed");
    }
    try {
      let offset = 0;
      while (offset < data.length) {
        const written = fs.writeSync(descriptor, data, offset, data.length - offset);
        if (written <= 0) throw new RecordFailure("call_recording_io_failed");
        offset += written;
        bytes += written;
      }
    } catch (error) {
      abort(error, "call_recording_io_failed");
    }
  }

  if (audioDescriptor !== undefined) {
    try {
      audioWriter = createCallAudioWriter(audioDescriptor);
    } catch (error) {
      abort(error, "call_recording_io_failed");
    }
  }
  write(() => ({
    type: "start", assistantTranscriptSource: "generated_audio",
    ...(audioFile === undefined ? {} : { audio: audioMetadata(audioFile.filename) }),
  }), startedAt);
  return {
    append(event) {
      write(() => eventFields(event), new Date().toISOString());
    },
    appendAudio(direction, audio, elapsedMs) {
      if (audioWriter === undefined) return;
      if (failure !== undefined) throw failure;
      if (audioDescriptor === undefined) throw new AppError("call_recording_closed");
      try {
        audioWriter.append(direction, audio, elapsedMs);
      } catch (error) {
        abort(error, "call_recording_io_failed");
      }
    },
    finish(summary) {
      if (failure !== undefined) throw failure;
      if (finished) return;
      try {
        if (audioDescriptor !== undefined) fs.fsyncSync(audioDescriptor);
        write(() => {
          validString(summary.reason);
          validCount(summary.inputBytes);
          validCount(summary.outputBytes);
          return {
            type: "end", reason: summary.reason, inputBytes: summary.inputBytes, outputBytes: summary.outputBytes,
            ...(audioFile === undefined ? {} : {
              audio: { ...audioMetadata(audioFile.filename), ...audioWriter!.summary() },
            }),
          };
        }, new Date().toISOString());
        fs.fsyncSync(fd);
        close();
        finished = true;
      } catch (error) {
        if (failure !== undefined) throw failure;
        abort(error, "call_recording_io_failed");
      }
    },
  };
}

function boundaryRecord(fd: number, size: number, first: boolean): Record<string, unknown> | undefined {
  const length = Math.min(size, MAX_RECORD_BYTES);
  const start = first ? 0 : size - length;
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fd, buffer, offset, length - offset, start + offset);
    if (read === 0) return undefined;
    offset += read;
  }
  if (!first && buffer.at(-1) !== 10) return undefined;
  const newline = first ? buffer.indexOf(10) : buffer.lastIndexOf(10, buffer.length - 2);
  if (newline < 0) return undefined;
  const line = first ? buffer.subarray(0, newline) : buffer.subarray(newline + 1, buffer.length - 1);
  try {
    const value: unknown = JSON.parse(line.toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function matchesAudioMetadata(value: unknown, filename: string): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const metadata = value as Record<string, unknown>;
  return metadata.filename === filename && metadata.format === "pcm_s16le" && metadata.sampleRate === 8_000
    && Array.isArray(metadata.channels) && metadata.channels.length === 2
    && metadata.channels[0] === "caller" && metadata.channels[1] === "agent";
}

function matchesAudioSummary(summary: Record<string, unknown>, samples: number): boolean {
  if (summary.durationMs !== samples / 8) return false;
  for (const direction of ["caller", "agent"]) {
    const channel = summary[direction];
    if (channel === null || typeof channel !== "object") return false;
    const data = channel as Record<string, unknown>;
    if (!Number.isSafeInteger(data.frames) || (data.frames as number) < 0
      || !Number.isSafeInteger(data.samples) || (data.samples as number) < 0 || (data.samples as number) > samples
      || data.samples !== (data.frames as number) * CALL_AUDIO_FRAME_SAMPLES
      || !Number.isSafeInteger(data.zeroSamples) || (data.zeroSamples as number) < 0
      || (data.zeroSamples as number) > (data.samples as number)
      || !Number.isSafeInteger(data.peakAmplitude) || (data.peakAmplitude as number) < 0
      || (data.peakAmplitude as number) > 32_768
      || typeof data.rms !== "number" || !Number.isFinite(data.rms) || data.rms < 0
      || data.rms > (data.peakAmplitude as number)
      || (data.rms === 0 ? data.dbfs !== null
        : typeof data.dbfs !== "number" || !Number.isFinite(data.dbfs) || data.dbfs > 0)) return false;
  }
  return true;
}

function unchangedPrivateFile(path: string, fd: number, original: Stats): boolean {
  const current = fs.lstatSync(path);
  const final = fs.fstatSync(fd);
  return [current, final].every((stat) => stat.isFile() && stat.nlink === 1
    && stat.uid === process.getuid!() && (stat.mode & 0o7777) === 0o600
    && identity(stat) === identity(original) && stat.size === original.size
    && stat.mtimeMs === original.mtimeMs && !activeFiles.has(identity(stat)));
}

function prune(directoryFd: number, cutoff: number): void {
  for (const filename of fs.readdirSync(descriptorPath(directoryFd))) {
    const match = OWN_FILE.exec(filename);
    if (match === null) continue;
    const path = descriptorPath(directoryFd, filename);
    let fd: number | undefined;
    let audioFd: number | undefined;
    try {
      const entry = fs.lstatSync(path);
      if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid!()) continue;
      fd = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!()
        || identity(stat) !== identity(entry)) continue;
      fs.fchmodSync(fd, 0o600);
      if (activeFiles.has(identity(stat)) || stat.mtimeMs >= cutoff || stat.size > MAX_CALL_BYTES || stat.size < 2) continue;
      const first = boundaryRecord(fd, stat.size, true);
      const last = boundaryRecord(fd, stat.size, false);
      if (first?.schemaVersion !== 1 || first.type !== "start" || first.callId !== match[1]
        || last?.schemaVersion !== 1 || last.type !== "end" || last.callId !== first.callId
        || typeof first.timestamp !== "string" || typeof last.timestamp !== "string"
        || Date.parse(first.timestamp) !== Number(match[2])
        || !Number.isFinite(Date.parse(last.timestamp))
        || typeof last.reason !== "string"
        || !Number.isSafeInteger(last.inputBytes) || !Number.isSafeInteger(last.outputBytes)
        || (last.inputBytes as number) < 0 || (last.outputBytes as number) < 0) continue;
      let audioPath: string | undefined;
      let audioStat: Stats | undefined;
      if (Object.hasOwn(first, "audio") || Object.hasOwn(last, "audio")) {
        const audioFilename = filename.replace(/\.ndjson$/, ".wav");
        if (!matchesAudioMetadata(first.audio, audioFilename) || !matchesAudioMetadata(last.audio, audioFilename)) continue;
        audioPath = descriptorPath(directoryFd, audioFilename);
        const audioEntry = fs.lstatSync(audioPath);
        if (!audioEntry.isFile() || audioEntry.nlink !== 1 || audioEntry.uid !== process.getuid!()
          || (audioEntry.mode & 0o7777) !== 0o600) continue;
        audioFd = fs.openSync(audioPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        audioStat = fs.fstatSync(audioFd);
        if (!audioStat.isFile() || audioStat.nlink !== 1 || audioStat.uid !== process.getuid!()
          || (audioStat.mode & 0o7777) !== 0o600 || identity(audioStat) !== identity(audioEntry)
          || audioStat.mtimeMs >= cutoff || activeFiles.has(identity(audioStat))) continue;
        const samples = readCallAudioSampleCount(audioFd, audioStat.size);
        if (samples === undefined || !matchesAudioSummary(last.audio, samples)) continue;
      }
      if (unchangedPrivateFile(path, fd, stat)
        && (audioFd === undefined || unchangedPrivateFile(audioPath!, audioFd, audioStat!))) {
        if (audioPath !== undefined) fs.unlinkSync(audioPath);
        fs.unlinkSync(path);
      }
    } catch (error) {
      // A concurrently removed entry or a substituted symlink is not a retention candidate.
      if (!errno(error, "ENOENT") && !errno(error, "ELOOP") && !errno(error, "ENOTDIR")) throw error;
    } finally {
      try {
        if (audioFd !== undefined) fs.closeSync(audioFd);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
  }
}

/** Private Linux-only NDJSON and optional bounded WAV; incomplete records are retained conservatively. */
export function createCallRecordStore(options: CallRecordStoreOptions): CallRecordStore {
  try {
    if (process.platform !== "linux" || process.getuid === undefined || constants.O_NOFOLLOW === undefined) {
      throw new RecordFailure("call_recording_unsupported_platform");
    }
    if (typeof options.directory !== "string" || options.directory.trim() === ""
      || options.directory.includes("\0") || options.directory.includes("\\")
      || options.directory.split("/").includes("..")
      || !Number.isSafeInteger(options.retentionDays) || options.retentionDays < 1
      || !Number.isSafeInteger(options.retentionDays * DAY_MS)
      || (options.recordAudio !== undefined && typeof options.recordAudio !== "boolean")
      || !Array.isArray(options.secrets) || !options.secrets.every((secret: unknown) => typeof secret === "string")) {
      throw new RecordFailure("call_recording_invalid_options");
    }
    const directory = resolve(options.directory);
    if (directory === parse(directory).root) throw new RecordFailure("call_recording_invalid_options");
    const secrets = [...new Set(options.secrets.filter((secret) => secret.length > 0))]
      .sort((left, right) => right.length - left.length);
    const recordAudio = options.recordAudio === true;
    const storage = openDirectory(directory, true);
    try {
      prune(storage.fd, Date.now() - options.retentionDays * DAY_MS);
    } finally {
      fs.closeSync(storage.fd);
    }
    return {
      start(callId, startedAt) {
        try {
          if (typeof callId !== "string" || !SAFE_CALL_ID.test(callId)
            || !(startedAt instanceof Date) || !Number.isSafeInteger(Date.prototype.getTime.call(startedAt))) {
            throw new RecordFailure("call_recording_invalid_call");
          }
          const timestamp = Date.prototype.toISOString.call(startedAt);
          const filename = `call-v1-${callId}-${Date.prototype.getTime.call(startedAt)}-${crypto.randomUUID()}.ndjson`;
          const file = createFile(directory, storage.id, filename);
          let audioFile: AudioFile | undefined;
          try {
            if (recordAudio) {
              const audioFilename = filename.replace(/\.ndjson$/, ".wav");
              audioFile = { ...createFile(directory, storage.id, audioFilename, true), filename: audioFilename };
            }
          } catch (error) {
            fs.closeSync(file.fd);
            throw error;
          }
          return recorderFor(file.fd, file.id, callId, timestamp, secrets, audioFile);
        } catch (error) {
          throw safeFailure(error, "call_recording_io_failed");
        }
      },
    };
  } catch (error) {
    throw safeFailure(error, "call_recording_io_failed");
  }
}
