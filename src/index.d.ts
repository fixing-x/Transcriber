export type SpeechEngine = "chrome-local" | "whistle-local";
export type TranscriberState =
  | "idle"
  | "checking"
  | "installing"
  | "loading"
  | "requesting"
  | "listening"
  | "reconnecting"
  | "stopping"
  | "ready"
  | "error"
  | "disposed";

export interface TranscriberOptions {
  engine?: SpeechEngine;
  /** BCP 47 language tag used by the Chrome local engine. Whistle detects its supported languages automatically. */
  language?: string;
  /** Overrides browser APIs for testing. */
  api?: typeof globalThis;
  /** Maximum retained final transcript size. Old complete chunks roll off beyond this limit. */
  maxTranscriptCharacters?: number;
  /** Advanced test hook for the local Web Worker. */
  workerFactory?: (url: URL, options: WorkerOptions) => Worker;
}

export interface TranscriptChunk {
  id: string;
  sequence: number;
  text: string;
  receivedAt: number;
  source: "browser" | "whistle" | string;
  engine?: SpeechEngine;
  isFinal?: boolean;
}

export interface TranscriptSnapshot {
  text: string;
  /** The replaceable current hypothesis. For Whistle this may overlap recent final words in its rolling window. */
  preview: string;
  chunks: TranscriptChunk[];
  wordCount: number;
  truncated: boolean;
  engine?: SpeechEngine;
  isFinal?: boolean;
  receivedAt?: number;
  confidence?: number | null;
}

export interface TranscriberStateEvent {
  state: TranscriberState;
  detail: string;
  engine: SpeechEngine;
  receivedAt: number;
}

export interface TranscriberErrorEvent {
  code: string;
  message: string;
  recoverable: boolean;
  engine: SpeechEngine;
  cause?: unknown;
  receivedAt: number;
}

export const SPEECH_ENGINES: readonly SpeechEngine[];

export class TranscriptionError extends Error {
  code: string;
  recoverable: boolean;
}

export class TranscriptBuffer {
  constructor(options?: { maxCharacters?: number });
  acceptBrowserRevision(revision: {
    epoch?: string | number;
    index: number;
    resultCount?: number;
    text: string;
    isFinal?: boolean;
    metadataOnly?: boolean;
    receivedAt?: number;
  }): { chunk: TranscriptChunk; interim: string } | null;
  appendStableChunk(text: string, options?: { id?: string; receivedAt?: number; source?: string }): TranscriptChunk | null;
  setPreview(text: string): TranscriptSnapshot;
  snapshot(): TranscriptSnapshot;
  clear(): TranscriptSnapshot;
}

export class StreamingResampler {
  constructor(inputRate: number, outputRate?: number);
  process(inputChannels: ArrayLike<Float32Array>): Float32Array;
}

export interface LocalTranscriber {
  readonly engine: SpeechEngine;
  readonly language: string;
  readonly state: TranscriberState;
  prepare(): Promise<{ status: "ready"; engine: SpeechEngine; language: string }>;
  start(): Promise<{ status: "started" | "cancelled"; alreadyListening?: boolean }>;
  stop(): Promise<{ status: "stopped" | "disposed" }>;
  clear(): TranscriptSnapshot;
  getSnapshot(): TranscriptSnapshot;
  on(type: "state", listener: (event: TranscriberStateEvent) => void): () => void;
  on(type: "transcript", listener: (event: TranscriptSnapshot) => void): () => void;
  on(type: "chunk", listener: (event: TranscriptChunk) => void): () => void;
  on(type: "error", listener: (event: TranscriberErrorEvent) => void): () => void;
  dispose(): Promise<void>;
}

export function createTranscriber(options?: TranscriberOptions): LocalTranscriber;
