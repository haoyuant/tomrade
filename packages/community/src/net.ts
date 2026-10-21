import type { LanguageTag } from "@tomradex/domain";
import { errorMessage } from "@tomradex/contracts";
import { COMMUNITY_WORDS } from "./words.js";

const REDIRECTS = 10;

/** Set by the desktop when the system proxy is SOCKS only, which Node's fetch cannot go through. */
export const skippedSocksProxy = (env: NodeJS.ProcessEnv = process.env): string | null => env.TOMRADE_SOCKS_PROXY || null;

const CAUSES: [RegExp, "causeName" | "causeTimeout" | "causeReset" | "causeRefused" | "causeNoRoute" | "causeCertificate"][] = [
  [/^(ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NONAME|EAI_NODATA)$/, "causeName"],
  [/^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|TimeoutError)$/, "causeTimeout"],
  [/^(ECONNRESET|EPIPE|UND_ERR_SOCKET)$/, "causeReset"],
  [/^ECONNREFUSED$/, "causeRefused"],
  [/^(ENETUNREACH|ENETDOWN|EHOSTUNREACH|EHOSTDOWN)$/, "causeNoRoute"],
  [/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/, "causeCertificate"]
];

/** undici says only "fetch failed"; the socket's code and words are in its causes. */
function rootCause(error: unknown): { code: string | null; text: string } {
  let code: string | null = null;
  let text = errorMessage(error);
  let at = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; at && typeof at === "object" && depth < 5; depth++, at = at.cause as typeof at) {
    if (typeof at.code === "string") code = at.code;
    else if (at.name === "TimeoutError") code = "TimeoutError";
    if (typeof at.message === "string" && at.message) text = at.message;
  }
  return { code, text };
}

/** Each error and its causes, one per line: what a report or log needs. */
export const causeChain = (error: unknown): string => {
  const lines: string[] = [];
  let at: unknown = error;
  for (let depth = 0; at !== undefined && at !== null && depth < 5; depth++, at = (at as { cause?: unknown }).cause) {
    const e = at as { name?: unknown; code?: unknown };
    lines.push(`${typeof e.name === "string" ? `${e.name}: ` : ""}${errorMessage(at)}${typeof e.code === "string" ? ` (${e.code})` : ""}`);
  }
  return lines.join("\ncaused by ");
};

/** "could not reach <host>: <why>", with what to check; the error it came from is its cause. */
export function unreachable(host: string, error: unknown, locale?: LanguageTag, env: NodeJS.ProcessEnv = process.env): Error {
  const words = COMMUNITY_WORDS(locale);
  const { code, text } = rootCause(error);
  const key = code ? CAUSES.find(([pattern]) => pattern.test(code))?.[1] : undefined;
  const socks = skippedSocksProxy(env);
  const hint = socks ? words("socksSkipped", { proxy: socks }) : words("checkNetwork");
  return new Error(words("unreachable", { host, cause: key ? words(key, { code: code! }) : text, hint }), { cause: error });
}

/**
 * A GET that follows redirects itself, so a failure names the host that did
 * not answer: a package on github.com is served from another host, and
 * undici's error names neither.
 */
export async function reach(url: string, init: { signal: AbortSignal; headers?: Record<string, string> }, locale?: LanguageTag): Promise<{ response: Response; hosts: string[] }> {
  const hosts: string[] = [];
  let at = new URL(url);
  for (let hop = 0; ; hop++) {
    hosts.push(at.host);
    let response: Response;
    try {
      response = await fetch(at.href, { ...init, redirect: "manual" });
    } catch (error) {
      throw unreachable(at.host, error, locale);
    }
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location || hop === REDIRECTS) return { response, hosts };
    await response.body?.cancel();
    at = new URL(location, at);
  }
}
