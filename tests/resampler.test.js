import test from "node:test";
import assert from "node:assert/strict";
import { StreamingResampler } from "../src/lib/resampler.js";

test("resamples 48 kHz mono audio to the exact 16 kHz sample count", () => {
  const resampler = new StreamingResampler(48000, 16000);
  const input = Float32Array.from({ length: 48000 }, (_, index) => Math.sin(index * 2 * Math.PI * 440 / 48000) * 0.4);
  const output = resampler.process([input]);
  assert.equal(output.length, 16000);
  assert.ok(output.every(Number.isFinite));
  assert.ok(output.every((sample) => sample >= -1 && sample <= 1));
});

test("resampling output does not depend on microphone chunk boundaries", () => {
  const input = Float32Array.from({ length: 44100 }, (_, index) => Math.cos(index * 2 * Math.PI * 310 / 44100) * 0.25);
  const whole = new StreamingResampler(44100, 16000).process([input]);
  const resampler = new StreamingResampler(44100, 16000);
  const pieces = [
    resampler.process([input.subarray(0, 1111)]),
    resampler.process([input.subarray(1111, 23999)]),
    resampler.process([input.subarray(23999)]),
  ];
  const chunked = Float32Array.from(pieces.flatMap((piece) => Array.from(piece)));
  assert.equal(chunked.length, whole.length);
  for (let index = 0; index < whole.length; index += 1) {
    assert.ok(Math.abs(chunked[index] - whole[index]) < 1e-7);
  }
});

test("invalid samples become silence and stereo is safely downmixed", () => {
  const resampler = new StreamingResampler(16000, 16000);
  const output = resampler.process([
    Float32Array.from([0.5, Number.NaN, 2, -0.4]),
    Float32Array.from([0.5, 0.2, 2, 0.4]),
  ]);
  assert.equal(output.length, 4);
  assert.ok(output.every(Number.isFinite));
  assert.ok(output.every((sample) => sample >= -1 && sample <= 1));
});
