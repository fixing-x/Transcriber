import test from "node:test";
import assert from "node:assert/strict";
import "../src/lib/commitment-core.js";

const { stablePairs } = globalThis.ReadAlongCommitment;

function pass(words, starts = words.map((_, index) => index * 0.35)) {
  return { words: words.map((text, index) => ({ text, normalized: text.toLowerCase(), start: starts[index] })) };
}

test("commits only words present in two consecutive passes despite one inserted word", () => {
  const previous = pass(["we", "read", "the", "quiet", "text"]);
  const current = pass(["we", "read", "a", "the", "quiet", "text"]);
  assert.deepEqual(stablePairs(previous, current), [[0, 0], [1, 1], [2, 3], [3, 4], [4, 5]]);
});

test("holds a revised word until the next pass confirms the replacement", () => {
  const first = pass(["the", "book", "opens", "slowly"]);
  const second = pass(["the", "look", "opens", "slowly"]);
  assert.deepEqual(stablePairs(first, second), [[0, 0], [2, 2], [3, 3]]);
  const third = pass(["the", "look", "opens", "slowly"]);
  assert.deepEqual(stablePairs(second, third), [[0, 0], [1, 1], [2, 2], [3, 3]]);
});

test("timestamp drift outside the rolling overlap does not stabilize stale words", () => {
  const previous = pass(["the", "river", "moves"], [0, 1, 2]);
  const current = pass(["the", "river", "moves"], [2.1, 3.1, 4.1]);
  assert.deepEqual(stablePairs(previous, current), []);
});

test("duplicate words can stabilize when their sequence and timestamps agree", () => {
  const previous = pass(["very", "very", "quiet", "night"], [0, 0.25, 0.5, 0.8]);
  const current = pass(["very", "quiet", "very", "quiet", "night"], [0, 0.5, 0.7, 1, 1.3]);
  assert.deepEqual(stablePairs(previous, current), [[0, 0], [1, 2], [2, 3], [3, 4]]);
});
