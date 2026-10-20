import { ChromeLocalAsr } from "./asr/chrome-local.js";
import { WhistleLocalAsr } from "./asr/whistle-local.js";
import { TranscriptionError } from "./lib/errors.js";
import { TranscriptBuffer } from "./lib/transcript-buffer.js";

export { TranscriptBuffer, TranscriptionError };
export { StreamingResampler } from "./lib/resampler.js";

export const SPEECH_ENGINES = Object.freeze(["chrome-local", "whistle-local"]);
const EVENT_TYPES = new Set(["state", "transcript", "chunk", "error"]);

/** Create a client-only transcriber. Audio and transcript data are never sent to a server. */
export function createTranscriber({
  engine = "chrome-local",
  language = "en-US",
  api = globalThis,
  maxTranscriptCharacters = 250_000,
  workerFactory = null,
} = {}) {
  if (!SPEECH_ENGINES.includes(engine)) {
    throw new RangeError(`Unsupported engine: ${engine}. Choose ${SPEECH_ENGINES.join(" or ")}.`);
  }
  return new LocalTranscriber({ engine, language, api, maxTranscriptCharacters, workerFactory });
}

class LocalTranscriber {
  constructor({ engine, language, api, maxTranscriptCharacters, workerFactory }) {
    this.engine = engine;
    this.language = language;
    this.api = api;
    this.listeners = new Map(Array.from(EVENT_TYPES, (type) => [type, new Set()]));
    this.buffer = new TranscriptBuffer({ maxCharacters: maxTranscriptCharacters });
    this.prepared = false;
    this.preparePromise = null;
    this.disposed = false;
    this.disposing = false;
    this.disposePromise = null;
    this.currentState = "idle";
    this.provider = engine === "chrome-local"
      ? new ChromeLocalAsr({
        api,
        language,
        onRevision: (revision) => this.#acceptBrowserRevision(revision),
        onState: (state) => {
          if (state === "error") this.prepared = false;
          this.#publishState(state);
        },
        onError: (message, code) => this.#publishError(new TranscriptionError(code || "RECOGNITION_ERROR", message, { recoverable: true })),
      })
      : new WhistleLocalAsr({
        api,
        workerFactory,
        onTranscript: (revision) => this.#acceptWhistleRevision(revision),
        onState: (state, detail) => {
          if (state === "error") this.prepared = false;
          this.#publishState(state, detail);
        },
        onError: (error) => this.#publishError(error),
      });
  }

  get state() {
    return this.currentState;
  }

  getSnapshot() {
    return { ...this.buffer.snapshot(), engine: this.engine };
  }

  on(type, listener) {
    if (!EVENT_TYPES.has(type)) throw new RangeError(`Unknown event type: ${type}.`);
    if (typeof listener !== "function") throw new TypeError("listener must be a function.");
    this.#assertNotDisposed();
    const listeners = this.listeners.get(type);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async prepare() {
    this.#assertNotDisposed();
    if (this.preparePromise) return this.preparePromise;
    let pending;
    pending = this.#prepareEngine().finally(() => {
      if (this.preparePromise === pending) this.preparePromise = null;
    });
    this.preparePromise = pending;
    return pending;
  }

  async #prepareEngine() {
    let result;
    try {
      result = await this.provider.prepare();
    } catch (cause) {
      if (this.disposed || this.disposing) throw cause;
      const error = cause instanceof TranscriptionError
        ? cause
        : new TranscriptionError("ENGINE_PREPARE_FAILED", cause?.message || "The local speech engine could not be prepared.", { cause, recoverable: true });
      if (this.currentState !== "error") this.#publishState("error", error.message);
      this.#publishError(error);
      throw error;
    }
    this.#assertNotDisposed();
    if (result.status !== "ready") {
      const errorDetails = result.error;
      const unsupported = result.status === "unsupported";
      const message = errorDetails?.message || (unsupported
        ? "This browser does not support on-device speech recognition. Choose the bundled Whistle engine."
        : "The selected local speech engine is unavailable. Check browser support and try again.");
      const error = new TranscriptionError(
        unsupported ? "ENGINE_UNSUPPORTED" : "ENGINE_UNAVAILABLE",
        message,
        { cause: errorDetails, recoverable: true },
      );
      this.prepared = false;
      this.#publishState("error", message);
      this.#publishError(error);
      throw error;
    }
    this.prepared = true;
    return { status: "ready", engine: this.engine, language: this.language };
  }

  async start() {
    this.#assertNotDisposed();
    if (!this.prepared) throw new TranscriptionError("NOT_PREPARED", "Call prepare() and wait for the local engine before starting the microphone.");
    const result = await this.provider.start();
    this.#assertNotDisposed();
    if (result.status === "unavailable" || result.status === "unsupported") {
      this.prepared = false;
      throw new TranscriptionError("ENGINE_UNAVAILABLE", "The local speech engine is not ready. Call prepare() again.", { recoverable: true });
    }
    if (result.status === "failed") {
      this.prepared = false;
      throw new TranscriptionError("RECOGNITION_START_FAILED", "Local speech recognition could not start. Retry after checking microphone access.", { recoverable: true });
    }
    return result;
  }

  async stop() {
    if (this.disposed || this.disposing) return { status: "disposed" };
    const result = await this.provider.stop();
    return result?.status ? result : { status: "stopped" };
  }

  clear() {
    this.#assertNotDisposed();
    const snapshot = this.buffer.clear();
    this.#emit("transcript", { ...snapshot, engine: this.engine, isFinal: true, receivedAt: Date.now() });
    return snapshot;
  }

  async dispose() {
    if (this.disposed) return;
    if (this.disposePromise) return this.disposePromise;
    this.disposing = true;
    this.disposePromise = (async () => {
      try {
        await this.provider.dispose?.();
      } finally {
        this.disposed = true;
        this.disposing = false;
        this.#publishState("disposed", "This transcription session has been disposed.");
        for (const listeners of this.listeners.values()) listeners.clear();
      }
    })();
    return this.disposePromise;
  }

  #acceptBrowserRevision(revision) {
    const before = this.buffer.snapshot();
    const accepted = this.buffer.acceptBrowserRevision({
      epoch: revision.epoch,
      index: revision.index,
      resultCount: revision.resultCount,
      text: revision.text,
      isFinal: revision.isFinal,
      receivedAt: revision.receivedAt,
    });
    if (revision.metadataOnly) {
      const after = this.buffer.snapshot();
      if (before.text === after.text && before.preview === after.preview) return;
    }
    if (accepted?.chunk) this.#emit("chunk", { ...accepted.chunk, engine: this.engine, isFinal: true });
    this.#emit("transcript", {
      ...this.buffer.snapshot(),
      engine: this.engine,
      isFinal: Boolean(revision.isFinal),
      receivedAt: revision.receivedAt,
      confidence: revision.confidence,
    });
  }

  #acceptWhistleRevision(revision) {
    const words = Array.from(revision.committed ?? [], (word) => String(word.text ?? "").trim()).filter(Boolean);
    if (words.length) {
      const chunk = this.buffer.appendStableChunk(words.join(" "), {
        id: `whistle:${revision.revision}`,
        receivedAt: revision.receivedAt,
        source: "whistle",
      });
      if (chunk) this.#emit("chunk", { ...chunk, engine: this.engine, isFinal: true });
    }
    this.buffer.setPreview(revision.preview);
    this.#emit("transcript", {
      ...this.buffer.snapshot(),
      engine: this.engine,
      isFinal: revision.isFinal,
      receivedAt: revision.receivedAt,
    });
  }

  #publishState(state, detail = "") {
    this.currentState = state;
    this.#emit("state", { state, detail, engine: this.engine, receivedAt: Date.now() });
  }

  #publishError(error) {
    this.#emit("error", {
      code: error?.code || "RECOGNITION_ERROR",
      message: error?.message || "Local speech recognition failed.",
      recoverable: Boolean(error?.recoverable),
      engine: this.engine,
      cause: error?.cause,
      receivedAt: Date.now(),
    });
  }

  #emit(type, detail) {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) {
      try {
        listener(detail);
      } catch (error) {
        this.api?.reportError?.(error);
      }
    }
  }

  #assertNotDisposed() {
    if (this.disposed || this.disposing) throw new TranscriptionError("DISPOSED", "This transcriber has been disposed.");
  }
}
