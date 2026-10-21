// Heuristics over a provider's failed-call text: in-repo only (`@tomradex/domain/model-errors`), off the published entry.
import type { ModelErrorKind } from "./errors.js";

/** Why a model turned a working key down: the wrong API for it, not open to this key's tier or account, or not known. */
export type ModelRefusal = "method" | "tier" | "unknown";

const BAD_KEY = /\b401\b|authenticat|unauthori[sz]ed|invalid[ _-]?(api[ _-]?)?key|incorrect api key|api[ _-]?key[ _-]?(not valid|invalid|expired|missing|required)|(missing|no) api[ _-]?key/i;

export function modelRefusal(message: string): ModelRefusal | null {
  if (/not supported for (generateContent|this (api|method|endpoint))|not a chat model|only supported (in|on|by) (the )?(v1\/)?responses|not supported (in|on|by) (the )?(v1\/)?chat\/completions|does not support (chat|generateContent)/i.test(message)) return "method";
  if (/model.{0,40}(not found|does not exist|not exist|unknown)|no such model|unknown model|model_not_found/i.test(message) && !/not have access to model/i.test(message)) return "unknown";
  if (/free[ _-]?tier\w*.{0,80}\blimit: ?0\b|not available (on|for|in) (the |your |this )?(free |current )?(tier|plan)|not have access to (the |this )?model|not have permission to (use|access) (the |this )?model|not allow-?listed|model.{0,60}(not available|unavailable) (to|for) (you|this)/i.test(message)) return "tier";
  return null;
}

/** Only a key the provider calls wrong or missing is `auth`; a model it will not serve this key is `model`, even on a 403. */
export function modelErrorKind(message: string): ModelErrorKind {
  if (BAD_KEY.test(message)) return "auth";
  if (modelRefusal(message)) return "model";
  if (/\b403\b|api key|permission denied|forbidden/i.test(message)) return "auth";
  if (/\b402\b|insufficient|balance|quota|billing|credit/i.test(message)) return "quota";
  if (/\b429\b|rate.?limit|too many requests/i.test(message)) return "rate";
  if (/\b404\b|model.{0,40}(not found|does not exist|not exist|unknown|invalid)|no such model|unknown model/i.test(message)) return "model";
  if (/\b5\d\d\b|overloaded|bad gateway|service unavailable/i.test(message)) return "server";
  // "Connection error." is how the OpenAI and Anthropic SDKs — the built-in pi's — say the service was not reached.
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|connection error|timed? ?out|socket hang up|certificate/i.test(message)) return "network";
  return "other";
}

/** The provider's own words in a failed call's detail (its JSON `message`), or null; cut short where the detail was. */
export function providerMessage(detail: string): string | null {
  const found = /"message"\s*:\s*"((?:[^"\\]|\\.)*)("|$)/.exec(detail);
  if (!found?.[1].trim()) return null;
  let said = found[1];
  try {
    said = JSON.parse(`"${said.replace(/\\$/, "")}"`) as string;
  } catch {}
  return found[2] ? said : `${said}…`;
}
