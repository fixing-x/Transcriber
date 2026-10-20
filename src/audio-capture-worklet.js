import { StreamingResampler } from "./lib/resampler.js";

class ReadAlongCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new StreamingResampler(sampleRate, 16000);
    this.chunk = new Float32Array(8000);
    this.chunkOffset = 0;
    this.closed = false;
    this.port.onmessage = (event) => {
      if (event.data?.type !== "CLOSE" || this.closed) return;
      if (this.chunkOffset > 0) {
        const completed = this.chunk.slice(0, this.chunkOffset);
        this.chunk.fill(0);
        this.chunkOffset = 0;
        this.port.postMessage({ type: "AUDIO", samples: completed.buffer }, [completed.buffer]);
      } else {
        this.chunk.fill(0);
      }
      this.closed = true;
      this.port.postMessage({ type: "CLOSED" });
    };
  }

  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (this.closed) return false;

    const channels = inputs[0];
    if (!channels?.length) return true;
    const resampled = this.resampler.process(channels);
    for (let i = 0; i < resampled.length; i += 1) {
      this.chunk[this.chunkOffset++] = resampled[i];
      if (this.chunkOffset === this.chunk.length) {
        const completed = this.chunk;
        this.chunk = new Float32Array(8000);
        this.chunkOffset = 0;
        this.port.postMessage({ type: "AUDIO", samples: completed.buffer }, [completed.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("readalong-capture", ReadAlongCaptureProcessor);
