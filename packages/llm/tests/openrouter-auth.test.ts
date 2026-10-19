/**
 * Signing in with OpenRouter: OAuth PKCE against a stand-in for its key
 * exchange, the browser played by a request to the loopback callback.
 */
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Context } from "cordis";
import { afterEach, expect, it, vi } from "vitest";
import { Settings } from "@tomradex/settings";
import { Llm, openRouterSignIn, type ModelsSettings } from "@tomradex/llm";
import type {} from "@tomradex/desktop-surface";

const realFetch = globalThis.fetch;
afterEach(() => vi.unstubAllGlobals());

const KEYS = "https://openrouter.ai/api/v1/auth/keys";
const sha = (v: string) => createHash("sha256").update(v).digest("base64url");

/** OpenRouter as far as this machine sees it: the key exchange, the listing and one chat answer; the loopback stays real. */
function openRouter() {
  const exchanged: Record<string, string>[] = [];
  let challenge = "";
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.startsWith("http://localhost")) return realFetch(url, init);
    if (href === KEYS) {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      exchanged.push(body);
      const ok = body.code === "the-code" && body.code_challenge_method === "S256" && sha(body.code_verifier!) === challenge;
      return ok ? new Response(JSON.stringify({ key: "sk-or-v1-person" })) : new Response('{"error":"Invalid code"}', { status: 403 });
    }
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== "Bearer sk-or-v1-person") return new Response('{"error":{"message":"No auth credentials found"}}', { status: 401 });
    if (href.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "anthropic/claude-sonnet-5" }, { id: "deepseek/deepseek-chat" }] }));
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  });
  /** The person's browser: approves on OpenRouter, which sends it back to the callback with a code. */
  const browser = (answer: (params: URLSearchParams) => Record<string, string> | null) => (href: string) => {
    const asked = new URL(href).searchParams;
    challenge = asked.get("code_challenge") ?? "";
    const back = answer(asked);
    if (!back) return;
    const callback = new URL(asked.get("callback_url")!);
    for (const [k, v] of Object.entries(back)) callback.searchParams.set(k, v);
    void realFetch(callback).catch(() => {});
  };
  return { exchanged, browser };
}

it("signs in with PKCE: S256, the state checked, the code exchanged for the person's key, and the callback closed after", async () => {
  const { exchanged, browser } = openRouter();
  let opened = new URLSearchParams();
  const approve = browser((asked) => ((opened = asked), { code: "the-code", state: asked.get("state")! }));
  expect(await openRouterSignIn({ open: approve, signal: AbortSignal.timeout(5_000) })).toEqual({ apiKey: "sk-or-v1-person" });
  expect(opened.get("code_challenge_method")).toBe("S256");
  expect(opened.get("callback_url")).toMatch(/^http:\/\/localhost:\d+\/callback$/);
  expect(opened.get("key_label")).toBe("Tomrade");
  expect(opened.get("state")).toMatch(/^[\w-]{20,}$/);
  expect(exchanged).toEqual([{ code: "the-code", code_verifier: expect.stringMatching(/^[\w-]{43}$/), code_challenge_method: "S256" }]);
  await expect(realFetch(opened.get("callback_url")!)).rejects.toThrow();
});

it("refuses an answer with another state, a denial and a refused exchange, saying which", async () => {
  const { browser } = openRouter();
  let callback = "";
  await expect(openRouterSignIn({ open: browser((asked) => ((callback = asked.get("callback_url")!), { code: "the-code", state: "forged" })), signal: AbortSignal.timeout(5_000) })).rejects.toThrow(/did not match/);
  await expect(realFetch(callback)).rejects.toThrow();
  await expect(openRouterSignIn({ open: browser(() => ({ error: "access_denied" })), signal: AbortSignal.timeout(5_000) })).rejects.toThrow(/did not grant access: access_denied/);
  await expect(openRouterSignIn({ open: browser((asked) => ({ code: "stale", state: asked.get("state")! })), signal: AbortSignal.timeout(5_000) })).rejects.toThrow(/refused the sign-in: 403/);
});

it("ends a sign-in the person never finishes, cancelled or timed out, and closes the callback", async () => {
  const { browser } = openRouter();
  let callback = "";
  const cancel = new AbortController();
  const waiting = openRouterSignIn({ open: browser((asked) => ((callback = asked.get("callback_url")!), null)), signal: cancel.signal });
  await vi.waitFor(() => expect(callback).not.toBe(""));
  cancel.abort();
  await expect(waiting).rejects.toThrow(/not finished/);
  await expect(realFetch(callback)).rejects.toThrow();
  await expect(openRouterSignIn({ open: browser(() => null), signal: AbortSignal.timeout(50) })).rejects.toThrow(/not finished/);
});

it("offers the sign-in on the OpenRouter provider, and the key it ends in connects a profile", async () => {
  const { browser } = openRouter();
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-openrouter-${Date.now()}-${Math.random()}.json`) });
  await ctx.plugin(Llm);
  const llm = ctx.llm as Llm;
  ctx.on("desktop/open-external", browser((asked) => ({ code: "the-code", state: asked.get("state")! })));
  expect(llm.modelProviders().find((p) => p.id === "openrouter")?.signIn).toBe("Sign in with OpenRouter");
  const signedIn = await llm.signIn("openrouter");
  expect(signedIn).toEqual({ ok: true, apiKey: "sk-or-v1-person" });
  expect(await llm.quickSetup({ preset: "openrouter", apiKey: signedIn.ok ? signedIn.apiKey : "" })).toEqual({ ok: true, profile: { id: "openrouter", title: "OpenRouter", model: "anthropic/claude-sonnet-5" } });
  expect((ctx.settings.get().models as ModelsSettings).profiles[0]).toMatchObject({ provider: "openrouter", apiKey: "sk-or-v1-person" });
});
