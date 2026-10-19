/**
 * A provider that refuses media the model cannot read says so as MediaRefused, naming the kind,
 * on chat/completions, /responses and Anthropic alike; any other 400 fails as before. The service
 * remembers the refusal for the profile's model, across restarts, until the profile's model changes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "cordis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Db } from "@tomradex/db";
import { Settings } from "@tomradex/settings";
import { AnthropicModel, Llm, MediaRefused, NativeSearchRefused, OpenAiCompatible, collect, type ChatRequest, type ModelProfile } from "@tomradex/llm";

afterEach(() => vi.unstubAllGlobals());

const png = { mime: "image/png", name: "shot.png", base64: "aGVsbG8=" };
const pdf = { mime: "application/pdf", name: "spec.pdf", base64: "aGVsbG8=" };
const ask = (media = [png, pdf], overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  system: "s",
  messages: [{ role: "user", content: [{ type: "text", text: "read these" }, ...media.map((m) => ({ type: "media" as const, media: m }))] }],
  ...overrides
});
const refuse = (status: number, message: string) => () => new Response(JSON.stringify({ error: { type: "invalid_request_error", message } }), { status, headers: { "content-type": "application/json" } });
const serve = (...replies: (() => Response)[]) => vi.stubGlobal("fetch", vi.fn(async () => (replies.shift() ?? (() => { throw new Error("no reply scripted"); }))()));
const refusedKinds = async (run: Promise<unknown>) => {
  const err = await run.then(() => null, (e: unknown) => e);
  return err instanceof MediaRefused ? err.kinds : err;
};

const openai = (model = "gpt-5.5") => new OpenAiCompatible({ baseURL: "https://api.openai.com/v1", apiKey: "k", model, inputModalities: ["image", "pdf"], retries: 0 });
const deepseek = () => new OpenAiCompatible({ baseURL: "https://api.deepseek.com", apiKey: "k", model: "deepseek-flash", inputModalities: ["image", "pdf", "audio", "video"], retries: 0 });
const claude = () => new AnthropicModel({ apiKey: "k", model: "claude-haiku-3", baseURL: "http://localhost", webSearch: false });

describe("recognising a media refusal", () => {
  it("names the kind the message points at, on chat/completions", async () => {
    serve(
      refuse(400, "Failed to deserialize the JSON body into the target type: messages[1]: unknown variant `file`, expected `text` or `image_url`"),
      refuse(422, "unknown variant `input_audio`, expected `text`"),
      refuse(400, "Multimodal input is not supported by this model")
    );
    expect(await refusedKinds(collect(deepseek().chat(ask())))).toEqual(["pdf"]);
    expect(await refusedKinds(collect(deepseek().chat(ask([png, { ...pdf, mime: "audio/wav", name: "a.wav" }]))))).toEqual(["audio"]);
    // A refusal that names no kind it carried refuses them all.
    expect(await refusedKinds(collect(deepseek().chat(ask())))).toEqual(["image", "pdf"]);
  });

  it("is told apart from a search refusal on /responses", async () => {
    serve(refuse(400, "Invalid content type. image_url is only supported by certain models."), refuse(400, "Tool web_search is not supported with this model."));
    expect(await refusedKinds(collect(openai().chat(ask([png], { webSearch: true }))))).toEqual(["image"]);
    await expect(collect(openai().chat(ask([png], { webSearch: true })))).rejects.toBeInstanceOf(NativeSearchRefused);
  });

  it("names the kind Claude refused", async () => {
    serve(refuse(400, "claude-haiku-3 does not support PDF input."));
    expect(await refusedKinds(collect(claude().chat(ask())))).toEqual(["pdf"]);
  });

  it("leaves every other 400 a plain failure", async () => {
    serve(
      refuse(400, "max_tokens is too large: 900000. This model supports at most 8192 completion tokens"),
      refuse(400, "messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 6000000 bytes > 5242880 bytes"),
      refuse(400, "Invalid content type for image_url"),
      refuse(500, "unknown variant `image_url`")
    );
    for (const run of [
      () => collect(deepseek().chat(ask())),
      () => collect(claude().chat(ask())),
      // the request carried no media: the message cannot be about it
      () => collect(deepseek().chat(ask([]))),
      () => collect(deepseek().chat(ask()))
    ]) {
      const err = await run().then(() => null, (e: unknown) => e);
      // Claude's other refusals stay the SDK's own errors
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(MediaRefused);
    }
  });
});

describe("remembering a media refusal", () => {
  const profile: ModelProfile = { id: "ds", title: "DeepSeek", provider: "openai-compatible", baseURL: "https://api.deepseek.com", apiKey: "k", model: "deepseek-flash", inputModalities: ["image", "pdf"] };

  async function start(root: string) {
    const ctx = new Context();
    await ctx.plugin(Db, { dir: path.join(root, "cache") });
    await ctx.plugin(Settings, { path: path.join(root, "settings.json") });
    await ctx.plugin(Llm);
    return ctx;
  }
  const setProfile = (ctx: Context, next: ModelProfile) => {
    const all = ctx.settings.get();
    ctx.settings.set({ ...all, models: { profiles: [next], roles: { worker: "" } } });
  };

  it("stops offering the refused kind for that profile's model, across a restart, until its model changes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-refused-media-"));
    try {
      let ctx = await start(root);
      setProfile(ctx, profile);
      expect(ctx.llm.forProfile("ds").capabilities.mediaInput).toContain("application/pdf");
      serve(refuse(400, "unknown variant `file`, expected `text` or `image_url`"));
      await expect(collect(ctx.llm.forProfile("ds").chat(ask()))).rejects.toBeInstanceOf(MediaRefused);
      expect(ctx.llm.forProfile("ds").capabilities.mediaInput).toEqual(["image/png", "image/jpeg", "image/webp", "image/gif"]);
      await ctx.fiber.dispose();

      ctx = await start(root);
      expect(ctx.llm.forProfile("ds").capabilities.mediaInput).not.toContain("application/pdf");
      expect(ctx.llm.forProfile("ds").capabilities.mediaInput).toContain("image/png");

      setProfile(ctx, { ...profile, model: "deepseek-v4-pro" });
      expect(ctx.llm.forProfile("ds").capabilities.mediaInput).toContain("application/pdf");
      await ctx.fiber.dispose();

      // cleared for good, not only hidden behind the other model
      ctx = await start(root);
      setProfile(ctx, profile);
      expect(ctx.llm.forProfile("ds").capabilities.mediaInput).toContain("application/pdf");
      await ctx.fiber.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
