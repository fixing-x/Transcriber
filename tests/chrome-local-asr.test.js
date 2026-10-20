import test from "node:test";
import assert from "node:assert/strict";
import { ChromeLocalAsr } from "../src/asr/chrome-local.js";

function createSpeechApi({ availability = "available", installResult = true } = {}) {
  const instances = [];
  class Recognition {
    static async available(options) {
      Recognition.availableOptions = options;
      return availability;
    }

    static async install(options) {
      Recognition.installOptions = options;
      return installResult;
    }

    constructor() {
      instances.push(this);
      this.startCalls = 0;
      this.stopCalls = 0;
    }

    start() { this.startCalls += 1; }
    stop() {
      this.stopCalls += 1;
      queueMicrotask(() => this.onend?.());
    }
  }
  return { SpeechRecognition: Recognition, instances, Recognition };
}

function result(transcript, isFinal = false) {
  const alternative = { transcript, confidence: 0.9 };
  const item = [alternative];
  item.isFinal = isFinal;
  return item;
}

test("checks and installs local dictation before recognition starts", async () => {
  const api = createSpeechApi({ availability: "downloadable" });
  const states = [];
  const recognizer = new ChromeLocalAsr({ api, onState: (state) => states.push(state) });

  const prepared = await recognizer.prepare();

  assert.equal(prepared.status, "ready");
  assert.deepEqual(api.Recognition.availableOptions, { langs: ["en-US"], processLocally: true, quality: "dictation" });
  assert.deepEqual(api.Recognition.installOptions, { langs: ["en-US"], processLocally: true, quality: "dictation" });
  assert.ok(states.includes("installing"));
});

test("concurrent start calls create only one browser recognition session", async () => {
  const api = createSpeechApi();
  const recognizer = new ChromeLocalAsr({ api });
  await recognizer.prepare();

  const results = await Promise.all([recognizer.start(), recognizer.start()]);

  assert.equal(api.instances.length, 1);
  assert.equal(api.instances[0].startCalls, 1);
  assert.ok(results.every((result) => result.status === "started"));
  await recognizer.stop();
});

test("stop cancels a start that is waiting for local language setup", async () => {
  let resolveAvailability;
  const api = createSpeechApi();
  api.SpeechRecognition.available = () => new Promise((resolve) => { resolveAvailability = resolve; });
  const recognizer = new ChromeLocalAsr({ api });

  const starting = recognizer.start();
  await Promise.resolve();
  await recognizer.stop();
  resolveAvailability("available");

  assert.deepEqual(await starting, { status: "cancelled" });
  assert.equal(api.instances.length, 0);

  assert.deepEqual(await recognizer.start(), { status: "started" });
  assert.equal(api.instances.length, 1);
  await recognizer.stop();
});

test("uses only local, continuous recognition and forwards mutable revisions", async () => {
  const api = createSpeechApi();
  const revisions = [];
  const recognizer = new ChromeLocalAsr({ api, onRevision: (revision) => revisions.push(revision) });
  await recognizer.prepare();
  await recognizer.start();
  const instance = api.instances[0];

  assert.equal(instance.processLocally, true);
  assert.equal(instance.continuous, true);
  assert.equal(instance.interimResults, true);
  assert.equal(instance.lang, "en-US");
  assert.equal(instance.startCalls, 1);

  instance.onresult({ resultIndex: 0, results: [result("we read", false), result("the line", true)] });

  assert.deepEqual(revisions.filter(({ metadataOnly }) => !metadataOnly).map(({ text, isFinal }) => ({ text, isFinal })), [
    { text: "we read", isFinal: false },
    { text: "the line", isFinal: true },
  ]);
});

test("stop accepts final speech emitted while Chrome is draining the microphone", async () => {
  const api = createSpeechApi();
  const revisions = [];
  const recognizer = new ChromeLocalAsr({ api });
  recognizer.onRevision = (revision) => revisions.push(revision);
  await recognizer.prepare();
  await recognizer.start();
  const instance = api.instances[0];

  const stopped = recognizer.stop();
  instance.onresult({ resultIndex: 0, results: [result("last words", true)] });
  instance.onend();
  await stopped;

  assert.equal(instance.stopCalls, 1);
  assert.equal(instance.startCalls, 1);
  assert.equal(revisions.at(-1).text, "last words");
});

test("a recognition error stops automatic restart and exposes the local error", async () => {
  const api = createSpeechApi();
  const errors = [];
  const recognizer = new ChromeLocalAsr({ api, onError: (message) => errors.push(message) });
  await recognizer.prepare();
  await recognizer.start();
  const instance = api.instances[0];

  instance.onerror({ error: "language-not-supported" });
  instance.onend();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(instance.startCalls, 1);
  assert.match(errors[0], /not installed for on-device recognition/);
});

test("reports an unavailable local engine without creating a cloud fallback", async () => {
  const api = createSpeechApi({ availability: "unavailable" });
  const recognizer = new ChromeLocalAsr({ api });

  const prepared = await recognizer.prepare();

  assert.equal(prepared.status, "unavailable");
  assert.equal(api.instances.length, 0);
});
