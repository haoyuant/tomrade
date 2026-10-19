export class ConflictError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number
  ) {
    super(`Item ${itemId} version conflict: expected ${expectedVersion}, got ${actualVersion} (it was edited by someone else)`);
    this.name = "ConflictError";
  }
}

export class HumanLockedError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly fields: string[]
  ) {
    super(`Item ${itemId} is human-locked; AI may not edit fields: ${fields.join(", ")}`);
    this.name = "HumanLockedError";
  }
}

export class NotFoundError extends Error {
  constructor(public readonly itemId: string) {
    super(`Item ${itemId} not found`);
    this.name = "NotFoundError";
  }
}

/** The permanent delete refused because the caller is not a human. */
export class PurgeNotPermittedError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly by: string
  ) {
    super(`Item ${itemId} may only be permanently deleted by a human; ${by} must use the reversible delete`);
    this.name = "PurgeNotPermittedError";
  }
}

/** An extension claimed a human's authorship outside a human-initiated call. */
export class ExtensionAuthorError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly entity: string,
    public readonly op: string
  ) {
    super(`Extension ${pluginId} may not write as a human (${entity} ${op}) unless a person asked for it`);
    this.name = "ExtensionAuthorError";
  }
}

/** A blocks edit refused because "blocked until done" only means something on a DAG. */
export class DependencyCycleError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly path: string[]
  ) {
    super(`Blocking ${path[path.length - 1]} would close a cycle: ${path.join(" → ")}`);
    this.name = "DependencyCycleError";
  }
}

/** A destructive write refused because something still depends on the target. */
export class InUseError extends Error {
  constructor(
    public readonly entityId: string,
    public readonly reason: string
  ) {
    super(reason);
    this.name = "InUseError";
  }
}

/** A custom-field write refused: unknown field, wrong type, or an option the field does not have. */
export class FieldValueError extends Error {
  constructor(
    public readonly fieldId: string,
    public readonly reason: string
  ) {
    super(`Field ${fieldId}: ${reason}`);
    this.name = "FieldValueError";
  }
}

/** A field definition change refused: a built-in, a taken name, an option on a non-select. */
export class FieldDefinitionError extends Error {
  constructor(
    public readonly fieldId: string,
    public readonly reason: string
  ) {
    super(`Field ${fieldId}: ${reason}`);
    this.name = "FieldDefinitionError";
  }
}

/**
 * What a failed model call means for the person — each wants a different fix: the key, the address, a wait.
 * `slow`: the model was reached but gave no answer in time; only a check that waits for one says it.
 */
export type ModelErrorKind = "auth" | "quota" | "rate" | "model" | "server" | "network" | "slow" | "other";

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
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|timed? ?out|socket hang up|certificate/i.test(message)) return "network";
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

/**
 * An undo aimed at one write — a toast's — refused because the thing changed
 * again since. The marker survives IPC's message wrapping, so the renderer can
 * say it in the person's language.
 */
export const STALE_UNDO = "[stale-undo]";
export class StaleUndoError extends Error {
  constructor(public readonly entityId: string) {
    super(`${STALE_UNDO} ${entityId} changed again after that edit; undo it from History instead`);
    this.name = "StaleUndoError";
  }
}
