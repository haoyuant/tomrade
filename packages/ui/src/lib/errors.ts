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
  DependencyCycleError: "errors.cycle",
  UnpublishedEditsError: "errors.unpublishedEdits"
};

/** The reasons the backend gives for an InUseError: id-free, and each says what to do. */
const IN_USE: [RegExp, MessageKey, string[]][] = [
  [/^Workstream (.+) still holds (\d+) tickets? — move them first$/, "errors.inUseWorkstreamHolds", ["name", "count"]],
  [/^Workstream (.+) is the project's last; new tickets need somewhere to land$/, "errors.inUseLastWorkstream", ["name"]],
  [/^(.+) is the project's last view$/, "errors.inUseLastView", ["name"]],
  [/^That workstream now holds (\d+) tickets? — move them before undoing it$/, "errors.inUseUndoHolds", ["count"]],
  [/^(.+) is still the repository of (\d+) workstreams?$/, "errors.inUseRepository", ["name", "count"]]
];

/** What to say for an error's words (IPC wrapper already removed), or null when they are not a known domain refusal. */
export function domainErrorWords(raw: string): { key: MessageKey; vars?: Record<string, string> } | null {
  const named = /^([A-Z][A-Za-z]*Error): /.exec(raw)?.[1];
  const key = named ? DOMAIN_ERRORS[named] : undefined;
  if (!key) return null;
  // The cycle's path is ticket keys, worth keeping in any language.
  if (key === "errors.cycle") return { key, vars: { path: /would close a cycle: (.+)$/.exec(raw)?.[1] ?? "" } };
  // Why the folder could not take the edits: the folder's or git's own words.
  if (key === "errors.unpublishedEdits") return { key, vars: { reason: /does not hold yet — (.+)\. The cache was kept/.exec(raw)?.[1] ?? "" } };
  if (key === "errors.inUse") {
    const reason = raw.slice(named!.length + 2);
    for (const [pattern, known, names] of IN_USE) {
      const m = pattern.exec(reason);
      if (m) return { key: known, vars: { reason, ...Object.fromEntries(names.map((n, i) => [n, m[i + 1]])) } };
    }
    return { key, vars: { reason } };
  }
  return { key };
}
