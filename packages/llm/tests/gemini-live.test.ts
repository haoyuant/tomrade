import { expect, it } from "vitest";
import { z } from "zod";
import { GEMINI, assistantMessage, collect, completeJson, pickModel, probe, toolResultsMessage, userMessage } from "@tomradex/llm";

/**
 * Opt-in: the Gemini provider against Google's own API. TOMRADE_LIVE_GEMINI=1 GEMINI_API_KEY=… pnpm test
 * GEMINI_LIVE_MODEL picks a model when the preferred flash is busy; GEMINI_LIVE_SEARCH=1 also searches (a paid key).
 */
it.skipIf(!process.env.TOMRADE_LIVE_GEMINI || !process.env.GEMINI_API_KEY)("the Gemini provider lists, chats, calls tools across steps and answers JSON", async () => {
  const key = process.env.GEMINI_API_KEY!;
  const listing = await GEMINI.list({ apiKey: key });
  expect(listing.ok).toBe(true);
  const models = listing.ok ? GEMINI.usable(listing.models ?? []) : [];
  const preferred = pickModel(GEMINI.presets[0]!, models);
  expect(preferred).toMatch(/^gemini-\d+(\.\d+)?-flash$/);
  const chat = GEMINI.build({ id: "live", title: "", provider: "gemini", apiKey: key, model: process.env.GEMINI_LIVE_MODEL ?? preferred });
  expect(await probe(chat, 60_000)).toEqual({ ok: true });

  const tools = [{ name: "add", description: "Adds two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } }];
  const asked = userMessage("Call the add tool with a=2 and b=3, then say the sum.");
  const step = await collect(chat.chat({ system: "Use the tool when asked.", messages: [asked], effort: "low", tools }));
  expect(step.toolCalls).toEqual([expect.objectContaining({ name: "add", args: { a: 2, b: 3 } })]);
  expect(step.usage.inputTokens).toBeGreaterThan(0);
  // the call goes back with its signature; Gemini 3 refuses it otherwise
  const answer = await collect(chat.chat({ system: "Use the tool when asked.", messages: [asked, assistantMessage(step), toolResultsMessage(step.toolCalls.map((c) => ({ id: c.id, content: "5" })))], effort: "low", tools }));
  expect(answer.text).toMatch(/5/);

  expect(await completeJson(chat, z.object({ answer: z.string() }), { system: "Reply as JSON.", user: "Say ok in the answer field." })).toEqual({ answer: expect.stringMatching(/ok/i) });
  if (process.env.GEMINI_LIVE_SEARCH) {
    const found = await collect(chat.chat({ system: "Be brief; cite sources.", messages: [userMessage("What did DeepSeek announce about its Search API?")], webSearch: true, tools }));
    expect(found.text).toMatch(/https?:\/\//);
  }
}, 240_000);
