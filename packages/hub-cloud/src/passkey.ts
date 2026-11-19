import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/** How long the person has to finish in the browser. */
export const PASSKEY_MS = 5 * 60_000;

export interface Ceremony {
  /** `create` adds a passkey to the signed-in account; `get` signs in with one. */
  kind: "create" | "get";
  /** The WebAuthn options Supabase issued, in their JSON form. */
  options: unknown;
  /** The site's relay page, e.g. https://tomrade.com/auth/passkey/. */
  page: string;
  open(url: string): void;
  signal: AbortSignal;
}

/**
 * WebAuthn needs the https origin the passkeys belong to (tomrade.com), which the
 * app's windows are not, so the ceremony runs on the site's relay page in the
 * person's own browser. The page reads `#<base64url JSON {v, kind, options, callback, state}>`,
 * calls navigator.credentials.create/get with the options, then navigates to
 * `callback?state=…&credential=<base64url JSON of credential.toJSON()>`, or
 * `callback?state=…&error=<DOMException name>`. The loopback answers 204, so
 * the page stays as it is. Only the signed challenge comes back: the session is
 * made and kept here, never in the browser.
 */
export async function inBrowser(c: Ceremony): Promise<unknown> {
  const state = randomBytes(16).toString("base64url");
  let settle!: { resolve: (credential: unknown) => void; reject: (error: Error) => void };
  const answer = new Promise<unknown>((resolve, reject) => (settle = { resolve, reject }));
  // awaited below; a refusal before then is not an unhandled one
  answer.catch(() => {});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // Anything else on this machine may knock; only the page that got the state is heard.
    if (url.pathname !== "/passkey" || url.searchParams.get("state") !== state) return void res.writeHead(404).end();
    res.writeHead(204).end();
    const error = url.searchParams.get("error");
    if (error) return settle.reject(error === "NotAllowedError" || error === "AbortError"
      ? new Error("[passkey_cancelled] The passkey was not used.")
      : new Error(`[passkey_failed] The browser could not use a passkey: ${error.slice(0, 100)}`));
    try {
      const credential = JSON.parse(Buffer.from(url.searchParams.get("credential") ?? "", "base64url").toString()) as unknown;
      if (!credential || typeof credential !== "object" || typeof (credential as { id?: unknown }).id !== "string") throw new Error("no credential");
      settle.resolve(credential);
    } catch {
      settle.reject(new Error("[passkey_failed] The browser sent back no passkey."));
    }
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const stopped = () => settle.reject(c.signal.reason instanceof DOMException && c.signal.reason.name === "TimeoutError"
    ? new Error("[passkey_timeout] The passkey was not used in time.")
    : new Error("[passkey_cancelled] The passkey was not used."));
  c.signal.addEventListener("abort", stopped, { once: true });
  try {
    if (c.signal.aborted) stopped();
    const payload = { v: 1, kind: c.kind, options: c.options, callback: `http://127.0.0.1:${port}/passkey`, state };
    const page = new URL(c.page);
    page.hash = Buffer.from(JSON.stringify(payload)).toString("base64url");
    c.open(page.href);
    return await answer;
  } finally {
    c.signal.removeEventListener("abort", stopped);
    server.close();
    server.closeAllConnections();
  }
}
