import { TranscriptionError } from "../lib/errors.js";

const WORKER_READY_TIMEOUT_MS = 120_000;
const WORKLET_CLOSE_TIMEOUT_MS = 1_500;
const WORKER_FINALIZE_TIMEOUT_MS = 12_000;

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() ?? []) {
    try { track.stop(); } catch {}
  }
}

async function closeAudioContext(context) {
  if (!context || context.state === "closed") return;
  try { await context.close(); } catch {}
}

/** Captures mic audio and transcribes it with the bundled Whistle/WASM model. */
export class WhistleLocalAsr {
  constructor({
    api = globalThis,
    onTranscript = () => {},
    onState = () => {},
    onError = () => {},
    workerFactory = null,
  } = {}) {
    this.api = api;
    this.onTranscript = onTranscript;
    this.onState = onState;
    this.onError = onError;
    this.workerFactory = workerFactory;
    this.worker = null;
    this.preparePromise = null;
    this.ready = false;
    this.disposed = false;
    this.state = "idle";
    this.generation = 0;
    this.startPromise = null;
    this.stopPromise = null;
    this.captureClosePromise = null;
    this.stream = null;
    this.context = null;
    this.source = null;
    this.worklet = null;
    this.mute = null;
    this.closeResolve = null;
    this.finalizeResolve = null;
    this.finalizeTimer = 0;
    this.chunkSequence = 0;
    this.workerError = null;
    this.workerFailurePromise = null;
  }

  async prepare() {
    if (this.disposed) throw new TranscriptionError("DISPOSED", "This transcriber has been disposed.");
    if (this.ready) return { status: "ready" };
    if (this.preparePromise) return this.preparePromise;

    this.state = "loading";
    this.onState("loading", "Loading the bundled Whistle model. The first load reads about 16 MB from this site.");
    this.preparePromise = this.#prepareWorker().catch((error) => {
      if (!this.ready && !this.disposed) {
        this.state = "error";
        this.worker?.terminate();
        this.worker = null;
        this.activeWorker = null;
        this.onState("error", error?.message || "The local model could not be prepared.");
      }
      throw error;
    }).finally(() => { this.preparePromise = null; });
    return this.preparePromise;
  }

  async #prepareWorker() {
    if (typeof this.api.Worker !== "function" && typeof this.workerFactory !== "function") {
      throw new TranscriptionError("WORKER_UNAVAILABLE", "This browser cannot run the local speech worker.");
    }

    const workerUrl = new URL("../whistle-worker.js", import.meta.url);
    try {
      const createWorker = this.workerFactory ?? ((url, options) => new this.api.Worker(url, options));
      this.worker = createWorker(workerUrl, { type: "classic" });
    } catch (cause) {
      throw new TranscriptionError("WORKER_UNAVAILABLE", "The local speech worker could not start.", { cause });
    }

    const worker = this.worker;
    this.workerError = null;
    this.workerFailurePromise = null;
    worker.onmessage = (event) => {
      if (this.worker !== worker) return;
      this.#handleWorkerMessage(event.data ?? {});
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      event.preventDefault?.();
      const error = new TranscriptionError("WORKER_FAILED", "The local speech worker stopped unexpectedly.", { recoverable: true });
      this.workerError = error;
      if (!this.ready) this.#rejectPrepare(error);
      else void this.#failWorker(error);
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = this.api.setTimeout ?? setTimeout;
      const clear = this.api.clearTimeout ?? clearTimeout;
      const timer = timeout(() => {
        if (settled) return;
        settled = true;
        this.pendingPrepare = null;
        const error = new TranscriptionError("MODEL_TIMEOUT", "The local model took too long to load. Check that its bundled files are available, then retry.", { recoverable: true });
        this.worker?.terminate();
        this.worker = null;
        this.activeWorker = null;
        reject(error);
      }, WORKER_READY_TIMEOUT_MS);
      this.pendingPrepare = {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          clear(timer);
          this.pendingPrepare = null;
          resolve(value);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          clear(timer);
          this.pendingPrepare = null;
          reject(error);
        },
      };
      try {
        worker.postMessage({ type: "INIT" });
      } catch (cause) {
        this.pendingPrepare?.reject(new TranscriptionError("WORKER_START_FAILED", "The local speech worker could not be initialized.", { cause, recoverable: true }));
      }
    });
  }

  start() {
    if (this.disposed) return Promise.reject(new TranscriptionError("DISPOSED", "This transcriber has been disposed."));
    if (this.startPromise) return this.startPromise;
    let pending;
    pending = this.#beginStart().finally(() => {
      if (this.startPromise === pending) this.startPromise = null;
    });
    this.startPromise = pending;
    return pending;
  }

  async #beginStart() {
    const generation = ++this.generation;
    if (this.stopPromise) await this.stopPromise;
    if (this.disposed || generation !== this.generation) return { status: "cancelled" };
    if (!this.ready) throw new TranscriptionError("NOT_PREPARED", "Call prepare() and wait for the local model before starting the microphone.");
    if (this.state === "listening") return { status: "started", alreadyListening: true };
    this.state = "requesting";
    this.onState("requesting", "Waiting for microphone permission.");
    return this.#startCapture(generation);
  }

  async #startCapture(generation) {
    let stream = null;
    let context = null;
    let source = null;
    let worklet = null;
    let mute = null;
    try {
      if (this.api.isSecureContext === false) {
        throw new TranscriptionError("SECURE_CONTEXT_REQUIRED", "Microphone access needs HTTPS or localhost.");
      }
      const mediaDevices = this.api.navigator?.mediaDevices;
      if (typeof mediaDevices?.getUserMedia !== "function") {
        throw new TranscriptionError("MICROPHONE_UNAVAILABLE", "This browser does not expose microphone capture.");
      }
      stream = await mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 16_000 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (!this.#isCurrent(generation)) {
        stopTracks(stream);
        return { status: "cancelled" };
      }

      const AudioContextConstructor = this.api.AudioContext ?? this.api.webkitAudioContext;
      if (typeof AudioContextConstructor !== "function") {
        throw new TranscriptionError("AUDIO_WORKLET_UNAVAILABLE", "This browser cannot process microphone audio locally.");
      }
      context = new AudioContextConstructor({ latencyHint: "interactive" });
      if (!context.audioWorklet || typeof this.api.AudioWorkletNode !== "function") {
        throw new TranscriptionError("AUDIO_WORKLET_UNAVAILABLE", "This browser does not support AudioWorklet microphone processing.");
      }
      const workletUrl = new URL("../audio-capture-worklet.js", import.meta.url);
      await context.audioWorklet.addModule(workletUrl.href);
      await context.resume();
      if (!this.#isCurrent(generation)) {
        stopTracks(stream);
        await closeAudioContext(context);
        return { status: "cancelled" };
      }
      if (context.state !== "running") {
        throw new TranscriptionError("AUDIO_CONTEXT_SUSPENDED", "The browser could not activate microphone audio. Press Start again after interacting with the page.", { recoverable: true });
      }

      source = context.createMediaStreamSource(stream);
      worklet = new this.api.AudioWorkletNode(context, "readalong-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
      });
      mute = context.createGain();
      mute.gain.value = 0;
      worklet.port.onmessage = (event) => {
        const activeWorker = this.activeWorker;
        if (event.data?.type === "AUDIO" && activeWorker && this.worker === activeWorker) {
          try {
            activeWorker.postMessage({ type: "AUDIO", samples: event.data.samples }, [event.data.samples]);
          } catch (cause) {
            const error = new TranscriptionError("WORKER_FAILED", "The local speech worker could not receive microphone audio.", { cause, recoverable: true });
            void this.#failWorker(error);
          }
        } else if (event.data?.type === "CLOSED") {
          this.closeResolve?.();
        }
      };
      source.connect(worklet);
      worklet.connect(mute);
      mute.connect(context.destination);

      this.stream = stream;
      this.context = context;
      this.source = source;
      this.worklet = worklet;
      this.mute = mute;
      this.activeWorker = this.worker;
      for (const track of stream.getTracks()) {
        track.addEventListener("ended", () => {
          if (this.state !== "listening") return;
          const error = new TranscriptionError("MICROPHONE_ENDED", "The microphone stopped. Reconnect it and start again.", { recoverable: true });
          void this.stop().catch(() => {}).then(() => {
            if (this.disposed) return;
            this.state = "error";
            this.onState("error", error.message);
            this.onError(error);
          });
        }, { once: true });
      }
      this.state = "listening";
      this.onState("listening", "Microphone audio is being transcribed on this device.");
      return { status: "started" };
    } catch (cause) {
      stopTracks(stream);
      await closeAudioContext(context);
      this.#disconnect(source, worklet, mute);
      const error = cause instanceof TranscriptionError
        ? cause
        : this.#mapMediaError(cause);
      if (this.#isCurrent(generation)) {
        this.state = "ready";
        this.onState("ready", error.message);
        this.onError(error);
      }
      throw error;
    }
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === "requesting") {
      this.generation += 1;
      this.state = "ready";
      this.onState("ready", "Microphone setup canceled.");
      return Promise.resolve({ status: "stopped" });
    }
    if (this.state !== "listening") return Promise.resolve({ status: "stopped" });
    this.generation += 1;
    this.state = "stopping";
    this.onState("stopping", "Finishing the last local audio chunk.");
    let pending;
    pending = this.#stopCapture().finally(() => {
      if (this.stopPromise === pending) this.stopPromise = null;
    });
    this.stopPromise = pending;
    return pending;
  }

  async #stopCapture() {
    await this.#closeCaptureAndFlush();
    if (!this.workerError) await this.#finalizeWorker();
    if (this.workerFailurePromise) await this.workerFailurePromise;
    if (this.disposed) return { status: "stopped" };
    if (this.workerError) {
      if (this.state !== "error") {
        this.state = "error";
        this.onState("error", this.workerError.message);
      }
      return { status: "stopped" };
    }
    this.state = "ready";
    this.onState("ready", "Transcription is paused. Your transcript remains in this page until you clear it or close the tab.");
    return { status: "stopped" };
  }

  async dispose() {
    if (this.disposed) return;
    if (["listening", "requesting", "stopping"].includes(this.state)) await this.stop();
    this.disposed = true;
    this.state = "disposed";
    this.pendingPrepare?.reject(new TranscriptionError("DISPOSED", "The transcriber was disposed while its model was loading."));
    this.worker?.terminate();
    this.worker = null;
    this.activeWorker = null;
    this.ready = false;
    this.state = "disposed";
  }

  #handleWorkerMessage(message) {
    if (message.type === "READY") {
      this.ready = true;
      this.state = "ready";
      this.onState("ready", "Bundled Whistle model is ready. Speech stays on this device.");
      this.pendingPrepare?.resolve({ status: "ready" });
      return;
    }
    if (message.type === "ERROR") {
      const error = new TranscriptionError("MODEL_ERROR", message.message || "The local speech model failed.", { recoverable: true });
      if (!this.ready) this.#rejectPrepare(error);
      else if (this.state === "listening") {
        void this.stop().finally(() => this.onError(error));
      } else this.onError(error);
      return;
    }
    if (message.type === "TRANSCRIPT") {
      this.onTranscript({
        engine: "whistle-local",
        revision: ++this.chunkSequence,
        text: String(message.text ?? ""),
        preview: [message.text, message.pending].filter(Boolean).join(" ").trim(),
        committed: Array.from(message.committed ?? [], (word) => ({
          text: String(word?.text ?? ""),
          start: Number(word?.start),
          end: Number(word?.end),
          confidence: Number.isFinite(Number(word?.probability)) ? Number(word.probability) : null,
        })).filter((word) => word.text.trim()),
        isFinal: Boolean(message.final),
        receivedAt: Date.now(),
      });
      return;
    }
    if (message.type === "FINALIZED") this.finalizeResolve?.();
  }

  #rejectPrepare(error) {
    this.ready = false;
    this.worker?.terminate();
    this.worker = null;
    this.activeWorker = null;
    this.pendingPrepare?.reject(error);
  }

  #failWorker(error) {
    if (this.workerFailurePromise) return this.workerFailurePromise;
    this.workerError = error;
    this.workerFailurePromise = this.#cleanupFailedWorker(error).finally(() => {
      this.workerFailurePromise = null;
    });
    return this.workerFailurePromise;
  }

  async #cleanupFailedWorker(error) {
    this.ready = false;
    this.generation += 1;
    this.activeWorker = null;
    this.closeResolve?.();
    this.finalizeResolve?.();
    await this.#closeCaptureAndFlush();
    this.worker?.terminate();
    this.worker = null;
    this.activeWorker = null;
    this.state = "error";
    this.onState("error", error.message);
    this.onError(error);
  }

  #closeCaptureAndFlush() {
    if (this.captureClosePromise) return this.captureClosePromise;
    let pending;
    pending = this.#closeCapture().finally(() => {
      if (this.captureClosePromise === pending) this.captureClosePromise = null;
    });
    this.captureClosePromise = pending;
    return pending;
  }

  async #closeCapture() {
    const node = this.worklet;
    if (node && this.stream) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.closeResolve = null;
          resolve();
        };
        const timer = setTimeout(finish, WORKLET_CLOSE_TIMEOUT_MS);
        this.closeResolve = finish;
        try { node.port.postMessage({ type: "CLOSE" }); } catch { finish(); }
      });
    }
    this.#releaseCapture();
  }

  async #finalizeWorker() {
    if (!this.worker || !this.ready) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(this.finalizeTimer);
        this.finalizeTimer = 0;
        this.finalizeResolve = null;
        resolve();
      };
      this.finalizeResolve = finish;
      this.finalizeTimer = setTimeout(finish, WORKER_FINALIZE_TIMEOUT_MS);
      try { this.worker.postMessage({ type: "FINALIZE" }); } catch { finish(); }
    });
  }

  #releaseCapture() {
    const stream = this.stream;
    this.stream = null;
    stopTracks(stream);
    const context = this.context;
    this.context = null;
    this.#disconnect(this.source, this.worklet, this.mute);
    this.source = null;
    this.worklet = null;
    this.mute = null;
    void closeAudioContext(context);
    this.activeWorker = null;
  }

  #disconnect(source, worklet, mute) {
    if (worklet) {
      worklet.port.onmessage = null;
      try { worklet.disconnect(); } catch {}
    }
    try { source?.disconnect(); } catch {}
    try { mute?.disconnect(); } catch {}
  }

  #isCurrent(generation) {
    return !this.disposed && generation === this.generation;
  }

  #mapMediaError(error) {
    const codeByName = {
      NotAllowedError: ["MICROPHONE_DENIED", "Microphone access was denied. Allow it for this site, then try again."],
      PermissionDeniedError: ["MICROPHONE_DENIED", "Microphone access was denied. Allow it for this site, then try again."],
      NotFoundError: ["MICROPHONE_NOT_FOUND", "No microphone was found. Connect or enable one, then try again."],
      DevicesNotFoundError: ["MICROPHONE_NOT_FOUND", "No microphone was found. Connect or enable one, then try again."],
      NotReadableError: ["MICROPHONE_BUSY", "The microphone is busy or unavailable. Close other recording apps and retry."],
      TrackStartError: ["MICROPHONE_BUSY", "The microphone is busy or unavailable. Close other recording apps and retry."],
      OverconstrainedError: ["MICROPHONE_CONFIGURATION", "This microphone cannot provide a supported audio format."],
      AbortError: ["MICROPHONE_ABORTED", "Microphone setup was interrupted. Try again."],
      SecurityError: ["SECURE_CONTEXT_REQUIRED", "Microphone access needs HTTPS or localhost."],
    };
    const [code, message] = codeByName[error?.name] ?? ["MICROPHONE_FAILED", error?.message || "Microphone setup failed."];
    return new TranscriptionError(code, message, { cause: error, recoverable: true });
  }
}
