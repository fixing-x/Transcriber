# Browser API contract

`src/index.js` exposes the client-side API. It does not make HTTP requests to a transcription backend. The stable surface is `createTranscriber`, `SPEECH_ENGINES`, `TranscriptionError`, `TranscriptBuffer`, and `StreamingResampler`.

## Lifecycle

```text
createTranscriber → prepare → start → stop → start again / clear → dispose
```

- `createTranscriber(options)` validates the engine name and creates a session in memory.
- `prepare()` must complete before `start()`. It returns `{ status: "ready", engine, language }` or rejects with `TranscriptionError`. It never asks for microphone permission.
- `start()` should be called from a user gesture. The browser-local engine starts its local recognizer; Whistle requests a microphone stream and begins local WASM inference.
- `stop()` stops capture and flushes pending Whistle audio. It is safe to call when already stopped. It preserves finalized text.
- `clear()` removes this instance's final text and preview from memory. It does not stop the microphone.
- `dispose()` stops the provider, releases its resources, and makes the instance terminal.
- `on(type, callback)` returns an unsubscribe function. Supported events are `state`, `transcript`, `chunk`, and `error`.

Changing the engine or language requires a new instance. Dispose the old one first. The demo preserves its visible transcript across engine changes, but a raw API consumer controls that behavior.

## Events

### `state`

```ts
{
  state: "idle" | "checking" | "installing" | "loading" | "requesting" |
         "listening" | "reconnecting" | "stopping" | "ready" | "error" | "disposed",
  detail: string,
  engine: "chrome-local" | "whistle-local",
  receivedAt: number // Unix milliseconds
}
```

Use `state` to drive UI status. State labels are descriptive; use the stable string values for logic.

### `transcript`

```ts
{
  text: string,       // final, append-only speech text kept by this instance
  preview: string,    // current replaceable hypothesis
  chunks: TranscriptChunk[],
  wordCount: number,
  truncated: boolean, // true after the memory limit evicts older complete chunks
  engine: SpeechEngine,
  isFinal?: boolean,
  receivedAt?: number,
  confidence?: number | null
}
```

Chrome interims replace the current segment until the browser marks it final. Whistle previews use a rolling audio window and can repeat words that were just committed. Do not append `preview` to `text`; render it separately. Final chunks remain in order until `clear()`, `dispose()`, or the configured memory cap evicts the oldest ones.

### `chunk`

```ts
{
  id: string,
  sequence: number,
  text: string,
  receivedAt: number,
  source: "browser" | "whistle",
  engine: SpeechEngine,
  isFinal: true
}
```

Chunks are emitted once when the selected engine marks a segment stable. They are convenient for incremental rendering or persistence controlled by the consuming app. The library itself does not persist them.

### `error`

```ts
{
  code: string,
  message: string,
  recoverable: boolean,
  engine: SpeechEngine,
  cause?: unknown,
  receivedAt: number
}
```

Errors also reject the lifecycle call that encountered them. Handle both the event (for UI) and the rejected promise (for local control flow). `TranscriptionError.code` is machine-readable; display `message` to the user. The exact browser error set can vary by implementation.

Common codes include `NOT_PREPARED`, `ENGINE_UNSUPPORTED`, `ENGINE_UNAVAILABLE`, `MICROPHONE_DENIED`, `MICROPHONE_NOT_FOUND`, `MICROPHONE_BUSY`, `MICROPHONE_ENDED`, `SECURE_CONTEXT_REQUIRED`, `WORKER_UNAVAILABLE`, `MODEL_TIMEOUT`, `MODEL_ERROR`, and `AUDIO_WORKLET_UNAVAILABLE`.

## Options

```ts
createTranscriber({
  engine: "chrome-local" | "whistle-local", // default: "chrome-local"
  language: "en-US",                         // default; only used by Chrome local
  maxTranscriptCharacters: 250000,            // default
});
```

`whistle-local` auto-detects its supported languages. The bundled model documents English, German, French, Spanish, Italian, Dutch, and Polish. The Chrome local engine uses a BCP 47 language tag and requires that browser's on-device speech API and language pack.

## Privacy and network behavior

- Neither engine sends microphone audio or recognized text to this project's server.
- Chrome local explicitly sets `processLocally: true`; an unavailable local package is an error, never a reason to switch to cloud recognition. Chrome may need an initial language-pack download, which is managed by the browser.
- Whistle runs the bundled model in a Worker, with microphone samples downsampled to mono 16 kHz in an AudioWorklet. The first static-site use fetches the model files from the app's own origin; the service worker caches those files so subsequent sessions can run offline.
- The API retains transcript text in the current page's memory only. It does not use localStorage, IndexedDB, cookies, or a server.
- Microphone APIs need HTTPS or `localhost`. `file://` pages do not provide the required secure context.
- For `whistle-local`, host the ES module, classic worker, worklet, WASM, and `.cact` model on the consuming app's origin. Cross-origin Worker and AudioWorklet restrictions prevent a remote GitHub Pages import from hosting those execution assets for another site's origin.

## Third-party references

- [Web Speech API on-device recognition](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API#on-device_speech_recognition)
- [Whistle model and browser packaging](https://cactuscompute.com/blog/whistle#one-engine-three-ways-to-load-it)
