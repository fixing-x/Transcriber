# Local Speech

A browser-side live transcription demo and JavaScript API. The Chrome extension, PDF reader, page matching, and highlighting prototype have been removed from the shipped app. This project only prepares a local speech engine, listens after a clear user action, and exposes live transcript updates to the page.

## What runs locally

There is no transcription server or cloud fallback. The microphone audio is processed by one of two explicitly selected engines:

| Engine | Processing | First setup |
| --- | --- | --- |
| `chrome-local` | Chrome's on-device Web Speech engine, with `processLocally: true` | Chrome may download its language pack once. Requires a Chrome build that exposes the on-device API. |
| `whistle-local` | The bundled Whistle model running through local WASM in a Worker | Downloads the bundled WASM and 16 MB model from this static site once. The service worker caches them for later offline sessions. |

The first visit to a GitHub Pages site needs internet to load the site. The bundled engine can work offline after its model files are cached. Chrome may need internet for its initial browser-managed language-pack download. During recognition, this project does not send audio or transcript text to a server. Chrome local never switches to browser cloud recognition.

## Run the demo locally

Microphone and audio worklet APIs require a secure context. Use `localhost`, not `file://`:

```sh
npm run dev
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). No npm packages need to be installed. Choose an engine, press **Prepare local engine**, then press **Start listening** and allow microphone access. The Whistle engine needs a first local download of its bundled model. The Chrome engine may need its on-device language pack installed.

Stop to flush the latest speech chunk. Final transcript text stays in the page's memory; it is not written to storage. Copy or download it if you want to keep it. Refreshing or closing the tab clears the session.

## Publish on GitHub Pages

The repository includes a GitHub Actions workflow at `.github/workflows/pages.yml`.

1. Push this project to a GitHub repository on the `main` branch.
2. In **Settings → Pages**, set the publishing source to **GitHub Actions**.
3. Push to `main` or run the Pages workflow manually. GitHub publishes the static demo at the repository's Pages URL.

The app uses relative asset URLs and works from a GitHub project subpath. The service worker caches the static shell and caches Whistle's WASM and model files the first time they are fetched. It does not cache microphone audio or transcript output.

## Use the API

This is a client-side ES module, not an HTTP transcription endpoint. Import the module from the deployed Pages URL, or copy `src/` and the required bundled assets into a same-origin web app. `chrome-local` can be imported as a module; `whistle-local` also needs its worker, audio worklet, WASM, and model files hosted on the app's origin.

```js
import { createTranscriber } from "https://YOUR-USER.github.io/YOUR-REPO/src/index.js";

const speech = createTranscriber({
  engine: "whistle-local", // or "chrome-local"
  language: "en-US",       // used by chrome-local; Whistle auto-detects
});

speech.on("transcript", ({ text, preview }) => {
  finalTranscript.textContent = text;
  livePreview.textContent = preview;
});

speech.on("chunk", ({ sequence, text, source }) => {
  console.log(`Stable chunk ${sequence} from ${source}:`, text);
});

speech.on("error", ({ code, message, recoverable }) => {
  console.error(code, message, recoverable);
});

prepareButton.addEventListener("click", async () => {
  await speech.prepare();
  startButton.disabled = false;
});

startButton.addEventListener("click", () => void speech.start());
stopButton.addEventListener("click", () => void speech.stop());
```

The API exposes `prepare()`, `start()`, `stop()`, `clear()`, `dispose()`, `getSnapshot()`, and `on(event, callback)`. See [docs/API.md](docs/API.md) for event shapes, lifecycle rules, errors, and TypeScript types in `src/index.d.ts`.

### Engine behavior

- `prepare()` must finish before `start()`. It loads Whistle or asks Chrome to check/install the selected on-device language pack. The demo gives setup its own user action.
- `start()` should be called from a user gesture. It requests microphone access only then.
- `transcript.text` contains stable final text; `transcript.preview` is replaceable speech-in-progress. Whistle's rolling preview can overlap its most recently committed words.
- `chunk` events are append-only segments the engine considers final. ASR can still make mistakes; consumers should preserve the provided boundaries and let users edit the resulting text.
- The session buffer is in memory and defaults to 250,000 characters. If it grows beyond that, it drops the oldest complete chunks and reports `truncated: true`.
- The browser engine only works where the on-device Web Speech methods are present and the language is available. The bundled model is the local fallback the caller chooses; the library never switches engines automatically.

## Checks

```sh
npm test
npm run check
```

The tests cover provider state, local-only configuration, interim/final transcript handling, duplicate chunk protection, memory limits, audio resampling, mic denial/cancellation, final audio flushing, and the model worker. Real microphone permission and speech quality still need a manual browser run on the target device.

## Third-party assets

Whistle, Needle, and PDF.js notices were included in the previous prototype. PDF.js is no longer shipped. The retained Whistle and Needle license text is in `licenses/`.
