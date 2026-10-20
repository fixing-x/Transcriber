import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("Whistle worker supplies the bundled WASM bytes instead of resolving src/needle.wasm", async () => {
  const fetches = [];
  const messages = [];
  let suppliedWasm;
  const memory = new Uint8Array(2 * 1024 * 1024);
  const module = {
    HEAPU8: memory,
    _malloc: () => 8,
    _free: () => {},
    ccall: () => 0,
  };
  const self = {
    location: { href: "https://reader.example/Reader/src/whistle-worker.js" },
    ReadAlongCommitment: { stablePairs: () => [] },
    async createNeedle(options) {
      suppliedWasm = options.wasmBinary;
      return module;
    },
    postMessage(message) { messages.push(message); },
  };

  vm.runInNewContext(readFileSync(new URL("../src/whistle-worker.js", import.meta.url), "utf8"), {
    self,
    URL,
    importScripts() {},
    async fetch(url) {
      fetches.push(String(url));
      const size = String(url).endsWith("needle.wasm") ? 64 * 1024 : 1024 * 1024;
      return { ok: true, async arrayBuffer() { return new ArrayBuffer(size); } };
    },
  });

  await self.onmessage({ data: { type: "INIT" } });

  assert.ok(fetches.includes("https://reader.example/Reader/vendor/cactus/needle.wasm"));
  assert.ok(fetches.includes("https://reader.example/Reader/vendor/cactus/whistle.cact"));
  assert.ok(!fetches.includes("https://reader.example/Reader/src/needle.wasm"));
  assert.ok(suppliedWasm instanceof ArrayBuffer);
  assert.ok(Array.from(new Uint8Array(suppliedWasm)).every((byte) => byte === 0));
  assert.deepEqual(messages.map((message) => message.type), ["READY"]);
});
