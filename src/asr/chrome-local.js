const LOCAL_OPTIONS = Object.freeze({
  processLocally: true,
  quality: "dictation",
});

const FATAL_ERRORS = new Set([
  "not-allowed",
  "service-not-allowed",
  "language-not-supported",
  "audio-capture",
  "network",
]);

function speechError(event) {
  const code = event?.error || "recognition-error";
  const messages = {
    "not-allowed": "Microphone access was denied. Allow microphone access for this site, then try again.",
    "service-not-allowed": "The browser blocked local speech recognition for this site.",
    "language-not-supported": "This language is not installed for on-device recognition in this browser.",
    "audio-capture": "The browser could not open a microphone. Check that one is connected and available.",
    network: "The browser reported a network error. Local recognition was not switched to a cloud service.",
    aborted: "Recognition was interrupted.",
    "no-speech": "No speech was detected.",
  };
  return { code, message: event?.message || messages[code] || "Local speech recognition stopped unexpectedly." };
}

/** Adapter for the browser's on-device Web Speech implementation. */
export class ChromeLocalAsr {
  static isSupported(api = globalThis) {
    const Recognition = api?.SpeechRecognition;
    return typeof Recognition === "function" &&
      typeof Recognition.available === "function" &&
      typeof Recognition.install === "function";
  }

  constructor({
    api = globalThis,
    language = "en-US",
    onRevision = () => {},
    onState = () => {},
    onError = () => {},
    restartDelay = 250,
    maxRestartDelay = 2000,
    stopTimeout = 2500,
  } = {}) {
    this.api = api;
    this.language = language;
    this.onRevision = onRevision;
    this.onState = onState;
    this.onError = onError;
    this.restartDelay = restartDelay;
    this.maxRestartDelay = Math.max(restartDelay, maxRestartDelay);
    this.stopTimeout = stopTimeout;
    this.recognition = null;
    this.wantsListening = false;
    this.revision = 0;
    this.epoch = 0;
    this.restartTimer = 0;
    this.restartAttempt = 0;
    this.preparePromise = null;
    this.startPromise = null;
    this.startGeneration = 0;
    this.stopPromise = null;
    this.stopResolve = null;
    this.stopTimer = 0;
    this.prepared = false;
    this.disposed = false;
  }

  async prepare() {
    if (this.disposed) return { status: "disposed" };
    if (!ChromeLocalAsr.isSupported(this.api)) return { status: "unsupported" };
    if (this.prepared) return { status: "ready" };
    if (this.preparePromise) return this.preparePromise;

    this.preparePromise = this.#prepare().finally(() => { this.preparePromise = null; });
    return this.preparePromise;
  }

  async #prepare() {
    const Recognition = this.api.SpeechRecognition;
    const options = { ...LOCAL_OPTIONS, langs: [this.language] };
    this.onState("checking");
    let availability;
    try {
      availability = await Recognition.available(options);
    } catch (error) {
      if (this.disposed) return { status: "disposed" };
      return { status: "unavailable", error: this.#errorDetails(error, "availability-check-failed") };
    }
    if (this.disposed) return { status: "disposed" };

    if (availability === "unavailable") return { status: "unavailable" };
    if (availability !== "available") {
      this.onState("installing");
      try {
        const installed = await Recognition.install(options);
        if (this.disposed) return { status: "disposed" };
        if (!installed) return { status: "unavailable" };
      } catch (error) {
        if (this.disposed) return { status: "disposed" };
        return { status: "unavailable", error: this.#errorDetails(error, "language-install-failed") };
      }
    }
    this.prepared = true;
    this.onState("ready");
    return { status: "ready" };
  }

  start() {
    if (this.disposed) return Promise.resolve({ status: "disposed" });
    if (this.startPromise) return this.startPromise;

    const generation = ++this.startGeneration;
    let pending;
    pending = this.#beginStart(generation).finally(() => {
      if (this.startPromise === pending) this.startPromise = null;
    });
    this.startPromise = pending;
    return pending;
  }

  async #beginStart(generation) {
    if (this.stopPromise) await this.stopPromise;
    if (this.disposed || generation !== this.startGeneration) return { status: "cancelled" };
    if (this.wantsListening) return { status: "started", alreadyListening: true };
    if (!this.prepared) {
      const result = await this.prepare();
      if (result.status !== "ready") return result;
    }
    if (this.disposed || generation !== this.startGeneration) return { status: "cancelled" };
    if (this.wantsListening) return { status: "started", alreadyListening: true };
    this.wantsListening = true;
    this.restartAttempt = 0;
    this.lastError = null;
    return this.#startRecognition() ? { status: "started" } : { status: "failed" };
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.startGeneration += 1;
    this.startPromise = null;
    this.wantsListening = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = 0;
    const recognition = this.recognition;
    if (!recognition) {
      if (!this.disposed) this.onState(this.lastError ? "error" : "ready");
      return Promise.resolve();
    }

    this.onState("stopping");
    let resolveStop;
    const stopPromise = new Promise((resolve) => { resolveStop = resolve; });
    this.stopPromise = stopPromise;
    this.stopResolve = resolveStop;
    const timeout = this.api.setTimeout ?? setTimeout;
    this.stopTimer = timeout(() => {
      if (this.recognition === recognition) this.recognition = null;
      try { recognition.abort?.(); } catch {}
      if (!this.disposed) this.onState(this.lastError ? "error" : "ready");
      this.lastError = null;
      this.#finishStop();
    }, this.stopTimeout);
    try {
      recognition.stop();
    } catch {
      try { recognition.abort?.(); } catch {}
    }
    return stopPromise;
  }

  async dispose() {
    await this.stop();
    this.disposed = true;
  }

  #startRecognition() {
    if (!this.wantsListening || this.disposed) return false;
    const Recognition = this.api.SpeechRecognition;
    let recognition;
    try {
      recognition = new Recognition();
      recognition.lang = this.language;
      recognition.processLocally = true;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
    } catch (error) {
      this.wantsListening = false;
      this.#reportError(error, "recognition-constructor-failed");
      this.onState("error");
      return false;
    }
    const epoch = ++this.epoch;
    recognition.onstart = () => {
      if (this.recognition !== recognition) return;
      if (!this.wantsListening) {
        try { recognition.stop(); } catch { try { recognition.abort?.(); } catch {} }
        return;
      }
      this.onState("listening");
    };
    recognition.onresult = (event) => {
      if (this.recognition !== recognition) return;
      const results = event?.results;
      if (!results || !Number.isInteger(Number(results.length))) return;
      const resultCount = Number(results.length);
      const resultIndex = Number.isInteger(Number(event.resultIndex)) ? Number(event.resultIndex) : 0;
      this.onRevision({
        revision: ++this.revision,
        epoch,
        index: -1,
        resultCount,
        text: "",
        isFinal: false,
        metadataOnly: true,
        receivedAt: Date.now(),
        engine: "chrome-local",
      });
      for (let index = Math.max(0, resultIndex); index < resultCount; index += 1) {
        const item = results[index];
        const alternative = item?.[0];
        const text = String(alternative?.transcript ?? "").trim();
        if (!text) continue;
        this.restartAttempt = 0;
        this.onRevision({
          revision: ++this.revision,
          epoch,
          index,
          resultCount,
          text,
          isFinal: Boolean(item.isFinal),
          confidence: Number.isFinite(Number(alternative?.confidence)) ? Number(alternative.confidence) : null,
          receivedAt: Date.now(),
          engine: "chrome-local",
        });
      }
    };
    recognition.onerror = (event) => {
      if (!this.wantsListening && event?.error === "aborted") return;
      if (event?.error === "no-speech") return;
      const result = speechError(event);
      if (FATAL_ERRORS.has(result.code)) this.wantsListening = false;
      this.lastError = FATAL_ERRORS.has(result.code) ? result : null;
      if (this.lastError) this.onState("error");
      this.onError(result.message, result.code);
    };
    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      this.recognition = null;
      if (!this.wantsListening || this.disposed) {
        if (!this.disposed) this.onState(this.lastError ? "error" : "ready");
        this.lastError = null;
        this.#finishStop();
        return;
      }
      const delay = Math.min(this.maxRestartDelay, this.restartDelay * (2 ** this.restartAttempt));
      this.restartAttempt += 1;
      this.onState("reconnecting");
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = 0;
        if (this.wantsListening && !this.disposed) this.#startRecognition();
      }, delay);
    };
    this.recognition = recognition;
    this.onState("requesting");
    try {
      recognition.start();
      return true;
    } catch (error) {
      if (this.recognition === recognition) this.recognition = null;
      this.wantsListening = false;
      const result = this.#reportError(error, "recognition-start-failed");
      this.onState("error");
      return false;
    }
  }

  #reportError(error, fallbackCode) {
    const detail = this.#errorDetails(error, fallbackCode);
    this.onError(detail.message, detail.code);
    return detail;
  }

  #errorDetails(error, fallbackCode) {
    return {
      code: error?.name || fallbackCode,
      message: error?.message || "The browser could not prepare local speech recognition.",
    };
  }

  #finishStop() {
    (this.api.clearTimeout ?? clearTimeout)(this.stopTimer);
    this.stopTimer = 0;
    const resolve = this.stopResolve;
    this.stopResolve = null;
    this.stopPromise = null;
    resolve?.();
  }
}
