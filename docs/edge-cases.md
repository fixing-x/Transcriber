# Local Speech edge-case behavior

This project transcribes live microphone speech in the browser. It does not follow a document, highlight text, or send audio to a service. Speech-to-text can make mistakes; the interface keeps interim hypotheses separate from final transcript chunks.

| Situation | Expected behavior |
|---|---|
| Browser does not support on-device Web Speech methods | `chrome-local` preparation fails with `ENGINE_UNSUPPORTED`. The caller can explicitly choose `whistle-local`; there is no cloud fallback. |
| Chrome has no local language pack | Preparation reports `installing` and asks Chrome to install the chosen pack. That initial browser-managed download may need internet. Failed/unavailable packages become an error. |
| Whistle's WASM or model files are missing or unreachable | Worker initialization fails with a recoverable model error. The microphone has not been requested yet. The caller can retry after fixing connectivity or hosting paths. |
| Whistle worker crashes while capturing audio | Stop capture, release microphone/audio resources, emit a recoverable error, and require model preparation before another start. |
| Site is on `file://`, insecure HTTP, or microphone APIs are unavailable | Microphone setup fails with a secure-context or unsupported-capture message. Use HTTPS or `localhost`. |
| User denies microphone permission | Start rejects with `MICROPHONE_DENIED`; no capture stream is retained. Allow the site in browser permissions and retry. |
| No microphone, another app owns it, hardware is removed, or audio setup fails | Stop or release any acquired tracks, explain the recovery step, and leave the engine ready for another attempt. A track ending during capture stops the session. |
| User stops while the permission prompt is still open | Cancel the pending start. If the user later grants access, immediately stop the late-arriving stream instead of retaining it. |
| User starts twice quickly | Reuse one setup/start operation; never open two recognition sessions or microphone streams. |
| User starts while Whistle is flushing a previous session | Wait for the stop and final flush to finish before opening another microphone stream. |
| User stops twice while Whistle is flushing | Both calls await the same flush and resource cleanup. |
| Interim browser transcript changes | Replace `preview`; do not append each hypothesis. Commit text only when the browser marks a result final. |
| Browser recognition ends and restarts mid-session | Start a new result-index epoch, clear old interim preview, preserve finalized chunks, and avoid duplicate final chunks. |
| Whistle re-transcribes overlapping audio windows | The worker commits only stable word/time pairs. The API appends those chunks once. The live preview may overlap recently committed words, so render it separately. |
| Silence, noise, or uncertain words | Show no new final text until the engine returns a stable result. Do not invent words or switch engines. |
| User stops during Whistle capture | Flush the partial AudioWorklet chunk, send it to the worker, finalize its last rolling window, release microphone tracks and close the audio context. A timeout still releases the hardware even if the worker does not acknowledge. |
| User calls `stop()` during Whistle model loading | No microphone is active; `stop()` does not cancel model loading. Call `dispose()` or close the page to terminate the worker, or wait for preparation to succeed/fail before retrying. |
| Browser tab closes or reloads | Browser teardown releases media tracks. Transcript text is not stored by this package. |
| Transcript becomes very long | Retain up to `maxTranscriptCharacters` (250,000 by default). Drop oldest complete chunks first and set `truncated: true`; never split a word in the one remaining oversized chunk. |
| User changes engine or language | Create a new API instance after disposing the old one. The demo preserves visible transcript text across this switch. |
| User clears output while listening | Clear the transcript buffer and preview only. Capture continues, and later stable words form a new transcript. |
| Browser goes offline after Whistle model was cached | The demo shell and local model can load from the service worker cache. No recognition request reaches the network. |
| Browser goes offline before Whistle model was cached | Model preparation fails with a clear load error; the site cannot create a missing asset offline. |
| App is used from another origin | Chrome local can be imported as an ES module where allowed. Whistle's Worker and AudioWorklet files must be hosted on the consuming app's origin because browsers restrict cross-origin execution contexts. |
| Main thread is busy or tab is backgrounded | Audio work runs in an AudioWorklet and model decoding in a Worker; however, browser scheduling and microphone availability can still vary. Keep the tab open and inspect emitted `state`/`error` events if results stop. |

## Intentional boundaries

- This package outputs transcription text and stable chunks. It does not attempt to judge pronunciation, fluency, reading correctness, or speaker identity.
- The transcript is an ASR result, not guaranteed verbatim text. Consumers should let users review or correct it.
- The library holds text only in its current JavaScript instance. If the consuming app saves transcript events, that app owns the resulting storage and privacy behavior.
- Whistle's model supports English, German, French, Spanish, Italian, Dutch, and Polish. Other language claims need separate validation.
