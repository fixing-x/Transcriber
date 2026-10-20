import { createTranscriber, SPEECH_ENGINES } from "./index.js";
import { ChromeLocalAsr } from "./asr/chrome-local.js";

const $ = (id) => document.getElementById(id);
const engineSelect = $("engine-select");
const languageSelect = $("language-select");
const prepareButton = $("prepare-button");
const startButton = $("start-button");
const stopButton = $("stop-button");
const copyButton = $("copy-button");
const downloadButton = $("download-button");
const clearButton = $("clear-button");
const errorMessage = $("error-message");
const stateTitle = $("state-title");
const stateDetail = $("state-detail");
const stateIndicator = $("status-indicator");
const engineNote = $("engine-note");
const setupHint = $("setup-hint");
const transcriptEmpty = $("transcript-empty");
const transcriptFinal = $("transcript-final");
const transcriptPreview = $("transcript-preview");
const previewRow = $("preview-row");
const wordCount = $("word-count");
const chunkCount = $("chunk-count");
const sessionClock = $("session-clock");
const announcer = $("announcer");

const STATE_COPY = {
  idle: ["Engine not prepared", "Prepare an engine, then allow microphone access when you press Start."],
  checking: ["Checking local engine", "Checking this browser’s on-device speech support."],
  installing: ["Preparing browser language pack", "The browser may download its speech package once. This project does not receive audio."],
  loading: ["Loading bundled model", "Reading the local model files into a browser worker."],
  requesting: ["Waiting for microphone", "Allow microphone access in the browser prompt to start the session."],
  listening: ["Listening on this device", "Speech is being transcribed locally. Press Stop to finish and flush the last chunk."],
  reconnecting: ["Reconnecting speech engine", "The browser ended a recognition segment. The local session will resume automatically."],
  stopping: ["Finishing the transcript", "Flushing the last captured audio and stable speech chunks."],
  ready: ["Local engine ready", "Ready when you are. The microphone is off until you press Start."],
  error: ["Engine needs attention", "Review the error below, then retry setup or choose another local engine."],
  disposed: ["Session closed", "Refresh the page to start a new session."],
};

let transcriber = null;
let isPrepared = false;
let isListening = false;
let isPreparing = false;
let transcriptPrefix = "";
let chunkPrefix = [];
let sessionStartedAt = 0;
let elapsedBeforeStart = 0;
let clockTimer = 0;
let activeDownloadUrl = "";
let currentState = "idle";
let disposed = false;
const serviceWorkerReady = registerServiceWorker();

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !globalThis.isSecureContext) return Promise.resolve(null);
  const serviceWorkerUrl = new URL("../service-worker.js", import.meta.url);
  return navigator.serviceWorker.register(serviceWorkerUrl, { scope: new URL("../", import.meta.url).pathname })
    .then(() => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 5000);
      navigator.serviceWorker.ready.then((registration) => {
        clearTimeout(timer);
        resolve(registration);
      }, () => {
        clearTimeout(timer);
        resolve(null);
      });
    }))
    .catch(() => null);
}

function engineDescription() {
  if (engineSelect.value === "whistle-local") {
    return "Whistle runs from the bundled WASM model in this browser. Its model files download from this site once, then the app can prepare it offline.";
  }
  return "Chrome’s on-device engine is quick when its language pack is installed. Chrome may download that pack once during setup.";
}

function updateSetup() {
  const engine = engineSelect.value;
  const usesWhistle = engine === "whistle-local";
  engineNote.textContent = engineDescription();
  languageSelect.disabled = usesWhistle || isListening || isPreparing;
  engineSelect.disabled = isListening || isPreparing;
  prepareButton.disabled = isListening || isPreparing || isPrepared;
  startButton.disabled = !isPrepared || isListening || isPreparing;
  stopButton.disabled = !isListening && currentState !== "requesting";
  prepareButton.querySelector("#prepare-label").textContent = isPrepared ? "Local engine ready" : isPreparing ? "Preparing…" : "Prepare local engine";
  prepareButton.setAttribute("aria-busy", String(isPreparing));
}

function setState(state, detail = "") {
  currentState = state;
  if (state === "error" || state === "disposed") isPrepared = false;
  if (state === "ready" || state === "error" || state === "idle" || state === "disposed") isListening = false;
  const [title, fallback] = STATE_COPY[state] ?? STATE_COPY.error;
  stateTitle.textContent = title;
  stateDetail.textContent = detail || fallback;
  stateIndicator.dataset.state = state;
  if (state === "listening") {
    if (!sessionStartedAt) startClock();
  } else if (state === "ready" || state === "error" || state === "idle" || state === "disposed") {
    pauseClock();
  }
  updateSetup();
  if (state !== "listening" && state !== "reconnecting") announcer.textContent = `${title}. ${detail || fallback}`;
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = !message;
}

function setEngineBadge(engine) {
  $("engine-badge").textContent = engine === "whistle-local" ? "WHISTLE · WASM" : "CHROME · LOCAL";
}

function createSession({ preserve = true } = {}) {
  if (preserve && transcriber) {
    const previous = transcriber.getSnapshot();
    transcriptPrefix = [transcriptPrefix, previous.text].filter(Boolean).join(" ");
    chunkPrefix = [...chunkPrefix, ...previous.chunks];
  }
  if (transcriber) void transcriber.dispose();

  transcriber = createTranscriber({ engine: engineSelect.value, language: languageSelect.value });
  const session = transcriber;
  isPrepared = false;
  isListening = false;
  isPreparing = false;
  setEngineBadge(engineSelect.value);
  showError("");
  session.on("state", ({ state, detail }) => {
    if (transcriber === session) setState(state, detail);
  });
  session.on("error", ({ code, message }) => {
    if (transcriber !== session) return;
    showError(message);
    if (currentState !== "listening" && currentState !== "stopping") setState("error");
    if (code === "MICROPHONE_DENIED") setupHint.textContent = "Microphone permission is blocked. Use the site controls in Chrome or the address bar to allow it, then press Start again.";
  });
  session.on("transcript", (snapshot) => {
    if (transcriber === session) renderSnapshot(snapshot);
  });
  session.on("chunk", (chunk) => {
    if (transcriber === session) appendChunkLabel(chunk);
  });
  renderSnapshot(transcriber.getSnapshot());
  setState("idle");
  updateSetup();
}

function compositeSnapshot(snapshot = transcriber?.getSnapshot()) {
  const chunks = [...chunkPrefix, ...(snapshot?.chunks ?? [])];
  const text = [transcriptPrefix, snapshot?.text].filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
  const words = Array.from(text.matchAll(/[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*(?:[-‐‑‒–—][\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*)*/gu)).length;
  return { text, preview: snapshot?.preview ?? "", chunks, wordCount: words, truncated: Boolean(snapshot?.truncated) };
}

function renderSnapshot(snapshot) {
  const composite = compositeSnapshot(snapshot);
  transcriptFinal.textContent = composite.text;
  transcriptFinal.hidden = !composite.text;
  transcriptEmpty.hidden = Boolean(composite.text);
  transcriptPreview.textContent = composite.preview;
  previewRow.hidden = !composite.preview;
  wordCount.textContent = `${composite.wordCount.toLocaleString()} ${composite.wordCount === 1 ? "word" : "words"}`;
  chunkCount.textContent = `${composite.chunks.length.toLocaleString()} stable ${composite.chunks.length === 1 ? "chunk" : "chunks"}${composite.truncated ? " · older text trimmed" : ""}`;
  const hasText = Boolean(composite.text || composite.preview);
  copyButton.disabled = !composite.text;
  downloadButton.disabled = !composite.text;
  clearButton.disabled = !hasText;
  if (composite.text) {
    const transcriptBody = $("transcript-body");
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
  }
}

function appendChunkLabel() {
  // The transcript itself remains plain text. Stable chunk counts are shown
  // above, while the API exposes each chunk to consumers as it arrives.
}

async function prepareEngine() {
  if (isPrepared || isPreparing) return;
  isPreparing = true;
  showError("");
  setupHint.textContent = engineSelect.value === "whistle-local"
    ? "Preparing Whistle downloads the bundled WASM and model from this site if they are not cached yet."
    : "Chrome checks for its local language pack and may download it once.";
  updateSetup();
  try {
    if (engineSelect.value === "whistle-local") await serviceWorkerReady;
    await transcriber.prepare();
    isPrepared = true;
    setupHint.textContent = engineSelect.value === "whistle-local"
      ? "The bundled model is ready. After its first download, Whistle can run without internet access."
      : "Chrome’s on-device speech package is ready. Recognition stays on this device.";
    setState("ready");
  } catch (error) {
    isPrepared = false;
    showError(error?.message || "The local speech engine could not be prepared.");
    setState("error");
  } finally {
    isPreparing = false;
    updateSetup();
  }
}

async function startListening() {
  if (!isPrepared || isListening || isPreparing) return;
  isListening = true;
  updateSetup();
  showError("");
  setupHint.textContent = "The browser will ask for microphone access if this site has not been allowed yet.";
  try {
    const result = await transcriber.start();
    if (result.status === "cancelled") {
      isListening = false;
      setState("ready");
    } else if (currentState !== "requesting" && currentState !== "listening") {
      setState("listening");
    }
  } catch (error) {
    isListening = false;
    showError(error?.message || "Local speech recognition could not start.");
    setState("error");
  } finally {
    updateSetup();
  }
}

async function stopListening() {
  if (!isListening && currentState !== "requesting") return;
  stopButton.disabled = true;
  setState("stopping");
  try {
    await transcriber.stop();
  } catch (error) {
    showError(error?.message || "The last audio chunk could not be finalized.");
  } finally {
    isListening = false;
    pauseClock();
    if (!disposed && !errorMessage.hidden) setState("error");
    else if (!disposed) setState("ready");
    updateSetup();
  }
}

function startClock() {
  if (sessionStartedAt) return;
  sessionStartedAt = Date.now();
  clearInterval(clockTimer);
  clockTimer = setInterval(renderClock, 500);
  renderClock();
}

function pauseClock() {
  if (sessionStartedAt) elapsedBeforeStart += Math.max(0, Date.now() - sessionStartedAt);
  sessionStartedAt = 0;
  clearInterval(clockTimer);
  clockTimer = 0;
  renderClock();
}

function renderClock() {
  const seconds = Math.floor((elapsedBeforeStart + (sessionStartedAt ? Date.now() - sessionStartedAt : 0)) / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  sessionClock.textContent = hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

async function copyTranscript() {
  const text = compositeSnapshot().text;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setupHint.textContent = "Transcript copied to the clipboard.";
  } catch {
    showError("Clipboard access is unavailable. You can still select and copy the transcript text.");
  }
}

function downloadTranscript() {
  const text = compositeSnapshot().text;
  if (!text) return;
  if (activeDownloadUrl) URL.revokeObjectURL(activeDownloadUrl);
  const downloadUrl = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  activeDownloadUrl = downloadUrl;
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = `transcript-${new Date().toISOString().slice(0, 10)}.txt`;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(downloadUrl);
    if (activeDownloadUrl === downloadUrl) activeDownloadUrl = "";
  }, 10_000);
}

function clearTranscript() {
  transcriptPrefix = "";
  chunkPrefix = [];
  transcriber.clear();
  renderSnapshot(transcriber.getSnapshot());
  setupHint.textContent = "Transcript cleared from this page.";
}

async function copyExample() {
  const code = $("api-example").textContent;
  try {
    await navigator.clipboard.writeText(code);
    $("copy-code-button").textContent = "Copied";
    setTimeout(() => { $("copy-code-button").textContent = "Copy example"; }, 1600);
  } catch {
    showError("Clipboard access is unavailable. Select and copy the example instead.");
  }
}

function onConfigurationChanged() {
  if (isListening || isPreparing) return;
  createSession({ preserve: true });
}

prepareButton.addEventListener("click", () => { void prepareEngine(); });
startButton.addEventListener("click", () => { void startListening(); });
stopButton.addEventListener("click", () => { void stopListening(); });
copyButton.addEventListener("click", () => { void copyTranscript(); });
downloadButton.addEventListener("click", downloadTranscript);
clearButton.addEventListener("click", clearTranscript);
$("copy-code-button").addEventListener("click", () => { void copyExample(); });
engineSelect.addEventListener("change", onConfigurationChanged);
languageSelect.addEventListener("change", onConfigurationChanged);
window.addEventListener("online", () => {
  if (engineSelect.value === "whistle-local" && !isPrepared) {
    setupHint.textContent = "Online. Prepare Whistle once to cache its local model for future offline sessions.";
  }
});
window.addEventListener("offline", () => {
  if (engineSelect.value === "whistle-local" && !isPrepared) {
    setupHint.textContent = "Offline. Whistle can prepare if its model files were already cached on this device.";
  }
});
window.addEventListener("pagehide", () => {
  disposed = true;
  clearInterval(clockTimer);
  if (activeDownloadUrl) URL.revokeObjectURL(activeDownloadUrl);
  void transcriber?.dispose();
});

if (!SPEECH_ENGINES.includes(engineSelect.value)) engineSelect.value = "chrome-local";
if (!ChromeLocalAsr.isSupported()) {
  engineNote.textContent = "This browser does not expose Chrome’s on-device speech API. Choose Whistle, which runs from the bundled local model.";
}
createSession({ preserve: false });
