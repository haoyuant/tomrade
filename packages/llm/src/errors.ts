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
