import type { FileEntry, FilesSyncPolicy, PathPolicy, SyncMode } from "@tomrade/files";

/** The same closest-ancestor rule the backend applies, for every path dimension. */
export function effectiveMode<M extends string>(policy: PathPolicy<M>, path: string): M {
  let mode = policy.default;
  let depth = -1;
  for (const rule of policy.rules) {
    if ((path === rule.path || path.startsWith(`${rule.path}/`)) && rule.path.length > depth) {
      mode = rule.mode;
      depth = rule.path.length;
    }
  }
  return mode;
}

export const effectiveSyncMode = (policy: FilesSyncPolicy, path: string): SyncMode => effectiveMode(policy, path);

/** Preview the entire batch together: parent resets preserve child exceptions. */
export function makesPathsLocal(policy: FilesSyncPolicy, paths: string[], mode: SyncMode | "inherit"): boolean {
  const targets = new Set(paths);
  const next: FilesSyncPolicy = {
    default: targets.has("") ? mode === "inherit" ? "shared" : mode : policy.default,
    rules: policy.rules.filter((rule) => !targets.has(rule.path))
  };
  if (mode !== "inherit") next.rules.push(...paths.filter(Boolean).map((path) => ({ path, mode })));
  // Rule boundaries and target roots cover every region whose mode can change,
  // including files currently absent from the local tree but present remotely.
  return [...paths, ...policy.rules.map((rule) => rule.path)].some((path) =>
    effectiveSyncMode(policy, path) === "shared" && effectiveSyncMode(next, path) === "local"
  );
}

export function syncFileCounts(entries: FileEntry[], policy?: FilesSyncPolicy) {
  const counts = { shared: 0, local: 0, unknown: 0 };
  for (const entry of entries) {
    if (entry.kind === "dir") continue;
    const mode = policy ? effectiveSyncMode(policy, entry.path) : entry.sync?.mode;
    counts[mode ?? "unknown"]++;
  }
  return counts;
}
