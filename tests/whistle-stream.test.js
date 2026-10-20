import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import "../src/lib/commitment-core.js";

function createWorker(transcripts) {
  const memory = new Uint8Array(32 * 1024 * 1024);
  const messages = [];
  const transcribeArguments = [];
  let nextPointer = 16;
  let transcriptIndex = 0;
  const engine = {
    HEAPU8: memory,
    _malloc(size) {
      const pointer = nextPointer;
      nextPointer += size + 16;
      return pointer;
    },
    _free() {},
    UTF8ToString(pointer, capacity) {
      const end = memory.indexOf(0, pointer);
      const limit = end < 0 ? pointer + capacity : end;
      return new TextDecoder().decode(memory.subarray(pointer, limit));
    },
    ccall(name, _returnType, _argTypes, args) {
      if (name === "needle_load") return 0;
      assert.equal(name, "needle_transcribe");
      transcribeArguments.push(args.slice());
      const transcript = transcripts[Math.min(transcriptIndex, transcripts.length - 1)];
      transcriptIndex += 1;
      const encoded = new TextEncoder().encode(JSON.stringify(transcript));
      memory.set(encoded, args[5]);
      memory[args[5] + encoded.length] = 0;
      return 1;
    },
  };
  const self = {
    location: { href: "chrome-extension://test-id/src/whistle-worker.js" },
    ReadAlongCommitment: globalThis.ReadAlongCommitment,
    async createNeedle() { return engine; },
    postMessage(message) { messages.push(message); },
  };
  const source = readFileSync(new URL("../src/whistle-worker.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    self,
    URL,
    Float32Array,
    ArrayBuffer,
    TextDecoder,
    importScripts() {},
    async fetch(url) {
      const size = String(url).endsWith("needle.wasm") ? 64 * 1024 : 1024 * 1024;
      return { ok: true, async arrayBuffer() { return new ArrayBuffer(size); } };
    },
  });
  return { self, messages, transcribeArguments };
}

function timedWords(words) {
  return words.map((word, index) => ({ word, start: 0.1 + index * 0.32, end: 0.28 + index * 0.32, probability: 0.96 }));
}

test("Whistle commits confirmed words in order as stable transcript chunks", async () => {
  const worker = createWorker([
    { text: "we open the book", words: timedWords(["we", "open", "the", "book"]) },
    { text: "we open the book slowly", words: timedWords(["we", "open", "the", "book", "slowly"]) },
    { text: "we open the book slowly together", words: timedWords(["we", "open", "the", "book", "slowly", "together"]) },
    { text: "we open the book slowly together again", words: timedWords(["we", "open", "the", "book", "slowly", "together", "again"]) },
  ]);

  await worker.self.onmessage({ data: { type: "INIT" } });
  await worker.self.onmessage({ data: { type: "AUDIO", samples: new Float32Array(32000).fill(0.1) } });
  await worker.self.onmessage({ data: { type: "AUDIO", samples: new Float32Array(16000).fill(0.1) } });
  await worker.self.onmessage({ data: { type: "AUDIO", samples: new Float32Array(16000).fill(0.1) } });
  await worker.self.onmessage({ data: { type: "AUDIO", samples: new Float32Array(16000).fill(0.1) } });

  const updates = worker.messages.filter((message) => message.type === "TRANSCRIPT");
  assert.deepEqual(Array.from(updates[1].committed, (word) => word.text), ["we", "open", "the", "book"]);
  assert.deepEqual(Array.from(updates[2].committed, (word) => word.text), ["slowly"]);
  assert.deepEqual(Array.from(updates[3].committed, (word) => word.text), ["together"]);
  assert.ok(worker.transcribeArguments.every((args) => args[4] === 1), "word timestamps must remain enabled in the local C API");

  const stableWords = updates.flatMap((update) => Array.from(update.committed, (word) => word.text));
  assert.deepEqual(stableWords, ["we", "open", "the", "book", "slowly", "together"]);
});

test("text-only timing estimates stay inside the rolling audio window", async () => {
  const transcript = { text: "one clear phrase keeps moving forward" };
  const worker = createWorker(Array.from({ length: 11 }, () => transcript));
  await worker.self.onmessage({ data: { type: "INIT" } });
  await worker.self.onmessage({ data: { type: "AUDIO", samples: new Float32Array(32000).fill(0.1) } });
  for (let second = 0; second < 10; second += 1) {
    await worker.self.onmessage({ data: { type: "AUDIO", samples: new Float32Array(16000).fill(0.1) } });
  }
  const updates = worker.messages.filter((message) => message.type === "TRANSCRIPT");
  assert.equal(updates.length, 11);
  assert.ok(Math.abs(updates.at(-1).committed.at(-1).end - 12) < 0.001);
});

test("a word list with missing or collapsed timestamps still commits the whole phrase", async () => {
  const transcript = {
    text: "we open the book",
    words: ["we", "open", "the", "book"].map((word) => ({ word, start: 0, end: 0, probability: 0.9 })),
  };
  const worker = createWorker([transcript, transcript]);
  await worker.self.onmessage({ data: { type: "INIT" } });
  await worker.self.onmessage({ data: { type: "AUDIO", samples: new Float32Array(32000).fill(0.1) } });
  await worker.self.onmessage({ data: { type: "AUDIO", samples: new Float32Array(16000).fill(0.1) } });

  const updates = worker.messages.filter((message) => message.type === "TRANSCRIPT");
  assert.deepEqual(Array.from(updates[1].committed, (word) => word.text), ["we", "open", "the", "book"]);
});
