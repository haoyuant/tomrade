import type { ChatEvent, ChatModel, ChatRequest } from "./model.js";
import { LlmError } from "./errors.js";

/** GPT Image and compatible Images APIs: generation and multi-turn reference edits. */
export class ImagesModel implements ChatModel {
  capabilities = { tools: false, streaming: false, json: false, mediaInput: ["image/png", "image/jpeg", "image/webp"], mediaOutput: ["image"] };
  constructor(private readonly config: { baseURL: string; apiKey: string; model: string }) {}

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const users = request.messages.filter(message => message.role === "user");
    const latest = users.at(-1);
    const prompt = latest?.content.filter(block => block.type === "text").map(block => block.text).join("\n") || "Create an image using the supplied references.";
    // Current attachments take precedence; otherwise the most recent displayed image is the reference.
    const currentImages = latest?.content.filter(block => block.type === "media") ?? [];
    const previousImages = users.slice(0, -1).flatMap(message => message.content.filter(block => block.type === "media")).slice(-1);
    const images = currentImages.length ? currentImages : previousImages;
    for (const { media } of images) if (!this.capabilities.mediaInput.includes(media.mime)) throw new LlmError(`Image editing does not support ${media.mime}`);
    let body: string | FormData;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.config.apiKey}` };
    if (images.length) {
      const form = new FormData();
      form.set("model", this.config.model); form.set("prompt", prompt); form.set("n", "1");
      for (const { media } of images) form.append("image[]", new Blob([Buffer.from(media.base64, "base64")], { type: media.mime }), media.name);
      body = form;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ model: this.config.model, prompt, n: 1 });
    }
    const response = await fetch(`${this.config.baseURL.replace(/\/$/, "")}/images/${images.length ? "edits" : "generations"}`, { method: "POST", headers, body, signal });
    if (!response.ok) throw new LlmError(`Image request failed ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const result = await response.json() as { data?: { b64_json?: string; revised_prompt?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    if (!result.data?.length) throw new LlmError("Image endpoint returned no image");
    for (const [index, image] of result.data.entries()) {
      if (!image.b64_json) throw new LlmError("This image endpoint must return base64 image bytes");
      yield { type: "media", media: { name: `generated-${index + 1}.png`, mime: "image/png", base64: image.b64_json } };
    }
    if (result.usage) yield { type: "usage", inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens };
    yield { type: "stop", reason: "end" };
  }
}
