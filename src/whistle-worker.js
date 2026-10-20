const SAMPLE_RATE = 16000;
const MAX_WINDOW_SAMPLES = 8 * SAMPLE_RATE;
const MIN_WINDOW_SAMPLES = 2 * SAMPLE_RATE;
const PROCESS_EVERY_SAMPLES = SAMPLE_RATE;
const OUTPUT_CAPACITY = 128 * 1024;

importScripts(new URL("./lib/commitment-core.js", self.location.href).href);
const { stablePairs } = self.ReadAlongCommitment;

let enginePromise = null;
let engine = null;
let audioWindow = new Float32Array(0);
let totalSamples = 0;
let lastProcessedAt = 0;
let previousPass = null;
let lastCommittedStart = -1;

function localAsset(path) {
  return new URL(path, self.location.href).href;
}

async function loadEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    importScripts(localAsset("../vendor/cactus/needle.js"));
    const wasmResponse = await fetch(localAsset("../vendor/cactus/needle.wasm"));
    if (!wasmResponse.ok) throw new Error("The bundled Needle WebAssembly file could not be read.");
    const wasmBinary = await wasmResponse.arrayBuffer();
    if (wasmBinary.byteLength < 64 * 1024) {
      new Uint8Array(wasmBinary).fill(0);
      throw new Error("The bundled Needle WebAssembly file is incomplete.");
    }

    let module;
    try {
      module = await self.createNeedle({
        wasmBinary,
        print: () => {},
        printErr: () => {},
      });
    } finally {
      new Uint8Array(wasmBinary).fill(0);
    }
    module.wasmBinary = null;

    const response = await fetch(localAsset("../vendor/cactus/whistle.cact"));
    if (!response.ok) throw new Error("The bundled Whistle weights could not be read.");
    const modelBytes = new Uint8Array(await response.arrayBuffer());
    if (modelBytes.byteLength < 1024 * 1024) throw new Error("The bundled Whistle model file is incomplete.");

    const modelPointer = module._malloc(modelBytes.byteLength);
    if (!modelPointer) throw new Error("There is not enough memory to load Whistle.");
    try {
      module.HEAPU8.set(modelBytes, modelPointer);
      const result = module.ccall(
        "needle_load",
        "number",
        ["number", "number"],
        [modelPointer, BigInt(modelBytes.byteLength)],
      );
      if (result < 0) throw new Error("The local Whistle model could not be loaded.");
    } finally {
      module._free(modelPointer);
      modelBytes.fill(0);
    }
    return module;
  })();
  return enginePromise;
}

function normalizeTranscriptWord(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[’]/gu, "'")
    .replace(/[-‐‑‒–—]/gu, "")
    .replace(/[^\p{L}\p{N}']/gu, "")
    .replace(/^'+|'+$/gu, "");
}

function estimatedWordTimes(words, windowStart, windowDuration) {
  const duration = Math.max(0.2, windowDuration);
  const interval = duration / Math.max(1, words.length);
  return words.map((word, index) => ({
    text: String(word.word ?? word.text ?? ""),
    normalized: normalizeTranscriptWord(word.word ?? word.text),
    start: windowStart + index * interval,
    end: windowStart + (index + 1) * interval,
    probability: Number.isFinite(Number(word.probability))
      ? Math.max(0, Math.min(1, Number(word.probability)))
      : 0.65,
  })).filter((word) => word.normalized);
}

function hasUsableWordTimes(words, windowDuration) {
  if (words.length === 0) return false;
  if (words.length === 1) {
    const { start: rawStart, end: rawEnd } = words[0];
    const start = rawStart === null || rawStart === "" ? Number.NaN : Number(rawStart);
    const end = rawEnd === null || rawEnd === "" ? Number.NaN : Number(rawEnd);
    return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= windowDuration + 1;
  }
  let previousStart = -Infinity;
  let firstStart = Number.NaN;
  let lastStart = Number.NaN;
  for (const word of words) {
    const start = word.start === null || word.start === "" ? Number.NaN : Number(word.start);
    const end = word.end === null || word.end === "" ? Number.NaN : Number(word.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start ||
      start > windowDuration + 1 || end > windowDuration + 1 || start <= previousStart) return false;
    if (!Number.isFinite(firstStart)) firstStart = start;
    lastStart = start;
    previousStart = start;
  }
  return lastStart > firstStart;
}

function wordsFromTranscript(result, windowStart, windowDuration) {
  const words = Array.isArray(result.words) ? result.words : [];
  if (words.length > 0) {
    const timedWords = hasUsableWordTimes(words, windowDuration)
      ? words.map((word) => ({
        text: String(word.word ?? word.text ?? ""),
        normalized: normalizeTranscriptWord(word.word ?? word.text),
        start: windowStart + Number(word.start),
        end: windowStart + Number(word.end),
        probability: Number.isFinite(Number(word.probability))
          ? Math.max(0, Math.min(1, Number(word.probability)))
          : 0.65,
      })).filter((word) => word.normalized)
      : estimatedWordTimes(words, windowStart, windowDuration);
    if (timedWords.length > 0) return timedWords;
  }

  const text = String(result.text ?? "");
  const matches = Array.from(text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*(?:[-‐‑‒–—][\p{L}\p{N}]+)*/gu));
  // Text-only responses do not have word times. Approximate positions inside
  // the current rolling window; using total session time makes these positions
  // drift farther into the future as a long session continues.
  const approximateDuration = Math.max(0.2, windowDuration);
  return matches.map((match, index) => ({
    text: match[0],
    normalized: normalizeTranscriptWord(match[0]),
    start: windowStart + index * approximateDuration / Math.max(1, matches.length),
    end: windowStart + (index + 1) * approximateDuration / Math.max(1, matches.length),
    probability: 0.55,
  }));
}

function transcribe(samples) {
  if (!engine || samples.length === 0) return null;
  const samplePointer = engine._malloc(samples.byteLength);
  const outputPointer = engine._malloc(OUTPUT_CAPACITY);
  if (!samplePointer || !outputPointer) {
    if (samplePointer) engine._free(samplePointer);
    if (outputPointer) engine._free(outputPointer);
    throw new Error("There is not enough memory to transcribe this audio.");
  }

  try {
    new Float32Array(engine.HEAPU8.buffer, samplePointer, samples.length).set(samples);
    engine.HEAPU8.fill(0, outputPointer, outputPointer + OUTPUT_CAPACITY);
    const tokenCount = engine.ccall(
      "needle_transcribe",
      "number",
      ["number", "number", "number", "number", "number", "number", "number"],
      [samplePointer, samples.length, 0, 0, 1, outputPointer, OUTPUT_CAPACITY],
    );
    if (tokenCount < 0) throw new Error("Whistle could not transcribe this audio segment.");
    const payload = engine.UTF8ToString(outputPointer, OUTPUT_CAPACITY);
    let result;
    try {
      result = JSON.parse(payload);
    } catch {
      throw new Error("Whistle returned an unreadable transcription result.");
    }
    if (result.success === false || result.error) throw new Error("Whistle could not transcribe this audio segment.");
    return result;
  } finally {
    engine.HEAPU8.fill(0, samplePointer, samplePointer + samples.byteLength);
    engine.HEAPU8.fill(0, outputPointer, outputPointer + OUTPUT_CAPACITY);
    engine._free(samplePointer);
    engine._free(outputPointer);
  }
}

function publishPass(result, windowStart, windowDuration, final = false) {
  const current = {
    words: wordsFromTranscript(result, windowStart, windowDuration),
    text: String(result.text ?? ""),
    pending: String(result.pending ?? ""),
  };
  const stable = stablePairs(previousPass, current);
  const committed = [];
  for (const [, currentIndex] of stable) {
    const word = current.words[currentIndex];
    if (word.start <= lastCommittedStart + 0.025) continue;
    committed.push({ text: word.text, probability: word.probability, start: word.start, end: word.end });
    lastCommittedStart = Math.max(lastCommittedStart, word.start);
  }
  previousPass = current;
  self.postMessage({
    type: "TRANSCRIPT",
    text: current.text,
    pending: current.pending,
    committed,
    final,
  });
}

function currentAudioWindow() {
  const windowStart = Math.max(0, totalSamples / SAMPLE_RATE - audioWindow.length / SAMPLE_RATE);
  return { samples: audioWindow.slice(), windowStart };
}

function appendAudio(samples) {
  if (!(samples instanceof Float32Array) || samples.length === 0) return;
  const safeSamples = samples.length > MAX_WINDOW_SAMPLES ? samples.subarray(-MAX_WINDOW_SAMPLES) : samples;
  totalSamples += safeSamples.length;
  const combined = new Float32Array(audioWindow.length + safeSamples.length);
  combined.set(audioWindow);
  combined.set(safeSamples, audioWindow.length);
  audioWindow = combined.length > MAX_WINDOW_SAMPLES
    ? combined.slice(combined.length - MAX_WINDOW_SAMPLES)
    : combined;
}

function transcribeCurrent(final = false) {
  const { samples, windowStart } = currentAudioWindow();
  if (!samples.length) return;
  try {
    const result = transcribe(samples);
    if (result) publishPass(result, windowStart, samples.length / SAMPLE_RATE, final);
  } finally {
    samples.fill(0);
  }
}

async function initialize() {
  try {
    engine = await loadEngine();
    self.postMessage({ type: "READY" });
  } catch (error) {
    enginePromise = null;
    self.postMessage({ type: "ERROR", message: error?.message || "The local speech model could not start." });
  }
}

self.onmessage = async (event) => {
  const message = event.data ?? {};
  if (message.type === "INIT") {
    await initialize();
    return;
  }
  if (message.type === "AUDIO") {
    if (!engine) return;
    const samples = message.samples instanceof Float32Array
      ? message.samples
      : message.samples instanceof ArrayBuffer
        ? new Float32Array(message.samples)
        : null;
    if (!samples) return;
    appendAudio(samples);
    samples.fill(0);
    if (audioWindow.length >= MIN_WINDOW_SAMPLES && totalSamples - lastProcessedAt >= PROCESS_EVERY_SAMPLES) {
      lastProcessedAt = totalSamples;
      try {
        transcribeCurrent(false);
      } catch (error) {
        self.postMessage({ type: "ERROR", message: error?.message || "Local speech recognition stopped unexpectedly." });
      }
    }
    return;
  }
  if (message.type === "FINALIZE") {
    if (!engine) {
      self.postMessage({ type: "FINALIZED" });
      return;
    }
    try {
      if (audioWindow.length > 0) {
        transcribeCurrent(true);
        transcribeCurrent(true);
      }
    } catch (error) {
      self.postMessage({ type: "ERROR", message: error?.message || "The final words could not be transcribed." });
    }
    audioWindow.fill(0);
    audioWindow = new Float32Array(0);
    totalSamples = 0;
    lastProcessedAt = 0;
    previousPass = null;
    lastCommittedStart = -1;
    self.postMessage({ type: "FINALIZED" });
  }
};
