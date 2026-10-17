import { expect, it } from "vitest";
import { z } from "zod";
import { OpenAiCompatible, collect, completeJson, listModels, pickModel, probe, PROVIDERS, userMessage } from "@tomradex/llm";

/** Opt-in: the Google Gemini preset against the real endpoint. TOMRADE_LIVE_GEMINI=1 GEMINI_API_KEY=… pnpm test */
it.skipIf(!process.env.TOMRADE_LIVE_GEMINI || !process.env.GEMINI_API_KEY)("the Gemini preset lists, chats, calls tools and answers JSON", async () => {
  const preset = PROVIDERS.find((p) => p.id === "gemini")!;
  const key = process.env.GEMINI_API_KEY!;
  const listing = await listModels(preset, key);
  expect(listing.ok).toBe(true);
  const model = pickModel(preset, listing.ok ? listing.models : null);
  expect(model).toMatch(/^models\/gemini-\d+(\.\d+)?-flash$/);
  const chat = new OpenAiCompatible({ baseURL: preset.baseURL, apiKey: key, model });
  expect(await probe(chat, 60_000)).toEqual({ ok: true });
  const out = await collect(chat.chat({ system: "Use the tool when asked.", messages: [userMessage("Call the add tool with a=2 and b=3.")], effort: "low",
    tools: [{ name: "add", description: "Adds two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } }] }));
  expect(out.toolCalls).toEqual([expect.objectContaining({ name: "add", args: { a: 2, b: 3 } })]);
  expect(out.usage?.inputTokens).toBeGreaterThan(0);
  expect(await completeJson(chat, z.object({ answer: z.string() }), { system: "Reply as JSON.", user: "Say ok in the answer field." })).toEqual({ answer: expect.stringMatching(/ok/i) });
}, 240_000);
