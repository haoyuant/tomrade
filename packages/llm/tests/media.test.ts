import { afterEach, expect, it, vi } from "vitest";
import { AnthropicModel, OpenAiCompatible, ImagesModel, collect } from "@tomrade/llm";

afterEach(() => vi.unstubAllGlobals());
const media = { mime: "image/png", name: "input.png", base64: "aGVsbG8=" };
const request = { system: "s", messages: [{ role: "user" as const, content: [{ type: "media" as const, media }] }] };
it("uses the Images API for image models and multipart editing for reference images", async () => {
  const fetcher = vi.fn(async () => Response.json({ data: [{ b64_json: "YWJj" }], usage: { input_tokens: 2, output_tokens: 3 } }));
  vi.stubGlobal("fetch", fetcher);
  const model = new ImagesModel({ baseURL: "http://localhost/v1", apiKey: "test", model: "gpt-image-test" });
  expect((await collect(model.chat({ system: "s", messages: [{ role: "user", content: [{ type: "text", text: "A mountain" }] }] }))).media).toEqual([{ name: "generated-1.png", mime: "image/png", base64: "YWJj" }]);
  const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
  expect(calls[0][0]).toBe("http://localhost/v1/images/generations");
  expect(JSON.parse(calls[0][1].body as string).prompt).toBe("A mountain");
  await collect(model.chat(request));
  expect(calls[1][0]).toBe("http://localhost/v1/images/edits");
  expect((calls[1][1].body as FormData).get("image[]")).toBeInstanceOf(Blob);
});
function sse(chunks: unknown[]) {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}

it("sends image-only input and collects native image output without losing bytes", async () => {
  const fetcher = vi.fn(async () => sse([
    { choices: [{ delta: { content: "Here it is", images: [{ image_url: { url: "data:image/png;base64,aGVsbG8=" } }] } }] },
    { choices: [{ delta: { images: [{ image_url: { url: "data:image/png;base64,aGVsbG8=" } }] }, finish_reason: "stop" }] }
  ]));
  vi.stubGlobal("fetch", fetcher);
  const model = new OpenAiCompatible({ baseURL: "http://localhost/v1", apiKey: "test", model: "vision", inputModalities: ["image"], outputModalities: ["image"] });
  const result = await collect(model.chat(request));
  const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(body.modalities).toEqual(["text", "image"]);
  expect(body.messages[1]).toEqual({ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }] });
  expect(result.text).toBe("Here it is");
  expect(result.media).toHaveLength(1);
  expect(result.media![0]).toMatchObject({ mime: "image/png", base64: media.base64 });
});

it("rejects unsupported input before contacting a text-only endpoint", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const model = new OpenAiCompatible({ baseURL: "http://localhost/v1", apiKey: "", model: "text-only" });
  await expect(collect(model.chat(request))).rejects.toThrow("does not accept image/png");
  expect(fetcher).not.toHaveBeenCalled();
});

it("serializes PDF/audio/video inputs and wraps streamed PCM in a playable WAV", async () => {
  const fetcher = vi.fn(async () => sse([{ choices: [{ delta: { audio: { data: "AQACAAMA", transcript: "Hello" } } }] }]));
  vi.stubGlobal("fetch", fetcher);
  const model = new OpenAiCompatible({ baseURL: "http://localhost/v1", apiKey: "", model: "multi", inputModalities: ["pdf", "audio", "video"], outputModalities: ["audio"] });
  const result = await collect(model.chat({ system: "s", messages: [{ role: "user", content: ["application/pdf", "audio/wav", "video/mp4"].map(mime => ({ type: "media", media: { ...media, mime } })) }] }));
  const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(body.messages[1].content.map((part: { type: string }) => part.type)).toEqual(["file", "input_audio", "video_url"]);
  expect(body.audio.format).toBe("pcm16");
  const bytes = Buffer.from(result.media![0].base64, "base64");
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.subarray(44)).toEqual(Buffer.from("AQACAAMA", "base64"));
  expect(result.text).toBe("Hello");
});

it("passes image and PDF blocks to the actual Anthropic SDK", async () => {
  const fetcher = vi.fn(async () => new Response([
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ].join(""), { headers: { "Content-Type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetcher);
  const model = new AnthropicModel({ baseURL: "http://localhost", apiKey: "test", model: "vision" });
  await collect(model.chat({ system: "s", messages: [{ role: "user", content: [{ type: "media", media }, { type: "media", media: { ...media, mime: "application/pdf" } }] }] }));
  const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(body.messages[0].content.map((part: { type: string }) => part.type)).toEqual(["image", "document"]);
  expect(body.messages[0].content[0].source).toEqual({ type: "base64", media_type: "image/png", data: media.base64 });
});
