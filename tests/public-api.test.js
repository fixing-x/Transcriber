import test from "node:test";
import assert from "node:assert/strict";
import { createTranscriber, SPEECH_ENGINES, TranscriptionError } from "../src/index.js";

function createSpeechApi({ availability = "available" } = {}) {
  const instances = [];
  class Recognition {
    static async available() { return availability; }
    static async install() { return true; }
    constructor() {
      instances.push(this);
      this.startCount = 0;
      this.stopCount = 0;
    }
    start() {
      this.startCount += 1;
      this.onstart?.();
    }
    stop() {
      this.stopCount += 1;
      this.onend?.();
    }
  }
  return { api: { SpeechRecognition: Recognition, reportError() {} }, Recognition, instances };
}

function speechResult(text, isFinal) {
  const item = [{ transcript: text, confidence: 0.91 }];
  item.isFinal = isFinal;
  return item;
}

test("public API lists both local engines and rejects unknown engine names", () => {
  assert.deepEqual(SPEECH_ENGINES, ["chrome-local", "whistle-local"]);
  assert.throws(() => createTranscriber({ engine: "cloud" }), RangeError);
});

test("public API never starts before setup and reports unsupported local recognition", async () => {
  const transcriber = createTranscriber({ engine: "chrome-local", api: {} });

  await assert.rejects(transcriber.start(), (error) => error.code === "NOT_PREPARED");
  await assert.rejects(transcriber.prepare(), (error) => error.code === "ENGINE_UNSUPPORTED");
  assert.equal(transcriber.state, "error");
  await transcriber.dispose();
});

test("concurrent setup calls share one failure and emit one error event", async () => {
  const { api } = createSpeechApi({ availability: "unavailable" });
  const transcriber = createTranscriber({ engine: "chrome-local", api });
  const errors = [];
  transcriber.on("error", (error) => errors.push(error));

  const results = await Promise.allSettled([transcriber.prepare(), transcriber.prepare()]);

  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "ENGINE_UNAVAILABLE");
  await transcriber.dispose();
});

test("public API exposes a stable snapshot, interim updates, final chunks, and unsubscribe", async () => {
  const { api, instances } = createSpeechApi();
  const transcriber = createTranscriber({ engine: "chrome-local", api });
  const snapshots = [];
  const chunks = [];
  const states = [];
  const unsubscribe = transcriber.on("transcript", (snapshot) => snapshots.push(snapshot));
  transcriber.on("chunk", (chunk) => chunks.push(chunk));
  transcriber.on("state", (state) => states.push(state.state));

  await transcriber.prepare();
  await transcriber.start();
  const recognition = instances[0];
  recognition.onresult({ resultIndex: 0, results: [speechResult("we are", false)] });
  recognition.onresult({ resultIndex: 0, results: [speechResult("we are ready", true)] });

  assert.equal(transcriber.state, "listening");
  assert.equal(snapshots[0].preview, "we are");
  assert.equal(snapshots.at(-1).text, "we are ready");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, "we are ready");
  assert.ok(states.includes("ready"));
  assert.ok(states.includes("listening"));

  unsubscribe();
  recognition.onresult({ resultIndex: 1, results: [speechResult("we are ready", true), speechResult("again", true)] });
  assert.equal(snapshots.length, 2);
  assert.equal(chunks.length, 2);

  await transcriber.stop();
  assert.equal(transcriber.state, "ready");
  await transcriber.dispose();
  await assert.rejects(transcriber.prepare(), TranscriptionError);
});

test("dispose emits a terminal state and is safe to call more than once", async () => {
  const { api } = createSpeechApi();
  const transcriber = createTranscriber({ engine: "chrome-local", api });
  const states = [];
  transcriber.on("state", (event) => states.push(event.state));

  await Promise.all([transcriber.dispose(), transcriber.dispose()]);

  assert.equal(transcriber.state, "disposed");
  assert.equal(states.at(-1), "disposed");
  await transcriber.dispose();
});
