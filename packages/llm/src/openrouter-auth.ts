import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface OpenRouterSignIn {
  open(url: string): void;
  signal: AbortSignal;
  /** Stand-ins for tests. */
  authURL?: string;
  keysURL?: string;
}

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

const PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Tomrade</title><body style="font:15px system-ui;margin:3em;color:#222"><p>${message}</p>`;

/** Listens on loopback only, both families when it can, so the browser's "localhost" finds it whichever it tries first. */
async function loopback(handler: http.RequestListener): Promise<{ port: number; close(): void }> {
  const v4 = http.createServer(handler);
  await new Promise<void>((resolve, reject) => v4.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = v4.address() as AddressInfo;
  const v6 = http.createServer(handler);
  const six = await new Promise<boolean>((resolve) => v6.once("error", () => resolve(false)).listen(port, "::1", () => resolve(true)));
  return {
    port,
    close: () => {
      v4.close();
      v4.closeAllConnections();
      if (six) {
        v6.close();
        v6.closeAllConnections();
      }
    }
  };
}

/**
 * OpenRouter's OAuth PKCE: the person approves in the browser, OpenRouter
 * sends a code to a server on this machine for as long as the sign-in takes,
 * and the code with its verifier becomes a key the person controls on
 * openrouter.ai/keys. The server is closed however the sign-in ends.
 */
export async function openRouterSignIn(opts: OpenRouterSignIn): Promise<{ apiKey: string }> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  // awaited below; a refusal before then is not an unhandled one
  code.catch(() => {});
  const server = await loopback((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/callback") return void res.writeHead(404).end();
    const reply = (status: number, message: string) => res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(PAGE(message));
    const got = url.searchParams.get("code");
    if (!got) {
      reply(400, "OpenRouter did not sign you in. You can close this tab and try again in Tomrade.");
      return settle.reject(new Error(`OpenRouter did not grant access${url.searchParams.get("error") ? `: ${url.searchParams.get("error")}` : ""}`));
    }
    if (url.searchParams.get("state") !== state) {
      reply(400, "This sign-in was not started by Tomrade. Start it again from Tomrade.");
      return settle.reject(new Error("The sign-in answer did not match the request; start it again"));
    }
    reply(200, "Signed in to OpenRouter. You can close this tab and go back to Tomrade.");
    settle.resolve(got);
  });
  const stopped = () => settle.reject(new Error("The OpenRouter sign-in was not finished"));
  opts.signal.addEventListener("abort", stopped, { once: true });
  try {
    if (opts.signal.aborted) stopped();
    const auth = new URL(opts.authURL ?? "https://openrouter.ai/auth");
    auth.search = new URLSearchParams({ callback_url: `http://localhost:${server.port}/callback`, code_challenge: challenge, code_challenge_method: "S256", state, key_label: "Tomrade" }).toString();
    opts.open(auth.href);
    const res = await fetch(opts.keysURL ?? "https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: await code, code_verifier: verifier, code_challenge_method: "S256" }),
      signal: opts.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenRouter refused the sign-in: ${res.status} ${text.slice(0, 200)}`);
    const key = (JSON.parse(text) as { key?: unknown }).key;
    if (typeof key !== "string" || !key) throw new Error("OpenRouter answered without a key");
    return { apiKey: key };
  } finally {
    opts.signal.removeEventListener("abort", stopped);
    server.close();
  }
}
