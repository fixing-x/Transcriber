import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptBuffer } from "../src/lib/transcript-buffer.js";

test("interim browser revisions replace the preview and final text is committed once", () => {
  const buffer = new TranscriptBuffer();

  buffer.acceptBrowserRevision({ epoch: 1, index: 0, text: "we are", isFinal: false });
  assert.deepEqual(buffer.snapshot(), {
    text: "",
    preview: "we are",
    chunks: [],
    wordCount: 0,
    truncated: false,
  });

  const committed = buffer.acceptBrowserRevision({ epoch: 1, index: 0, text: "we are reading", isFinal: true });
  buffer.acceptBrowserRevision({ epoch: 1, index: 0, text: "we are reading", isFinal: true });

  assert.equal(committed.chunk.text, "we are reading");
  assert.equal(buffer.snapshot().text, "we are reading");
  assert.equal(buffer.snapshot().preview, "");
  assert.equal(buffer.snapshot().chunks.length, 1);
});

test("a browser recognition restart clears its interim preview without losing finalized text", () => {
  const buffer = new TranscriptBuffer();
  buffer.acceptBrowserRevision({ epoch: 1, index: 0, text: "first phrase", isFinal: true });
  buffer.acceptBrowserRevision({ epoch: 1, index: 1, text: "unfinished", isFinal: false });
  buffer.acceptBrowserRevision({ epoch: 2, index: 0, text: "second phrase", isFinal: false });

  assert.equal(buffer.snapshot().text, "first phrase");
  assert.equal(buffer.snapshot().preview, "second phrase");
});

test("a shortened browser result list drops stale interim hypotheses", () => {
  const buffer = new TranscriptBuffer();
  buffer.acceptBrowserRevision({ epoch: 1, index: 1, resultCount: 2, text: "stale tail", isFinal: false });
  assert.equal(buffer.snapshot().preview, "stale tail");

  buffer.acceptBrowserRevision({ epoch: 1, index: -1, resultCount: 1, text: "", metadataOnly: true });

  assert.equal(buffer.snapshot().preview, "");
});

test("stable model chunks are idempotent and old complete chunks roll off the memory limit", () => {
  const buffer = new TranscriptBuffer({ maxCharacters: 12 });
  buffer.appendStableChunk("one two", { id: "one" });
  buffer.appendStableChunk("one two", { id: "one" });
  buffer.appendStableChunk("three four", { id: "two" });

  assert.equal(buffer.snapshot().text, "three four");
  assert.equal(buffer.snapshot().truncated, true);
  assert.deepEqual(buffer.snapshot().chunks.map((chunk) => chunk.id), ["two"]);
});

test("an oversized single chunk keeps its newest whole words and never retains an empty row", () => {
  const buffer = new TranscriptBuffer({ maxCharacters: 10 });
  buffer.appendStableChunk("extraordinary short tail", { id: "large" });

  assert.equal(buffer.snapshot().text, "short tail");
  assert.equal(buffer.snapshot().truncated, true);

  const olderWord = new TranscriptBuffer({ maxCharacters: 6 });
  olderWord.appendStableChunk("newer extraordinary", { id: "tail-word-too-large" });
  assert.equal(olderWord.snapshot().text, "newer");

  const tiny = new TranscriptBuffer({ maxCharacters: 3 });
  tiny.appendStableChunk("extraordinary", { id: "too-large" });
  assert.deepEqual(tiny.snapshot().chunks, []);
  assert.equal(tiny.snapshot().text, "");
});

test("duplicate protection stays bounded during a long session", () => {
  const buffer = new TranscriptBuffer({ maxCharacters: 1 });
  for (let index = 0; index < 5000; index += 1) {
    buffer.appendStableChunk("x", { id: `chunk-${index}` });
  }

  assert.ok(buffer.seenChunkIds.size <= 4096);
  assert.equal(buffer.appendStableChunk("x", { id: "chunk-4999" }), null);
});
