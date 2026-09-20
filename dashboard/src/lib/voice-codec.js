function requireFloat32(samples) {
  if (!(samples instanceof Float32Array)) {
    throw new TypeError("Audio samples must be a Float32Array");
  }
}

export function createMuLawCodec(decodeTable) {
  if (
    !Array.isArray(decodeTable) &&
    !(ArrayBuffer.isView(decodeTable) && typeof decodeTable.length === "number")
  ) {
    throw new TypeError("decodeTable must be an array or numeric typed array");
  }
  if (decodeTable.length !== 256) {
    throw new RangeError("decodeTable must contain exactly 256 PCM16 samples");
  }

  const table = new Int16Array(256);
  for (let code = 0; code < table.length; code += 1) {
    const sample = decodeTable[code];
    if (!Number.isInteger(sample) || sample < -32768 || sample > 32767) {
      throw new RangeError("decodeTable must contain finite integer PCM16 samples");
    }
    table[code] = sample;
  }
  if (table[255] !== 0) {
    throw new RangeError("decodeTable[255] must represent silence");
  }

  const sorted = Array.from(table, (sample, code) => ({ sample, code }))
    .filter(({ sample, code }) => sample !== 0 || code === 255)
    .sort((a, b) => a.sample - b.sample || a.code - b.code);

  return {
    encode(pcm) {
      requireFloat32(pcm);
      const bytes = new Uint8Array(pcm.length);
      for (let index = 0; index < pcm.length; index += 1) {
        const sample = pcm[index];
        if (!Number.isFinite(sample)) {
          throw new RangeError("Audio samples must be finite");
        }
        const clipped = Math.max(-1, Math.min(1, sample));
        // Match decode's /32768 normalization, saturating the positive endpoint.
        const target = Math.min(32767, Math.round(clipped * 32768));
        if (target === 0) {
          bytes[index] = 255;
          continue;
        }

        let low = 0;
        let high = sorted.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (sorted[middle].sample < target) low = middle + 1;
          else high = middle;
        }
        if (low === 0) bytes[index] = sorted[0].code;
        else if (low === sorted.length) bytes[index] = sorted[low - 1].code;
        else {
          const before = sorted[low - 1];
          const after = sorted[low];
          bytes[index] = target - before.sample <= after.sample - target
            ? before.code
            : after.code;
        }
      }
      return bytes;
    },

    decode(bytes) {
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError("Encoded audio must be a Uint8Array");
      }
      const pcm = new Float32Array(bytes.length);
      for (let index = 0; index < bytes.length; index += 1) {
        pcm[index] = table[bytes[index]] / 32768;
      }
      return pcm;
    },
  };
}

function greatestCommonDivisor(a, b) {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

export class StreamingDownsampler {
  #inputRate;
  #outputRate;
  #history = new Float32Array(0);
  #kernels = [];
  #phaseCount = 0;
  #phase = 0;
  #writeIndex = 0;

  constructor(inputSampleRate, outputSampleRate = 8000) {
    if (typeof inputSampleRate !== "number" || typeof outputSampleRate !== "number") {
      throw new TypeError("Sample rates must be numbers");
    }
    if (
      !Number.isFinite(inputSampleRate) ||
      !Number.isFinite(outputSampleRate) ||
      outputSampleRate <= 0 ||
      inputSampleRate < outputSampleRate
    ) {
      throw new RangeError("Sample rates must be finite, positive and downsampling");
    }
    this.#inputRate = inputSampleRate;
    this.#outputRate = outputSampleRate;
    if (inputSampleRate === outputSampleRate) return;

    const ratio = inputSampleRate / outputSampleRate;
    const radius = Math.ceil(32 * ratio);
    const tapCount = 2 * radius + 2;
    const cutoff = 0.45 / ratio;
    this.#history = new Float32Array(tapCount);
    this.#phaseCount = Number.isSafeInteger(inputSampleRate) && Number.isSafeInteger(outputSampleRate)
      ? Math.min(128, outputSampleRate / greatestCommonDivisor(inputSampleRate, outputSampleRate))
      : 128;

    // Blackman-windowed sinc: 3.6 kHz cutoff at 8 kHz output. Common integer
    // rates use exact polyphases; other rates interpolate a bounded phase bank.
    for (let phase = 0; phase <= this.#phaseCount; phase += 1) {
      const kernel = new Float64Array(tapCount);
      const fraction = phase / this.#phaseCount;
      let sum = 0;
      for (let tap = 0; tap < tapCount; tap += 1) {
        const distance = tap - radius - fraction;
        if (Math.abs(distance) >= radius) continue;
        const angle = Math.PI * distance / radius;
        const window = 0.42 + 0.5 * Math.cos(angle) + 0.08 * Math.cos(2 * angle);
        const sinc = distance === 0
          ? 2 * cutoff
          : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
        kernel[tap] = window * sinc;
        sum += kernel[tap];
      }
      for (let tap = 0; tap < tapCount; tap += 1) kernel[tap] /= sum;
      this.#kernels.push(kernel);
    }
  }

  reset() {
    this.#history.fill(0);
    this.#phase = 0;
    this.#writeIndex = 0;
  }

  #convolve(kernel, newest) {
    let sum = 0;
    for (let tap = 0; tap < kernel.length; tap += 1) {
      sum += this.#history[newest] * kernel[tap];
      newest -= 1;
      if (newest < 0) newest = this.#history.length - 1;
    }
    return sum;
  }

  process(pcm) {
    requireFloat32(pcm);
    for (let index = 0; index < pcm.length; index += 1) {
      if (!Number.isFinite(pcm[index])) {
        throw new RangeError("Audio samples must be finite");
      }
    }
    if (this.#inputRate === this.#outputRate) return pcm.slice();

    // The bounded rate accumulator yields floor(N * outputRate / inputRate)
    // samples cumulatively (exact for integer rates), regardless of chunking.
    // Zero history supplies the FIR startup: delay is ceil(32 * ratio) input
    // samples (~4 ms at 8 kHz output), without reducing counts or flushing a tail.
    const output = new Float32Array(Math.ceil(pcm.length * this.#outputRate / this.#inputRate));
    let produced = 0;
    let phase = this.#phase;
    let writeIndex = this.#writeIndex;
    for (let index = 0; index < pcm.length; index += 1) {
      this.#history[writeIndex] = pcm[index];
      phase += this.#outputRate;
      if (phase >= this.#inputRate) {
        phase -= this.#inputRate;
        const position = phase * this.#phaseCount / this.#outputRate;
        const lower = Math.min(this.#phaseCount - 1, Math.floor(position));
        const fraction = position - lower;
        const value = this.#convolve(this.#kernels[lower], writeIndex);
        output[produced] = fraction === 0
          ? value
          : value + (this.#convolve(this.#kernels[lower + 1], writeIndex) - value) * fraction;
        if (!Number.isFinite(output[produced])) {
          throw new RangeError("Resampled audio must be finite");
        }
        produced += 1;
      }
      writeIndex += 1;
      if (writeIndex === this.#history.length) writeIndex = 0;
    }
    this.#phase = phase;
    this.#writeIndex = writeIndex;
    return output.subarray(0, produced);
  }
}
