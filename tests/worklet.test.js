import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { StreamingResampler } from "../src/lib/resampler.js";

function createProcessor() {
  class AudioWorkletProcessorStub {
    constructor() {
      this.port = {
        onmessage: null,
        messages: [],
        postMessage(message) { this.messages.push(message); },
      };
    }
  }

  let ProcessorClass;
  const source = readFileSync(new URL("../src/audio-capture-worklet.js", import.meta.url), "utf8")
    .replace('import { StreamingResampler } from "./lib/resampler.js";\n', "");
  vm.runInNewContext(source, {
    AudioWorkletProcessor: AudioWorkletProcessorStub,
    StreamingResampler,
    registerProcessor(_name, processor) { ProcessorClass = processor; },
    sampleRate: 48000,
  });
  return new ProcessorClass();
}

test("closing capture flushes a partial audio chunk before acknowledging close", () => {
  const processor = createProcessor();
  processor.process(
    [[new Float32Array(4800).fill(0.1)]],
    [[new Float32Array(128)]],
  );

  processor.port.onmessage({ data: { type: "CLOSE" } });

  assert.deepEqual(processor.port.messages.map((message) => message.type), ["AUDIO", "CLOSED"]);
  assert.equal(new Float32Array(processor.port.messages[0].samples).length, 1600);
  assert.equal(processor.process([], [[new Float32Array(128)]]), false);
});
