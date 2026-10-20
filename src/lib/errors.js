export class TranscriptionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "TranscriptionError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
  }
}
