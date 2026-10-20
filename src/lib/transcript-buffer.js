const WORD_PATTERN = /[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*(?:[-‐‑‒–—][\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*)*/gu;
const MAX_REMEMBERED_CHUNK_IDS = 4096;

function cleanText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

/** Keeps final transcript chunks append-only while replacing volatile previews. */
export class TranscriptBuffer {
  constructor({ maxCharacters = 250_000 } = {}) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new RangeError("maxCharacters must be a positive integer.");
    }
    this.maxCharacters = maxCharacters;
    this.chunks = [];
    this.preview = "";
    this.currentEpoch = null;
    this.browserInterims = new Map();
    this.seenChunkIds = new Set();
    this.seenChunkOrder = new Array(MAX_REMEMBERED_CHUNK_IDS);
    this.seenChunkCount = 0;
    this.seenChunkCursor = 0;
    this.nextSequence = 1;
    this.truncated = false;
  }

  acceptBrowserRevision({ epoch, index, resultCount, text, isFinal = false, receivedAt = Date.now() } = {}) {
    const segmentIndex = Number(index);
    const safeEpoch = String(epoch ?? "0");
    const transcript = cleanText(text);

    if (this.currentEpoch !== safeEpoch) {
      this.currentEpoch = safeEpoch;
      this.browserInterims.clear();
    }
    const safeResultCount = Number(resultCount);
    if (Number.isInteger(safeResultCount) && safeResultCount >= 0) {
      for (const position of this.browserInterims.keys()) {
        if (position >= safeResultCount) this.browserInterims.delete(position);
      }
      this.preview = Array.from(this.browserInterims.entries())
        .sort(([a], [b]) => a - b)
        .map(([, value]) => value)
        .join(" ");
    }

    if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex > 100_000 || !transcript) return null;

    if (!isFinal) {
      if (this.seenChunkIds.has(`browser:${safeEpoch}:${segmentIndex}`)) return null;
      this.browserInterims.set(segmentIndex, transcript);
      this.preview = Array.from(this.browserInterims.entries())
        .sort(([a], [b]) => a - b)
        .map(([, value]) => value)
        .join(" ");
      return null;
    }

    const id = `browser:${safeEpoch}:${segmentIndex}`;
    if (!this.#rememberChunkId(id)) return null;
    this.browserInterims.delete(segmentIndex);
    const chunk = this.#appendChunk(transcript, { id, receivedAt, source: "browser" });
    this.preview = Array.from(this.browserInterims.entries())
      .sort(([a], [b]) => a - b)
      .map(([, value]) => value)
      .join(" ");
    return { chunk, interim: this.preview };
  }

  appendStableChunk(text, { id, receivedAt = Date.now(), source = "model" } = {}) {
    const transcript = cleanText(text);
    if (!transcript) return null;
    const chunkId = id === undefined ? `${source}:${this.nextSequence}` : String(id);
    if (!this.#rememberChunkId(chunkId)) return null;
    return this.#appendChunk(transcript, { id: chunkId, receivedAt, source });
  }

  setPreview(text) {
    this.preview = cleanText(text);
    return this.snapshot();
  }

  clear() {
    this.chunks = [];
    this.preview = "";
    this.currentEpoch = null;
    this.browserInterims.clear();
    this.seenChunkIds.clear();
    this.seenChunkOrder.fill(undefined);
    this.seenChunkCount = 0;
    this.seenChunkCursor = 0;
    this.nextSequence = 1;
    this.truncated = false;
    return this.snapshot();
  }

  snapshot() {
    const text = this.chunks.map((chunk) => chunk.text).join(" ");
    return {
      text,
      preview: this.preview,
      chunks: this.chunks.map((chunk) => ({ ...chunk })),
      wordCount: Array.from(text.matchAll(WORD_PATTERN)).length,
      truncated: this.truncated,
    };
  }

  #appendChunk(text, { id, receivedAt, source }) {
    const chunk = {
      id,
      sequence: this.nextSequence++,
      text,
      receivedAt: Number.isFinite(Number(receivedAt)) ? Number(receivedAt) : Date.now(),
      source,
    };
    this.chunks.push(chunk);
    this.#trimToLimit();
    return { ...chunk };
  }

  #trimToLimit() {
    let characters = this.chunks.reduce((sum, chunk) => sum + chunk.text.length + 1, 0);
    while (this.chunks.length > 1 && characters > this.maxCharacters) {
      const removed = this.chunks.shift();
      characters -= removed.text.length + 1;
      this.truncated = true;
    }
    const onlyChunk = this.chunks[0];
    if (onlyChunk && onlyChunk.text.length > this.maxCharacters) {
      const words = onlyChunk.text.split(/\s+/u);
      let shortened = "";
      for (let index = words.length - 1; index >= 0; index -= 1) {
        const candidate = shortened ? `${words[index]} ${shortened}` : words[index];
        if (candidate.length > this.maxCharacters) {
          if (shortened) break;
          continue;
        }
        shortened = candidate;
      }
      if (shortened) onlyChunk.text = shortened;
      else this.chunks.pop();
      this.truncated = true;
    }
  }

  #rememberChunkId(id) {
    if (this.seenChunkIds.has(id)) return false;
    this.seenChunkIds.add(id);

    if (this.seenChunkCount < MAX_REMEMBERED_CHUNK_IDS) {
      const position = (this.seenChunkCursor + this.seenChunkCount) % MAX_REMEMBERED_CHUNK_IDS;
      this.seenChunkOrder[position] = id;
      this.seenChunkCount += 1;
    } else {
      const expired = this.seenChunkOrder[this.seenChunkCursor];
      this.seenChunkIds.delete(expired);
      this.seenChunkOrder[this.seenChunkCursor] = id;
      this.seenChunkCursor = (this.seenChunkCursor + 1) % MAX_REMEMBERED_CHUNK_IDS;
    }
    return true;
  }
}
