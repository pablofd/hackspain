import { AppError } from "./errors.js";

export interface AudioChunk {
  audio: Buffer;
  itemId: string;
  contentIndex: number;
}

export interface PlayedAudio {
  itemId: string;
  contentIndex: number;
  audioEndMs: number;
}

interface QueuedFrame extends AudioChunk {
  samples: number;
}

export class AudioQueue {
  private readonly frames: QueuedFrame[] = [];
  private remainder: AudioChunk | undefined;
  private lastPlayed: PlayedAudio | undefined;
  private playedSamples = 0;
  private readonly interrupted = new Set<string>();
  private readonly finished = new Set<string>();
  private silenceFramesRemaining = 0;

  constructor(
    private readonly maxFrames = 1500,
    private readonly silenceTailFrames = 0,
  ) {}

  push(chunk: AudioChunk): void {
    if (this.interrupted.has(chunk.itemId)) return;
    const continues = this.remainder?.itemId === chunk.itemId &&
      this.remainder.contentIndex === chunk.contentIndex;
    const data = continues && this.remainder
      ? Buffer.concat([this.remainder.audio, chunk.audio])
      : chunk.audio;
    const tailFrames = this.remainder && !continues ? 1 : 0;
    if (this.frames.length + tailFrames + Math.ceil(data.length / 160) > this.maxFrames) {
      throw new AppError("audio_output_backpressure");
    }
    if (this.remainder && !continues) {
      if (this.remainder.itemId !== chunk.itemId) this.finished.add(this.remainder.itemId);
      this.flushRemainder();
    }
    this.remainder = undefined;
    let offset = 0;
    while (offset + 160 <= data.length) {
      this.frames.push({ ...chunk, audio: Buffer.from(data.subarray(offset, offset + 160)), samples: 160 });
      offset += 160;
    }
    if (offset < data.length) {
      this.remainder = { ...chunk, audio: Buffer.from(data.subarray(offset)) };
    }
  }

  finish(itemId: string): void {
    if (this.interrupted.has(itemId)) return;
    this.finished.add(itemId);
    if (!this.remainder || this.remainder.itemId !== itemId) return;
    this.flushRemainder();
  }

  private flushRemainder(): void {
    if (!this.remainder) return;
    if (this.frames.length >= this.maxFrames) throw new AppError("audio_output_backpressure");
    const audio = Buffer.alloc(160, 0xff);
    this.remainder.audio.copy(audio);
    this.frames.push({ ...this.remainder, audio, samples: this.remainder.audio.length });
    this.remainder = undefined;
  }

  next(): Buffer | undefined {
    const frame = this.frames.shift();
    if (!frame) {
      if (this.silenceFramesRemaining > 0 && !this.remainder && this.lastPlayed &&
          this.finished.has(this.lastPlayed.itemId)) {
        this.silenceFramesRemaining -= 1;
        // Downstream VAD needs audio-clock silence; it is not generated content.
        return Buffer.alloc(160, 0xff);
      }
      return undefined;
    }
    this.silenceFramesRemaining = this.silenceTailFrames;
    this.playedSamples = this.lastPlayed?.itemId === frame.itemId &&
      this.lastPlayed.contentIndex === frame.contentIndex
      ? this.playedSamples + frame.samples
      : frame.samples;
    this.lastPlayed = {
      itemId: frame.itemId,
      contentIndex: frame.contentIndex,
      // Padding is sent as silence but is not part of Azure's generated content.
      audioEndMs: Math.floor(this.playedSamples / 8),
    };
    return frame.audio;
  }

  interrupt(): PlayedAudio | undefined {
    const first = this.frames[0] ?? this.remainder;
    const played = this.lastPlayed &&
      (!this.finished.has(this.lastPlayed.itemId) ||
        (first?.itemId === this.lastPlayed.itemId && first.contentIndex === this.lastPlayed.contentIndex))
      ? this.lastPlayed
      : first ? { itemId: first.itemId, contentIndex: first.contentIndex, audioEndMs: 0 } : undefined;
    for (const frame of this.frames) this.interrupted.add(frame.itemId);
    if (this.remainder) this.interrupted.add(this.remainder.itemId);
    if (played) this.interrupted.add(played.itemId);
    this.frames.length = 0;
    this.remainder = undefined;
    this.lastPlayed = undefined;
    this.playedSamples = 0;
    this.silenceFramesRemaining = 0;
    return played;
  }
}
