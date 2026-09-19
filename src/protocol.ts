import { z } from "zod";
import { AppError } from "./errors.js";

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const start = z.object({
  event: z.literal("start"),
  start: z.object({
    callSid: id,
    streamSid: id,
    mediaFormat: z.object({
      encoding: z.literal("audio/x-mulaw"),
      sampleRate: z.literal(8000),
      channels: z.literal(1),
    }),
    customParameters: z.object({
      call_id: id.optional(),
      from_number: z.string().regex(/^\+\d{8,15}$/).optional(),
    }).optional(),
  }),
}).refine((packet) =>
  !packet.start.customParameters?.call_id ||
  packet.start.customParameters.call_id === packet.start.callSid);

const packetSchema = z.union([
  z.object({ event: z.literal("connected") }),
  start,
  z.object({
    event: z.literal("media"),
    streamSid: id,
    media: z.object({ payload: z.string().min(1).max(64_000) }),
  }),
  z.object({ event: z.literal("stop"), streamSid: id }),
  z.object({ event: z.literal("mark"), streamSid: id }),
]);

export function parsePacket(text: string): z.infer<typeof packetSchema> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AppError("invalid_json");
  }
  const parsed = packetSchema.safeParse(value);
  if (!parsed.success) throw new AppError("invalid_media_stream_packet");
  return parsed.data;
}

export function decodeAudio(payload: string): Buffer {
  const audio = Buffer.from(payload, "base64");
  if (!audio.length || audio.toString("base64") !== payload) {
    throw new AppError("invalid_audio_payload");
  }
  return audio;
}
