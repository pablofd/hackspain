import { constants, type Stats } from "node:fs";
import { open, readdir, type FileHandle } from "node:fs/promises";
import { z } from "zod";
import { AppError } from "../errors.js";
import { idSchema, reasonSchema } from "../prosper-types.js";

const filenamePattern = /^call-v1-([A-Za-z0-9][A-Za-z0-9_-]{0,127})-(-?\d{1,16})-[0-9a-f-]{36}\.ndjson$/;
const callIdSchema = idSchema.regex(/^[A-Za-z0-9]/);
const recordLimit = 200;
const maxRecordBytes = 8 * 1024 * 1024;
const maxEventBytes = 64 * 1024;
const transcriptLimits = Object.freeze({ entries: 500, bytes: 256 * 1024 });
const codeSchema = z.string().max(100).regex(/^[A-Za-z0-9_.-]+$/);
const eventSchema = z.object({
  schemaVersion: z.literal(1), callId: idSchema, timestamp: z.iso.datetime({ offset: true }), type: z.string(),
});
const actionEvent = z.object({
  proposalId: idSchema,
  stage: z.enum(["proposed", "confirmed", "accepted", "duplicate", "failed", "unknown"]),
  action: z.object({
    action: z.enum(["BOOK", "RESCHEDULE", "CANCEL", "REGISTER", "NO_ACTION", "ESCALATE"]),
    reason: reasonSchema.optional(),
  }),
});
const endEvent = z.object({
  reason: codeSchema, inputBytes: z.number().int().nonnegative(), outputBytes: z.number().int().nonnegative(),
});
const toolEvent = z.object({ name: codeSchema, status: z.enum(["ok", "error"]), code: codeSchema.optional() });
const transcriptEvent = z.object({
  speaker: z.enum(["user", "assistant"]),
  text: z.string().max(maxEventBytes),
  itemId: z.string().max(512),
  partial: z.boolean().optional(),
  startMs: z.number().nonnegative().optional(),
  endMs: z.number().nonnegative().optional(),
}).refine(({ startMs, endMs }) =>
  startMs === undefined ? endMs === undefined : endMs !== undefined && endMs >= startMs);

export type TranscriptEntry = z.infer<typeof transcriptEvent> & { timestamp: string };

export interface LocalCall {
  id: string;
  startedAt: string;
  endedAt: string | null;
  lastEventAt: string;
  endReason: string | null;
  inputBytes: number | null;
  outputBytes: number | null;
  interruptions: number;
  transcriptEvents: number;
  actions: {
    stage: z.infer<typeof actionEvent>["stage"];
    action: z.infer<typeof actionEvent>["action"]["action"];
    reason: z.infer<typeof reasonSchema> | null;
  }[];
  events: { timestamp: string; kind: string; code: string }[];
}

export interface RecordSummary {
  calls: LocalCall[];
  limited: boolean;
  limit: number;
  restrictedPermissions: boolean;
}

function* recordEvents(text: string, expectedId: string) {
  if (Buffer.byteLength(text) > maxRecordBytes) throw new AppError("dashboard_unsafe_record");
  const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean);
  let startedAt: number | undefined;
  for (const line of lines) {
    if (Buffer.byteLength(line) > maxEventBytes) throw new AppError("dashboard_record_event_too_large");
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { throw new AppError("dashboard_invalid_record"); }
    const base = eventSchema.safeParse(value);
    if (!base.success || base.data.callId !== expectedId) throw new AppError("dashboard_invalid_record");
    const { type, timestamp } = base.data;
    if (startedAt === undefined) {
      if (type !== "start") throw new AppError("dashboard_invalid_record");
      startedAt = Date.parse(timestamp);
    }
    if (Date.parse(timestamp) < startedAt) throw new AppError("dashboard_invalid_record");
    yield { type, timestamp, value };
  }
  if (startedAt === undefined) throw new AppError("dashboard_incomplete_record");
}

export function projectCallRecord(text: string, expectedId: string): LocalCall {
  let call: LocalCall | undefined;
  const actions = new Map<string, LocalCall["actions"][number]>();
  for (const { type, timestamp, value } of recordEvents(text, expectedId)) {
    if (!call) {
      call = {
        id: expectedId, startedAt: timestamp, endedAt: null, lastEventAt: timestamp,
        endReason: null, inputBytes: null, outputBytes: null, interruptions: 0,
        transcriptEvents: 0, actions: [], events: [],
      };
    }
    call.lastEventAt = timestamp;
    if (type === "transcript") {
      // Bulk snapshots never contain transcript text or fragment timing.
      call.transcriptEvents += 1;
    } else if (type === "interruption") {
      call.interruptions += 1;
    } else if (type === "end") {
      const parsed = endEvent.safeParse(value);
      if (!parsed.success) throw new AppError("dashboard_invalid_record");
      call.endedAt = timestamp;
      call.endReason = parsed.data.reason;
      call.inputBytes = parsed.data.inputBytes;
      call.outputBytes = parsed.data.outputBytes;
    } else if (type === "action") {
      const parsed = actionEvent.safeParse(value);
      if (!parsed.success) throw new AppError("dashboard_invalid_record");
      const { proposalId, stage, action } = parsed.data;
      actions.set(proposalId, { stage, action: action.action, reason: action.reason ?? null });
      call.events.push({ timestamp, kind: "action", code: `${stage}:${action.action}` });
    } else if (type === "tool") {
      const parsed = toolEvent.safeParse(value);
      if (!parsed.success) throw new AppError("dashboard_invalid_record");
      call.events.push({ timestamp, kind: "tool", code: `${parsed.data.name}:${parsed.data.code ?? parsed.data.status}` });
    } else if (type === "error") {
      const parsed = z.object({ code: codeSchema }).safeParse(value);
      if (!parsed.success) throw new AppError("dashboard_invalid_record");
      call.events.push({ timestamp, kind: "error", code: parsed.data.code });
    }
    if (call.events.length > 100) call.events.shift();
  }
  if (!call) throw new AppError("dashboard_incomplete_record");
  call.actions = [...actions.values()];
  return call;
}

export function projectCallTranscript(text: string, expectedId: string, secrets: readonly string[] = []) {
  const credentials = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const marker = credentials.some((secret) => "[REDACTED]".includes(secret)) ? "" : "[REDACTED]";
  const redact = (value: string) => {
    for (const secret of credentials) value = value.split(secret).join(marker);
    if (credentials.some((secret) => value.includes(secret))) throw new AppError("dashboard_transcript_redaction_failed");
    return value;
  };
  const entries: { entry: TranscriptEntry; bytes: number }[] = [];
  let bytes = 2;
  let limited = false;
  let startedAt = "";
  for (const { type, timestamp, value } of recordEvents(text, expectedId)) {
    startedAt ||= timestamp;
    if (type !== "transcript") continue;
    const parsed = transcriptEvent.safeParse(value);
    if (!parsed.success) throw new AppError("dashboard_invalid_transcript");
    const entry: TranscriptEntry = {
      timestamp, ...parsed.data, text: redact(parsed.data.text), itemId: redact(parsed.data.itemId),
    };
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    entries.push({ entry, bytes: size });
    bytes += size;
    while (entries.length > transcriptLimits.entries || bytes > transcriptLimits.bytes) {
      bytes -= entries.shift()!.bytes;
      limited = true;
    }
  }
  return { startedAt, entries: entries.map(({ entry }) => entry), limited, limits: transcriptLimits };
}

interface RecordFile { name: string; id: string; time: number }

async function withRecordFile<T>(path: string, operation: (file: FileHandle, info: Stats) => Promise<T>): Promise<T> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.size > maxRecordBytes) {
      throw new AppError("dashboard_unsafe_record");
    }
    return await operation(file, info);
  } finally { await file.close(); }
}

async function recordText(file: FileHandle, size: number): Promise<string> {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) throw new AppError("dashboard_record_changed");
    offset += bytesRead;
  }
  // Ignore an in-progress final line, but never replace corrupt complete text with guessed characters.
  const complete = buffer.subarray(0, buffer.lastIndexOf(10) + 1);
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(complete); }
  catch { throw new AppError("dashboard_invalid_record"); }
}

export class DashboardRecords {
  private readonly cache = new Map<string, { signature: string; call: LocalCall }>();

  constructor(
    private readonly directory: string,
    private readonly days: number,
    private readonly secrets: readonly string[] = [],
  ) {}

  private async withRecentRecords<T>(
    now: Date,
    operation: (path: string, selected: RecordFile[], limited: boolean, restrictedPermissions: boolean) => Promise<T>,
  ): Promise<T> {
    let directory: FileHandle | undefined;
    try {
      directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const stat = await directory.stat();
      if (stat.uid !== process.getuid?.()) throw new AppError("dashboard_records_wrong_owner");
      // A reader must not chmod the voice process's files. ACL masks may add mode bits.
      const restrictedPermissions = (stat.mode & 0o077) === 0;
      const path = `/proc/self/fd/${directory.fd}`;
      const names = (await readdir(path)).flatMap((name) => {
        const match = filenamePattern.exec(name);
        return match?.[1] && match[2] && Number(match[2]) >= now.getTime() - this.days * 86_400_000 &&
          Number(match[2]) <= now.getTime()
          ? [{ name, id: match[1], time: Number(match[2]) }] : [];
      }).sort((left, right) => right.time - left.time);
      return await operation(path, names.slice(0, recordLimit), names.length > recordLimit, restrictedPermissions);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("dashboard_records_unavailable");
    } finally { await directory?.close(); }
  }

  async read(now = new Date()): Promise<RecordSummary> {
    return this.withRecentRecords(now, async (path, selected, limited, restrictedPermissions) => {
      const retained = new Set(selected.map(({ name }) => name));
      for (const name of this.cache.keys()) if (!retained.has(name)) this.cache.delete(name);
      const calls: LocalCall[] = [];
      for (const { name, id } of selected) {
        await withRecordFile(`${path}/${name}`, async (file, info) => {
          restrictedPermissions &&= (info.mode & 0o077) === 0;
          const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
          const previous = this.cache.get(name);
          if (previous?.signature === signature) calls.push(previous.call);
          else {
            const call = projectCallRecord(await recordText(file, info.size), id);
            this.cache.set(name, { signature, call });
            calls.push(call);
          }
        });
      }
      return { calls, limited, limit: recordLimit, restrictedPermissions };
    });
  }

  async transcript(callId: string, now = new Date()) {
    if (!callIdSchema.safeParse(callId).success) throw new AppError("dashboard_invalid_call_id");
    return this.withRecentRecords(now, async (path, selected) => {
      const record = selected.find(({ id }) => id === callId);
      if (!record) throw new AppError("dashboard_transcript_not_found");
      return withRecordFile(`${path}/${record.name}`, async (file, info) => {
        const { startedAt, ...projection } = projectCallTranscript(await recordText(file, info.size), callId, this.secrets);
        if (Date.parse(startedAt) !== record.time) throw new AppError("dashboard_invalid_record");
        return { callId, checkedAt: now.toISOString(), historyDays: this.days, ...projection };
      });
    });
  }
}
