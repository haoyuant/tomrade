/** What the server answered a failed request with, kept whole for the error's details. */
export interface LlmErrorResponse {
  status: number;
  url: string;
  requestId?: string;
  body: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly response?: LlmErrorResponse
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** The provider turned down its own web search (the model, the account or the endpoint); the caller searches another way. */
export class NativeSearchRefused extends LlmError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "NativeSearchRefused";
  }
}

/** The provider turned down a request for media output (`modalities`); the caller makes it another way. */
export class NativeMediaRefused extends LlmError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "NativeMediaRefused";
  }
}
