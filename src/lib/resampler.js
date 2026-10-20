export class StreamingResampler {
  constructor(inputRate, outputRate = 16000) {
    if (!Number.isFinite(inputRate) || inputRate < 8000 || inputRate > 384000) {
      throw new RangeError("The microphone sample rate is unsupported.");
    }
    if (!Number.isFinite(outputRate) || outputRate <= 0) {
      throw new RangeError("The target sample rate is invalid.");
    }
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.step = inputRate / outputRate;
    this.alpha = 1 - Math.exp(-2 * Math.PI * Math.min(7000, outputRate * 0.44) / inputRate);
    this.inputCount = 0;
    this.nextOutputAt = 0;
    this.previousFiltered = 0;
    this.filterState = 0;
  }

  process(inputChannels) {
    const channels = Array.from(inputChannels ?? []).filter((channel) => channel && channel.length > 0);
    if (channels.length === 0) return new Float32Array(0);
    const frameCount = Math.min(...channels.map((channel) => channel.length));
    if (frameCount === 0) return new Float32Array(0);

    const output = [];
    for (let frame = 0; frame < frameCount; frame += 1) {
      let mono = 0;
      for (const channel of channels) {
        const sample = Number(channel[frame]);
        mono += Number.isFinite(sample) ? sample : 0;
      }
      mono /= channels.length;
      mono = Math.max(-1, Math.min(1, mono));
      this.filterState = Number.isFinite(this.filterState)
        ? this.filterState + this.alpha * (mono - this.filterState)
        : mono;
      const filtered = Number.isFinite(this.filterState) ? this.filterState : 0;
      const currentIndex = this.inputCount;

      if (currentIndex === 0) {
        output.push(filtered);
        this.nextOutputAt += this.step;
      } else {
        while (this.nextOutputAt <= currentIndex) {
          const fraction = Math.max(0, Math.min(1, this.nextOutputAt - (currentIndex - 1)));
          output.push(this.previousFiltered + (filtered - this.previousFiltered) * fraction);
          this.nextOutputAt += this.step;
        }
      }

      this.previousFiltered = filtered;
      this.inputCount += 1;
    }
    return Float32Array.from(output);
  }
}
