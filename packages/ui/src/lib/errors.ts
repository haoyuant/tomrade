import type { MessageKey } from "./i18n";

/**
 * The domain's typed refusals cross IPC as "<Class>: <English with ids in it>";
 * the class name survives, so each can be said in the person's own words.
 */
const DOMAIN_ERRORS: Record<string, MessageKey> = {
  ConflictError: "errors.conflict",
  HumanLockedError: "errors.humanLocked",
  NotFoundError: "errors.notFound",
  InUseError: "errors.inUse",
  DependencyCycleError: "errors.cycle"
};

/** What to say for an error's words (IPC wrapper already removed), or null when they are not a known domain refusal. */
export function domainErrorWords(raw: string): { key: MessageKey; vars?: Record<string, string> } | null {
  const named = /^([A-Z][A-Za-z]*Error): /.exec(raw)?.[1];
  const key = named ? DOMAIN_ERRORS[named] : undefined;
  if (!key) return null;
  // The cycle's path is ticket keys, worth keeping in any language.
  if (key === "errors.cycle") return { key, vars: { path: /would close a cycle: (.+)$/.exec(raw)?.[1] ?? "" } };
  return { key };
}
