import { z } from "zod";
import { LANGUAGE_PACK_LIMITS, LanguageEntrySchema } from "./language.js";
import { isRange, isVersion } from "./semver.js";

/** The contract this SDK describes. A plugin's `engines.sdk` range is checked against the host's. */
export const SDK_CONTRACT = "0.2.18";

export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,63}$/;
export const NAMESPACE = /^[a-z][a-z0-9_]{1,31}$/;

/** The app's own names, and the official publisher's. */
export const RESERVED_NAMESPACES = new Set([
  "agent", "alerts", "archify", "boards", "code_link", "contributions", "core", "db", "deps", "deps_graph", "fields", "files", "hub", "im", "ipc", "items",
  "llm", "mcp", "oplog", "pet", "plugin", "plugins", "pomodoro", "projects", "repos", "settings", "storage", "surfaces", "system", "tomrade", "tools", "views", "write"
]);
export const OFFICIAL_PUBLISHER = "tomrade";

const SERVICE = z.enum(["items", "fields", "boards", "views", "projects", "db", "settings", "tools", "contributions", "agent", "surfaces", "alerts", "oplog", "im", "webSearch", "terminals", "models"]);

export const PermissionsSchema = z
  .object({
    /** Hosts the plugin talks to; `*` means any. */
    network: z.array(z.string().min(1)).default([]),
    /** `plugin`: its own data directory. `project`: the project folders. `any`: anywhere on disk. */
    fs: z.enum(["none", "plugin", "project", "any"]).default("none"),
    /** Starts other programs. */
    exec: z.boolean().default(false),
    /** SDK 0.2.11: opens working windows of its own (a surface of kind "window"), which take keys like any app window. */
    window: z.boolean().default(false),
    /** Why the plugin needs a wide permission, in a sentence a person installing it can judge. Official plugins must say. */
    why: z.object({ network: z.string().min(1), fs: z.string().min(1), exec: z.string().min(1), window: z.string().min(1), full: z.string().min(1) }).partial().optional()
  })
  .default({ network: [], fs: "none", exec: false, window: false });

export const ContributesSchema = z
  .object({
    tools: z.array(z.string()).default([]),
    commands: z.array(z.string()).default([]),
    badges: z.array(z.string()).default([]),
    statusItems: z.array(z.string()).default([]),
    sections: z.array(z.string()).default([]),
    graphs: z.array(z.string()).default([]),
    sidebarModules: z.array(z.string()).default([]),
    playbooks: z.array(z.string()).default([]),
    settings: z.array(z.string()).default([]),
    surfaces: z.array(z.string()).default([]),
    tables: z.array(z.string()).default([]),
    imAdapters: z.array(z.string()).default([]),
    webSearchProviders: z.array(z.string()).default([]),
    /** SDK 0.2.15: the CLI agent hook events it hears. */
    agentHooks: z.array(z.string()).default([]),
    /** SDK 0.2.16: the model providers it registers. */
    modelProviders: z.array(z.string()).default([]),
    /** SDK 0.2.17: the local agents it registers. */
    localAgents: z.array(z.string()).default([])
  })
  .partial();

/**
 * One row a full-mode plugin lays over Tomrade's composition, merged by id like a
 * `tomrade.patch.yml` row: an app row's id switches it off, replaces its plugin or
 * changes its config; a new id (carrying the namespace) adds a row. A relative
 * `name` is a file inside the package.
 */
export const RowSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    config: z.unknown().optional(),
    disabled: z.boolean().optional()
  })
  .refine((row) => row.name !== undefined || row.config !== undefined || row.disabled !== undefined, "a row changes something: name, config or disabled");

export type ManifestRow = z.output<typeof RowSchema>;

export const ManifestSchema = z.object({
  id: z.string().regex(PLUGIN_ID, "publisher/name, lowercase letters, digits and dashes"),
  namespace: z.string().regex(NAMESPACE, "lowercase letters, digits and underscores, 2–32 long, starting with a letter").optional(),
  version: z.string().refine(isVersion, "a semantic version such as 1.2.0"),
  title: z.string().min(1).max(60),
  description: z.string().max(500).default(""),
  /** An SPDX identifier of an OSI-approved license. */
  license: z.string().min(1),
  repository: z.url().optional(),
  homepage: z.url().optional(),
  author: z.object({ name: z.string().min(1), url: z.url().optional() }).optional(),
  engines: z.object({
    sdk: z.string().refine(isRange, "a version range such as ^0.2.0"),
    /** SDK 0.2.13: the Tomrade versions a full-mode plugin works with; it reaches internals the SDK range does not cover. */
    tomrade: z.string().refine(isRange, "a version range such as >=0.13.0 <0.14.0").optional()
  }),
  /**
   * SDK 0.2.13: what `main` receives. `"sdk"` is a `definePlugin` plugin behind the async facade;
   * `"full"` is a plain cordis plugin given Tomrade's whole Context, as the app's own modules are.
   */
  context: z.enum(["sdk", "full"]).default("sdk"),
  /** SDK 0.2.13, full mode only: rows laid over Tomrade's own, as `tomrade.patch.yml` rows are. */
  rows: z.array(RowSchema).default([]),
  /** The built code; `null` for a plugin that is data only, such as a language pack. */
  main: z.string().nullable().default("dist/index.js"),
  icon: z.string().optional(),
  /** Languages the plugin adds, each a JSON file of words (SDK 0.2.8). */
  languages: z.array(LanguageEntrySchema).max(LANGUAGE_PACK_LIMITS.languages).default([]),
  permissions: PermissionsSchema,
  /** Stamped by `tomrade-plugin build` from the exported plugin. */
  inject: z.array(SERVICE).default([]),
  optional: z.array(SERVICE).default([]),
  contributes: ContributesSchema.default({}),
  authoredBy: z.enum(["human", "agent", "mixed"]).default("human"),
  /** A fork names what it came from; the store credits the original. */
  forkOf: z.object({ id: z.string().regex(PLUGIN_ID), version: z.string() }).optional()
});

export type Manifest = z.output<typeof ManifestSchema>;
export type ManifestInput = z.input<typeof ManifestSchema>;
export type Permissions = z.output<typeof PermissionsSchema>;

export const MANIFEST_FILE = "tomrade-plugin.json";

export function parseManifest(raw: unknown): Manifest {
  const manifest = ManifestSchema.parse(raw);
  const ns = namespaceOf(manifest);
  if (!NAMESPACE.test(ns)) throw new Error(`${manifest.id}: the name part does not make a valid namespace ("${ns}"); set "namespace" in ${MANIFEST_FILE}`);
  if (RESERVED_NAMESPACES.has(ns) && publisherOf(manifest.id) !== OFFICIAL_PUBLISHER) throw new Error(`${manifest.id}: namespace "${ns}" is reserved`);
  if (manifest.main === null && !manifest.languages.length) throw new Error(`${manifest.id}: "main" is null, so the plugin has no code; it must add a language under "languages"`);
  if (manifest.context === "full") {
    if (manifest.main === null) throw new Error(`${manifest.id}: a full-mode plugin needs "main", the cordis plugin it runs`);
    if (!manifest.engines.tomrade) throw new Error(`${manifest.id}: a full-mode plugin names the Tomrade versions it works with in "engines.tomrade"`);
    if (manifest.languages.length) throw new Error(`${manifest.id}: a full-mode plugin adds its languages from its own code (ctx.settings.addLanguage), not under "languages"`);
  } else if (manifest.rows.length) throw new Error(`${manifest.id}: "rows" change Tomrade's own composition, which takes "context": "full"`);
  const ids = manifest.rows.map((r) => r.id);
  const repeated = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repeated) throw new Error(`${manifest.id}: the row "${repeated}" is listed twice`);
  const tags = manifest.languages.map((l) => l.tag);
  const twice = tags.find((t, i) => tags.indexOf(t) !== i);
  if (twice) throw new Error(`${manifest.id}: the language "${twice}" is listed twice`);
  return manifest;
}

export const publisherOf = (id: string): string => id.split("/")[0]!;
export const nameOf = (id: string): string => id.split("/")[1] ?? id;

/** The prefix every id the plugin registers carries, and the name of its tables. */
export const namespaceOf = (manifest: Pick<Manifest, "id" | "namespace">): string => manifest.namespace ?? nameOf(manifest.id).replace(/-/g, "_");

export const ownsId = (namespace: string, id: string): boolean => id === namespace || [".", "-", "_"].some((sep) => id.startsWith(namespace + sep));

export function assertOwned(namespace: string, id: string, kind: string): void {
  if (!ownsId(namespace, id)) throw new Error(`${kind} "${id}" must be named "${namespace}" or start with "${namespace}." "${namespace}-" or "${namespace}_"`);
}

export type RiskLevel = "low" | "elevated" | "high";

export interface Risk {
  level: RiskLevel;
  /** Stable keys the UI words: `full`, `rows`, `exec`, `fs-any`, `network-any`, `network`, `fs-project`, `db`, `models`, `window`. */
  reasons: string[];
}

/**
 * High risk is labelled, not refused: running with Tomrade's whole context or
 * changing its own rows, running programs, reading anywhere on disk, or talking
 * to any host. Elevated is what a person should still see.
 */
export function riskOf(manifest: Pick<Manifest, "permissions" | "inject" | "optional"> & Partial<Pick<Manifest, "context" | "rows">>): Risk {
  const p = manifest.permissions;
  const full = manifest.context === "full";
  const high = [full && "full", full && manifest.rows?.length && "rows", p.exec && "exec", p.fs === "any" && "fs-any", p.network.includes("*") && "network-any"].filter(Boolean) as string[];
  const elevated = [
    p.network.length && !p.network.includes("*") && "network",
    p.fs === "project" && "fs-project",
    [...manifest.inject, ...manifest.optional].includes("db") && "db",
    // A model provider reads the conversations of the profiles on it, and their keys.
    [...manifest.inject, ...manifest.optional].includes("models") && "models",
    // A window that takes keys could pass itself off as another app's: worth a look before installing.
    p.window && "window"
  ].filter(Boolean) as string[];
  return { level: high.length ? "high" : elevated.length ? "elevated" : "low", reasons: [...high, ...elevated] };
}

/** OSI-approved licenses the store accepts without a second look. */
export const OSI_LICENSES = new Set([
  "0BSD", "AGPL-3.0", "AGPL-3.0-only", "AGPL-3.0-or-later", "Apache-2.0", "Artistic-2.0", "BSD-2-Clause", "BSD-3-Clause", "BSL-1.0", "CDDL-1.0", "EPL-1.0", "EPL-2.0",
  "EUPL-1.2", "GPL-2.0", "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0", "GPL-3.0-only", "GPL-3.0-or-later", "ISC", "LGPL-2.1", "LGPL-2.1-only", "LGPL-2.1-or-later",
  "LGPL-3.0", "LGPL-3.0-only", "LGPL-3.0-or-later", "MIT", "MIT-0", "MPL-2.0", "MS-PL", "MulanPSL-2.0", "NCSA", "OSL-3.0", "PostgreSQL", "Unlicense", "UPL-1.0", "Zlib"
]);

export const isOpenSource = (license: string): boolean => license.split(/\s+OR\s+/i).some((l) => OSI_LICENSES.has(l.replace(/[()]/g, "").trim()));
