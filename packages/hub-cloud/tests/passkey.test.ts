import { expect, it } from "vitest";
import { inBrowser } from "../src/passkey.js";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
type Payload = { v: number; kind: string; options: unknown; callback: string; state: string };
const payloadOf = (url: string) => JSON.parse(Buffer.from(new URL(url).hash.slice(1), "base64url").toString()) as Payload;

/** Stands in for the site's relay page: once opened, it answers with `reply(payload)`'s query. */
function browser(reply: (p: Payload) => Record<string, string>) {
  const seen: { url: string; status?: number }[] = [];
  return {
    seen,
    open(url: string) {
      const entry: { url: string; status?: number } = { url };
      seen.push(entry);
      const p = payloadOf(url);
      void fetch(`${p.callback}?${new URLSearchParams(reply(p))}`).then(r => { entry.status = r.status; });
    }
  };
}

it("opens the relay page with the options, and takes back the credential signed for that very request", async () => {
  const credential = { id: "cred-1", rawId: "cred-1", type: "public-key", response: { clientDataJSON: "x" }, clientExtensionResults: {} };
  const b = browser(p => ({ state: p.state, credential: b64(credential) }));
  const got = await inBrowser({ kind: "get", options: { challenge: "abc" }, page: "https://tomrade.com/zh/auth/passkey/", open: b.open, signal: new AbortController().signal });
  expect(got).toEqual(credential);
  const opened = new URL(b.seen[0].url);
  expect(opened.origin + opened.pathname).toBe("https://tomrade.com/zh/auth/passkey/");
  // Only in the fragment, which the browser never sends to the site.
  expect(opened.search).toBe("");
  const p = payloadOf(b.seen[0].url);
  expect(p).toMatchObject({ v: 1, kind: "get", options: { challenge: "abc" } });
  expect(p.callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/passkey$/);
});

it("ignores an answer without the request's state, and stops listening once the ceremony ends", async () => {
  const controller = new AbortController();
  let callback = "";
  let stray = 0;
  const pending = inBrowser({
    kind: "create", options: {}, page: "https://tomrade.com/auth/passkey/", signal: controller.signal,
    open: url => { callback = payloadOf(url).callback; }
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  stray = (await fetch(`${callback}?state=guess&credential=${b64({ id: "evil" })}`)).status;
  controller.abort();
  await expect(pending).rejects.toThrow(/^\[passkey_cancelled\]/);
  expect(stray).toBe(404);
  await expect(fetch(callback)).rejects.toThrow();
});

it("tells a passkey the person dismissed from one the browser could not use, and from one not used in time", async () => {
  const page = "https://tomrade.com/auth/passkey/";
  const signal = new AbortController().signal;
  await expect(inBrowser({ kind: "get", options: {}, page, signal, open: browser(p => ({ state: p.state, error: "NotAllowedError" })).open })).rejects.toThrow(/^\[passkey_cancelled\]/);
  await expect(inBrowser({ kind: "get", options: {}, page, signal, open: browser(p => ({ state: p.state, error: "SecurityError" })).open })).rejects.toThrow(/^\[passkey_failed\].*SecurityError/);
  await expect(inBrowser({ kind: "get", options: {}, page, signal, open: browser(p => ({ state: p.state, credential: "not json" })).open })).rejects.toThrow(/^\[passkey_failed\]/);
  await expect(inBrowser({ kind: "get", options: {}, page, signal: AbortSignal.timeout(20), open() {} })).rejects.toThrow(/^\[passkey_timeout\]/);
});
