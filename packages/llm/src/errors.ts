import { modalityOf, type ChatRequest, type InputModality } from "./model.js";

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

/** The model is not at fault: the caller's time ran out, or it answered something that does not fit. Asking another source would not help. */
export class NotAModelFailure extends LlmError {
  constructor(message: string) {
    super(message);
    this.name = "NotAModelFailure";
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

/** The provider turned down media the model cannot read; the caller goes on without those kinds, and the profile stops offering them. */
export class MediaRefused extends LlmError {
  constructor(message: string, public readonly kinds: InputModality[], cause?: unknown, response?: LlmErrorResponse) {
    super(message, cause, response);
    this.name = "MediaRefused";
  }
}

const NAMES: Record<InputModality, RegExp> = { image: /image|vision/i, pdf: /pdf|document|(^|[^a-z])file/i, audio: /audio/i, video: /video/i };
const POINTS_AT_MEDIA = /image|vision|pdf|document|(^|[^a-z])file|audio|video|multimodal|modalit|content[ _-]?type|input[ _-]?type/i;
// A picture too big or broken is that file's problem, not the model's: it is not remembered against the model.
const NOT_THE_KIND = /too (large|big|long)|exceeds|maximum|size|could not (process|decode)|invalid base64|corrupt/i;

/**
 * The kinds of media a 400/422 refused, or null when it is about something else. Only kinds the
 * request carried count; a message that names none of them refuses them all.
 */
export function mediaRefusal(status: number, text: string, request: ChatRequest): InputModality[] | null {
  if (status !== 400 && status !== 422) return null;
  const carried = [...new Set(request.messages.flatMap((m) => m.content.flatMap((b) => (b.type === "media" ? [modalityOf(b.media.mime)] : []))))].filter((k): k is InputModality => !!k);
  if (!carried.length || !POINTS_AT_MEDIA.test(text) || NOT_THE_KIND.test(text)) return null;
  // serde's "unknown variant `file`, expected `text` or `image_url`" refuses only the first.
  const subject = /unknown variant [`'"]?([\w-]+)/i.exec(text)?.[1] ?? text;
  const named = carried.filter((kind) => NAMES[kind].test(subject));
  return named.length ? named : carried;
}
