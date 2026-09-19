import fs from "node:fs";
import { AppError } from "./errors.js";

export type CallAudioDirection = "caller" | "agent";

export const CALL_AUDIO_SAMPLE_RATE = 8_000;
export const CALL_AUDIO_FRAME_SAMPLES = 160;
export const CALL_AUDIO_MAX_SAMPLES = 185 * CALL_AUDIO_SAMPLE_RATE;
export const CALL_AUDIO_HEADER_BYTES = 44;
export const CALL_AUDIO_MAX_BYTES = CALL_AUDIO_HEADER_BYTES + CALL_AUDIO_MAX_SAMPLES * 4;

export interface CallAudioChannelSummary {
  frames: number;
  samples: number;
  zeroSamples: number;
  peakAmplitude: number;
  rms: number;
  dbfs: number | null;
}

export interface CallAudioSummary {
  durationMs: number;
  caller: CallAudioChannelSummary;
  agent: CallAudioChannelSummary;
}

export interface CallAudioWriter {
  append(direction: CallAudioDirection, audio: Uint8Array, elapsedMs: number): void;
  summary(): CallAudioSummary;
}

export class CallAudioFailure extends AppError {
  constructor(code: "call_recording_invalid_audio" | "call_recording_audio_too_long" | "call_recording_io_failed") {
    super(code);
  }
}

function decodeSample(value: number): number {
  const complemented = value ^ 0xff;
  const magnitude = (((complemented & 0x0f) << 3) + 0x84) << ((complemented >> 4) & 7);
  return (complemented & 0x80) === 0 ? magnitude - 0x84 : 0x84 - magnitude;
}

export function decodeMuLaw(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new CallAudioFailure("call_recording_invalid_audio");
  }
  return decodeSample(value);
}

function wavHeader(samples: number): Buffer {
  const header = Buffer.alloc(CALL_AUDIO_HEADER_BYTES);
  const dataBytes = samples * 4;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(CALL_AUDIO_SAMPLE_RATE, 24);
  header.writeUInt32LE(CALL_AUDIO_SAMPLE_RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function writeAll(fd: number, buffer: Buffer, position: number): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (!Number.isInteger(written) || written <= 0 || written > buffer.length - offset) {
      throw new CallAudioFailure("call_recording_io_failed");
    }
    offset += written;
  }
}

function readAll(fd: number, buffer: Buffer, length: number, position: number): boolean {
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (read === 0) return false;
    if (!Number.isInteger(read) || read < 0 || read > length - offset) {
      throw new CallAudioFailure("call_recording_io_failed");
    }
    offset += read;
  }
  return true;
}

/** Validates only this recorder's bounded, canonical PCM WAV layout. */
export function readCallAudioSampleCount(fd: number, size: number): number | undefined {
  if (!Number.isSafeInteger(size) || size < CALL_AUDIO_HEADER_BYTES || size > CALL_AUDIO_MAX_BYTES
    || (size - CALL_AUDIO_HEADER_BYTES) % 4 !== 0) return undefined;
  try {
    const header = Buffer.alloc(CALL_AUDIO_HEADER_BYTES);
    if (!readAll(fd, header, header.length, 0)) return undefined;
    const samples = (size - CALL_AUDIO_HEADER_BYTES) / 4;
    return header.equals(wavHeader(samples)) ? samples : undefined;
  } catch {
    throw new CallAudioFailure("call_recording_io_failed");
  }
}

/** The caller owns this exclusive, non-append O_RDWR descriptor, including failure cleanup. */
export function createCallAudioWriter(fd: number): CallAudioWriter {
  try {
    if (!Number.isSafeInteger(fd) || fd < 0 || fs.fstatSync(fd).size !== 0) {
      throw new CallAudioFailure("call_recording_io_failed");
    }
    writeAll(fd, wavHeader(0), 0);
  } catch {
    throw new CallAudioFailure("call_recording_io_failed");
  }
  type ChannelState = {
    end: number;
    frames: number;
    samples: number;
    zeroSamples: number;
    peakAmplitude: number;
    sumSquares: number;
  };
  const channelState = (): ChannelState => ({
    end: 0, frames: 0, samples: 0, zeroSamples: 0, peakAmplitude: 0, sumSquares: 0,
  });
  const channels = { caller: channelState(), agent: channelState() };
  let totalSamples = 0;
  let failure: CallAudioFailure | undefined;

  function channelSummary(channel: ChannelState): CallAudioChannelSummary {
    const rms = channel.samples === 0 ? 0 : Math.sqrt(channel.sumSquares / channel.samples);
    return {
      frames: channel.frames,
      samples: channel.samples,
      zeroSamples: channel.zeroSamples,
      peakAmplitude: channel.peakAmplitude,
      rms,
      dbfs: rms === 0 ? null : 20 * Math.log10(rms / 32_768),
    };
  }

  return {
    append(direction, audio, elapsedMs) {
      if (failure !== undefined) throw failure;
      try {
        if ((direction !== "caller" && direction !== "agent") || !(audio instanceof Uint8Array)
          || audio.byteLength !== CALL_AUDIO_FRAME_SAMPLES
          || typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
          throw new CallAudioFailure("call_recording_invalid_audio");
        }
        const channel = channels[direction];
        const start = Math.max(Math.floor(elapsedMs * CALL_AUDIO_SAMPLE_RATE / 1_000), channel.end);
        const end = start + CALL_AUDIO_FRAME_SAMPLES;
        if (!Number.isSafeInteger(start) || end > CALL_AUDIO_MAX_SAMPLES) {
          throw new CallAudioFailure("call_recording_audio_too_long");
        }
        const block = Buffer.alloc(CALL_AUDIO_FRAME_SAMPLES * 4);
        const position = CALL_AUDIO_HEADER_BYTES + start * 4;
        const existingBytes = Math.min(CALL_AUDIO_FRAME_SAMPLES, Math.max(0, totalSamples - start)) * 4;
        if (!readAll(fd, block, existingBytes, position)) {
          throw new CallAudioFailure("call_recording_io_failed");
        }
        let zeroSamples = 0;
        let peakAmplitude = 0;
        let sumSquares = 0;
        const channelOffset = direction === "caller" ? 0 : 2;
        for (let index = 0; index < audio.length; index += 1) {
          const sample = decodeSample(audio[index]!);
          block.writeInt16LE(sample, index * 4 + channelOffset);
          if (sample === 0) zeroSamples += 1;
          peakAmplitude = Math.max(peakAmplitude, Math.abs(sample));
          sumSquares += sample * sample;
        }
        writeAll(fd, block, position);
        const nextTotal = Math.max(totalSamples, end);
        writeAll(fd, wavHeader(nextTotal), 0);
        totalSamples = nextTotal;
        channel.end = end;
        channel.frames += 1;
        channel.samples += audio.length;
        channel.zeroSamples += zeroSamples;
        channel.peakAmplitude = Math.max(channel.peakAmplitude, peakAmplitude);
        channel.sumSquares += sumSquares;
      } catch (error) {
        failure = error instanceof CallAudioFailure ? error : new CallAudioFailure("call_recording_io_failed");
        throw failure;
      }
    },
    summary() {
      return {
        durationMs: totalSamples * 1_000 / CALL_AUDIO_SAMPLE_RATE,
        caller: channelSummary(channels.caller),
        agent: channelSummary(channels.agent),
      };
    },
  };
}
