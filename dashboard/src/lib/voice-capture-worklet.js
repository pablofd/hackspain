import { StreamingDownsampler } from "./voice-codec.js";

class MaioDemoCaptureProcessor extends AudioWorkletProcessor {
  #resampler;
  #enabled = false;
  #stopped = false;
  #frame = new Float32Array(160);
  #frameLength = 0;
  #mono = new Float32Array(0);

  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (this.#stopped) return;
      try {
        if (data?.event === "start") {
          this.#reset();
          this.#enabled = true;
        } else if (data?.event === "stop") {
          this.#stop();
        }
      } catch {
        this.#fail();
      }
    };
    try {
      this.#resampler = new StreamingDownsampler(sampleRate);
    } catch {
      this.#fail();
    }
  }

  #reset() {
    this.#resampler?.reset();
    this.#frame.fill(0);
    this.#frameLength = 0;
    this.#mono.fill(0);
  }

  #stop() {
    this.#enabled = false;
    // Returning false is terminal for an AudioWorklet node; restart uses a new node.
    this.#stopped = true;
    this.#reset();
  }

  #fail() {
    this.#stop();
    this.port.postMessage({
      event: "error",
      code: "dashboard_demo_audio_processing_failed",
    });
  }

  process(inputs, outputs) {
    try {
      for (const output of outputs) {
        for (const channel of output) channel.fill(0);
      }
      if (this.#stopped) return false;
      if (!this.#enabled) return true;

      const channels = inputs[0];
      if (!channels || channels.length === 0) return true;
      const length = channels[0].length;
      for (const channel of channels) {
        if (!(channel instanceof Float32Array) || channel.length !== length) {
          throw new TypeError("Input channels must contain matching Float32Arrays");
        }
      }
      let mono = channels[0];
      if (channels.length > 1) {
        if (this.#mono.length !== length) this.#mono = new Float32Array(length);
        for (let index = 0; index < length; index += 1) {
          let sum = 0;
          for (const channel of channels) sum += channel[index];
          this.#mono[index] = sum / channels.length;
        }
        mono = this.#mono;
      }

      const samples = this.#resampler.process(mono);
      for (let index = 0; index < samples.length; index += 1) {
        this.#frame[this.#frameLength] = samples[index];
        this.#frameLength += 1;
        if (this.#frameLength === this.#frame.length) {
          const frame = this.#frame;
          this.#frame = new Float32Array(160);
          this.#frameLength = 0;
          this.port.postMessage({ event: "frame", samples: frame }, [frame.buffer]);
        }
      }
      return true;
    } catch {
      this.#fail();
      return false;
    }
  }
}

registerProcessor("maio-demo-capture", MaioDemoCaptureProcessor);
