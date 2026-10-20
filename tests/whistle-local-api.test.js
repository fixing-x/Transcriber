import test from "node:test";
import assert from "node:assert/strict";
import { createTranscriber } from "../src/index.js";

function createWhistleBrowser({ getUserMedia = async () => createStream(), initError = "", holdFinalize = false, holdPrepare = false } = {}) {
  const workers = [];
  const worklets = [];
  const audioContexts = [];
  const workerMessages = [];
  let captureRequests = 0;

  class WorkerStub {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.messages = [];
      workers.push(this);
    }
    postMessage(message, transfer) {
      this.messages.push({ message, transfer });
      workerMessages.push(message.type);
      if (message.type === "INIT" && !holdPrepare) queueMicrotask(() => this.onmessage?.({ data: initError
        ? { type: "ERROR", message: initError }
        : { type: "READY" } }));
      if (message.type === "FINALIZE" && !holdFinalize) queueMicrotask(() => this.onmessage?.({ data: { type: "FINALIZED" } }));
    }
    terminate() { this.terminated = true; }
  }

  class AudioWorkletNodeStub {
    constructor(_context, name, options) {
      this.name = name;
      this.options = options;
      this.port = {
        onmessage: null,
        postMessage: (message) => {
          if (message.type === "CLOSE") queueMicrotask(() => this.port.onmessage?.({ data: { type: "CLOSED" } }));
        },
      };
      worklets.push(this);
    }
    connect() {}
    disconnect() { this.disconnected = true; }
  }

  class AudioContextStub {
    constructor() {
      this.state = "running";
      this.audioWorklet = { addModule: async (url) => { this.workletUrl = url; } };
      this.destination = {};
      audioContexts.push(this);
    }
    async resume() { this.state = "running"; }
    createMediaStreamSource(stream) { this.stream = stream; return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async close() { this.state = "closed"; }
  }

  return {
    api: {
      Worker: WorkerStub,
      AudioContext: AudioContextStub,
      AudioWorkletNode: AudioWorkletNodeStub,
      navigator: { mediaDevices: { getUserMedia: (...args) => { captureRequests += 1; return getUserMedia(...args); } } },
      isSecureContext: true,
    },
    workers,
    worklets,
    audioContexts,
    workerMessages,
    get captureRequests() { return captureRequests; },
  };
}

function createStream() {
  const track = {
    stopped: false,
    listeners: new Map(),
    stop() { this.stopped = true; },
    addEventListener(name, callback) { this.listeners.set(name, callback); },
  };
  return { track, getTracks() { return [track]; } };
}

test("Whistle prepares one local worker, streams worklet audio, commits chunks, and flushes on stop", async () => {
  const stream = createStream();
  const browser = createWhistleBrowser({ getUserMedia: async () => stream });
  const transcriber = createTranscriber({ engine: "whistle-local", api: browser.api });
  const chunks = [];
  transcriber.on("chunk", (chunk) => chunks.push(chunk));

  await transcriber.prepare();
  assert.equal(browser.workers.length, 1);
  assert.equal(browser.workers[0].options.type, "classic");
  await transcriber.start();
  assert.equal(transcriber.state, "listening");
  assert.match(String(browser.audioContexts[0].workletUrl), /audio-capture-worklet\.js/);

  const audioBuffer = new Float32Array([0.1, 0.2]).buffer;
  browser.worklets[0].port.onmessage({ data: { type: "AUDIO", samples: audioBuffer } });
  assert.ok(browser.workerMessages.includes("AUDIO"));

  browser.workers[0].onmessage({ data: {
    type: "TRANSCRIPT",
    text: "we read a line",
    pending: "next",
    revision: 1,
    committed: [{ text: "we read a line", start: 0, end: 1.2, probability: 0.95 }],
  } });
  assert.equal(transcriber.getSnapshot().text, "we read a line");
  assert.equal(chunks.length, 1);

  await transcriber.stop();
  assert.equal(stream.track.stopped, true);
  assert.ok(browser.workerMessages.includes("FINALIZE"));
  assert.equal(transcriber.state, "ready");
  await transcriber.dispose();
  assert.equal(browser.workers[0].terminated, true);
});

test("microphone denial is reported as a recoverable API error without leaking a stream", async () => {
  const browser = createWhistleBrowser({
    getUserMedia: async () => { throw Object.assign(new Error("permission denied"), { name: "NotAllowedError" }); },
  });
  const transcriber = createTranscriber({ engine: "whistle-local", api: browser.api });
  const errors = [];
  transcriber.on("error", (error) => errors.push(error));
  await transcriber.prepare();

  await assert.rejects(transcriber.start(), (error) => error.code === "MICROPHONE_DENIED");
  assert.equal(errors.at(-1).recoverable, true);
  assert.equal(transcriber.state, "ready");
  await transcriber.dispose();
});

test("removed microphones stop capture and leave a recoverable terminal error", async () => {
  const stream = createStream();
  const browser = createWhistleBrowser({ getUserMedia: async () => stream });
  const transcriber = createTranscriber({ engine: "whistle-local", api: browser.api });
  const errors = [];
  transcriber.on("error", (error) => errors.push(error));
  await transcriber.prepare();
  await transcriber.start();

  stream.track.listeners.get("ended")();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stream.track.stopped, true);
  assert.equal(transcriber.state, "error");
  assert.equal(errors.at(-1).code, "MICROPHONE_ENDED");
  await transcriber.dispose();
});

test("insecure contexts fail before microphone capture is attempted", async () => {
  const browser = createWhistleBrowser();
  browser.api.isSecureContext = false;
  const transcriber = createTranscriber({ engine: "whistle-local", api: browser.api });
  const errors = [];
  transcriber.on("error", (error) => errors.push(error));
  await transcriber.prepare();

  await assert.rejects(transcriber.start(), (error) => error.code === "SECURE_CONTEXT_REQUIRED");

  assert.equal(browser.captureRequests, 0);
  assert.equal(errors.at(-1).code, "SECURE_CONTEXT_REQUIRED");
  await transcriber.dispose();
});

test("missing AudioWorklet support releases a stream before returning an error", async () => {
  const stream = createStream();
  const browser = createWhistleBrowser({ getUserMedia: async () => stream });
  browser.api.AudioWorkletNode = undefined;
  const transcriber = createTranscriber({ engine: "whistle-local", api: browser.api });
  const errors = [];
  transcriber.on("error", (error) => errors.push(error));
  await transcriber.prepare();

  await assert.rejects(transcriber.start(), (error) => error.code === "AUDIO_WORKLET_UNAVAILABLE");

  assert.equal(stream.track.stopped, true);
  assert.equal(browser.audioContexts[0].state, "closed");
  assert.equal(errors.at(-1).code, "AUDIO_WORKLET_UNAVAILABLE");
  await transcriber.dispose();
});

test("Whistle preparation failures reject and emit one API error", async () => {
  const browser = createWhistleBrowser({ initError: "model files are missing" });
  const transcriber = createTranscriber({ engine: "whistle-local", api: browser.api });
  const errors = [];
  transcriber.on("error", (error) => errors.push(error));

  await assert.rejects(transcriber.prepare(), (error) => error.code === "MODEL_ERROR");

  assert.equal(transcriber.state, "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "MODEL_ERROR");
  await transcriber.dispose();
});

test("disposing during model setup terminates the worker without a late error state", async () => {
  const browser = createWhistleBrowser({ holdPrepare: true });
  const transcriber = createTranscriber({ engine: "whistle-local", api: browser.api });
  const errors = [];
  const states = [];
  transcriber.on("error", (error) => errors.push(error));
  transcriber.on("state", ({ state }) => states.push(state));

  const preparing = transcriber.prepare();
  await new Promise((resolve) => setImmediate(resolve));
  await transcriber.dispose();

  await assert.rejects(preparing, (error) => error.code === "DISPOSED");
  assert.equal(browser.workers[0].terminated, true);
  assert.equal(transcriber.state, "disposed");
  assert.equal(states.at(-1), "disposed");
  assert.equal(errors.length, 0);
});

test("stopping while the microphone prompt is open cancels late permission and stops its track", async () => {
  let resolvePermission;
  const stream = createStream();
  const browser = createWhistleBrowser({
    getUserMedia: () => new Promise((resolve) => { resolvePermission = resolve; }),
  });
  const transcriber = createTranscriber({ engine: "whistle-local", api: browser.api });
  await transcriber.prepare();

  const starting = transcriber.start();
  await Promise.resolve();
  await transcriber.stop();
  resolvePermission(stream);

  assert.deepEqual(await starting, { status: "cancelled" });
  assert.equal(stream.track.stopped, true);
  assert.equal(transcriber.state, "ready");
  await transcriber.dispose();
});

test("a worker that cannot accept an audio chunk releases the microphone and reports one failure", async () => {
  const stream = createStream();
  const browser = createWhistleBrowser({ getUserMedia: async () => stream });
  const transcriber = createTranscriber({ engine: "whistle-local", api: browser.api });
  const errors = [];
  transcriber.on("error", (error) => errors.push(error));
  await transcriber.prepare();
  await transcriber.start();

  browser.workers[0].postMessage = () => { throw new Error("worker terminated"); };
  browser.worklets[0].port.onmessage({ data: { type: "AUDIO", samples: new Float32Array([0.1]).buffer } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(transcriber.state, "error");
  assert.equal(stream.track.stopped, true);
  assert.equal(errors.filter((error) => error.code === "WORKER_FAILED").length, 1);
  await transcriber.dispose();
});

test("concurrent stop calls await one Whistle flush", async () => {
  const browser = createWhistleBrowser({ holdFinalize: true });
  const transcriber = createTranscriber({ engine: "whistle-local", api: browser.api });
  await transcriber.prepare();
  await transcriber.start();

  const firstStop = transcriber.stop();
  const secondStop = transcriber.stop();
  let secondSettled = false;
  secondStop.then(() => { secondSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(secondSettled, false);
  assert.equal(browser.workerMessages.filter((type) => type === "FINALIZE").length, 1);
  browser.workers[0].onmessage({ data: { type: "FINALIZED" } });
  await Promise.all([firstStop, secondStop]);

  assert.equal(transcriber.state, "ready");
  await transcriber.dispose();
});

test("starting while Whistle is flushing waits, then opens a new capture", async () => {
  const browser = createWhistleBrowser();
  const transcriber = createTranscriber({ engine: "whistle-local", api: browser.api });
  await transcriber.prepare();
  await transcriber.start();

  const stopping = transcriber.stop();
  const restarting = transcriber.start();
  await Promise.all([stopping, restarting]);

  assert.equal(browser.captureRequests, 2);
  assert.equal(transcriber.state, "listening");
  await transcriber.stop();
  await transcriber.dispose();
});
