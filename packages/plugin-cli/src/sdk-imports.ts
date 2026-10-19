import fs from "node:fs";
import { parse } from "@babel/parser";
import { SDK_EXPORTS, compareVersions, lowestContract } from "@tomradex/plugin-sdk";

const SDK = "@tomradex/plugin-sdk";

interface Node {
  type: string;
  source?: { value: string } | null;
  specifiers?: { type: string; imported?: { type: string; name?: string; value?: string }; local?: { name: string } }[];
  importKind?: string;
  exportKind?: string;
}

/** The names a built file takes from each module `wanted` picks, and whether it also takes a module whole. */
export function importsOf(code: string, wanted: (specifier: string) => boolean): Record<string, { names: string[]; namespace: boolean }> {
  const ast = parse(code, { sourceType: "module", errorRecovery: true }) as unknown as { program: { body: Node[] } };
  const found = new Map<string, { names: Set<string>; namespace: boolean }>();
  for (const node of ast.program.body) {
    const source = node.source?.value;
    if (!source || !wanted(source)) continue;
    const seen = found.get(source) ?? { names: new Set<string>(), namespace: false };
    found.set(source, seen);
    if (node.type === "ExportAllDeclaration") seen.namespace = true;
    if (node.type !== "ImportDeclaration" && node.type !== "ExportNamedDeclaration") continue;
    for (const s of node.specifiers ?? []) {
      if (s.type === "ImportNamespaceSpecifier" || s.type === "ExportNamespaceSpecifier") seen.namespace = true;
      else if (s.type === "ImportDefaultSpecifier") seen.names.add("default");
      else if (s.type === "ImportSpecifier") seen.names.add(s.imported?.name ?? s.imported?.value ?? "");
      else if (s.type === "ExportSpecifier") seen.names.add(s.local?.name ?? "");
    }
  }
  return Object.fromEntries([...found].map(([source, { names, namespace }]) => [source, { names: [...names].filter(Boolean).sort(), namespace }]));
}

/** The names a built file takes from the SDK, and whether it also takes the whole module. */
export function sdkImportsOf(code: string): { names: string[]; namespace: boolean } {
  return importsOf(code, (s) => s === SDK)[SDK] ?? { names: [], namespace: false };
}

/**
 * The SDK is the running Tomrade's own copy, so every name the plugin takes
 * from it must be there in the oldest Tomrade its `engines.sdk` accepts.
 */
export function sdkImportProblems(file: string, range: string): { problems: string[]; notes: string[] } {
  const out = { problems: [] as string[], notes: [] as string[] };
  if (!fs.existsSync(file)) return out;
  const { names, namespace } = sdkImportsOf(fs.readFileSync(file, "utf8"));
  if (namespace) out.notes.push(`the plugin takes ${SDK} as a whole module, so which of its names exist in each Tomrade cannot be checked; import the names it uses instead`);
  const lowest = lowestContract(range);
  if (!lowest) return out;
  let needed: string | null = null;
  for (const name of names) {
    const since = SDK_EXPORTS[name];
    if (!since) out.problems.push(`imports "${name}" from ${SDK}, which no SDK exports`);
    else if (compareVersions(since, lowest) > 0) {
      out.problems.push(`imports "${name}" from ${SDK}, which Tomrade has from SDK ${since}; engines.sdk "${range}" also accepts SDK ${lowest}, where the plugin fails to load`);
      if (!needed || compareVersions(since, needed) > 0) needed = since;
    }
  }
  if (needed) out.problems.push(`raise engines.sdk to "^${needed}" (each Tomrade runs a plugin against its own SDK, not one bundled with the plugin)`);
  return out;
}
