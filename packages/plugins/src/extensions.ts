import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "cordis";
import { adaptLanguagePacks, adaptSdkPlugin, claimFullPlugin, identityOf } from "@tomradex/extensions";
import { SDK_CONTRACT, isSdkPlugin, isVersion, namespaceOf, ownsId, riskOf, satisfies, type Manifest, type ManifestRow, type Risk } from "@tomradex/plugin-sdk";
import {
  analyzePackage,
  dataDirFor,
  packageDigest,
  placePackage,
  readLanguagePack,
  readLock,
  readManifest,
  tierOf,
  unpackPlugin,
  verifyAttestation,
  writeLock,
  type Analysis,
  type Attestation,
  type Lock,
  type LockEntry,
  type TrustTier
} from "@tomradex/plugin-kit";
import { PROTECTED_ROWS, type RowPatch } from "./types.js";

export interface ExtensionStoreConfig {
  /** `~/Tomrade/plugins`: installed versions and each plugin's data. */
  root: string;
  lockFile: string;
  /** keyId → public key PEM: whose attestations this build believes. */
  trustedKeys: Record<string, string>;
  /** The host's own `import()`, so a plugin's bare imports resolve the host's way. */
  importer(url: string): Promise<unknown>;
  /** This Tomrade's version, held to a full-mode plugin's `engines.tomrade`. Absent in a checkout, which checks no range. */
  appVersion?: string | null;
}

/** What one row of a full-mode extension does to Tomrade's composition. */
export interface RowChange {
  id: string;
  change: "adds" | "replaces" | "switches-off" | "configures";
  /** Other extensions whose rows change the same row; the one installed last is laid on last. */
  alsoBy: string[];
  /** Why it is not applied, when it is not. */
  refused?: string;
}

export interface FullModeInfo {
  /** The Tomrade versions it says it works with. */
  tomrade: string;
  rows: RowChange[];
  /** Its rows are not the ones this start applied: they change with the next start. */
  restart: boolean;
}

/**
 * A version range the plugin's manifest names that this Tomrade is outside:
 * `tomrade` for a full-mode plugin's `engines.tomrade`, `sdk` for `engines.sdk`.
 * `granted`: the person let this exact plugin version run on this exact version anyway.
 */
export interface RangeMiss {
  kind: "tomrade" | "sdk";
  range: string;
  version: string;
  granted: boolean;
}

/** Grants by `<plugin id>@<version>`: the exact Tomrade versions and SDK contracts each may run on outside its range. */
type Grants = Map<string, { tomrade: Set<string>; sdk: Set<string> }>;

export const COMPATIBILITY_FILE = "compatibility.json";

/** What the manager shows for a row that is an extension. */
export interface ExtensionInfo {
  id: string;
  namespace: string;
  version: string;
  title: string;
  description: string;
  license: string;
  repository?: string;
  source: LockEntry["source"];
  tier: TrustTier;
  risk: Risk;
  permissions: Manifest["permissions"];
  inject: string[];
  authoredBy: Manifest["authoredBy"];
  dir: string;
  modified: boolean;
  autoUpdate: boolean;
  previousVersion: string | null;
  /** A studio build nobody has confirmed yet: its digest and what the analyzer found in it. */
  pending: { digest: string; analysis: Analysis } | null;
  attestation: Attestation | null;
  /** Runs with Tomrade's whole Context rather than the SDK's facade. */
  full: FullModeInfo | null;
  /** The CLI agent hook events it hears, as its build recorded them. */
  agentHooks: string[];
  /** The ranges it names that this Tomrade is outside, each granted or not. */
  outOfRange: RangeMiss[];
}

export class ExtensionRefused extends Error {
  override name = "ExtensionRefused";
}

const now = () => Date.now();

/** What a full-mode extension's rows do this start: each row as it is laid on, or why it is not. */
interface RowPlan {
  row: ManifestRow;
  change: RowChange["change"];
  patch: RowPatch | null;
  refused?: string;
}

/** A row's plugin is a file inside the package, or a package the app itself resolves. */
function rowName(dir: string, name: string): string {
  if (!name.startsWith(".")) {
    if (path.isAbsolute(name)) throw new Error(`its plugin "${name}" is a path outside the package; name a file inside it (./dist/…)`);
    return name;
  }
  const file = path.resolve(dir, name);
  const rel = path.relative(dir, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`its plugin "${name}" is outside the package`);
  return file;
}

/**
 * The installed extensions and the rules for loading one: the files must be
 * the ones installed, the code must be an SDK plugin the host's contract
 * satisfies, and an agent's build loads only at a digest a person confirmed.
 */
export class ExtensionStore {
  private lock: Lock;
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly pendingAnalysis = new Map<string, { digest: string; analysis: Analysis }>();
  /** The app's own row ids, which a full-mode extension's rows may change; known once the composition asks for rows. */
  private appRows: ReadonlySet<string> = new Set();
  /** Each full-mode extension's rows as this start applied them, to tell when the next start would differ. */
  private readonly applied = new Map<string, string>();
  onChange: (id: string) => void = () => {};
  private grants: Grants = new Map();
  /** What could not be read from `compatibility.json`; while the file itself cannot be parsed it is never overwritten. */
  compatibilityProblems: string[] = [];
  private compatibilityReadOnly = false;

  constructor(private readonly config: ExtensionStoreConfig) {
    this.lock = readLock(config.lockFile);
    this.readGrants();
  }

  private get compatibilityFile(): string {
    return path.join(path.dirname(this.config.lockFile), COMPATIBILITY_FILE);
  }

  /** Every record that reads as a grant applies; the rest are reported, never fatal. */
  private readGrants(): void {
    this.grants = new Map();
    this.compatibilityProblems = [];
    this.compatibilityReadOnly = false;
    if (!fs.existsSync(this.compatibilityFile)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.compatibilityFile, "utf8"));
    } catch (error) {
      this.compatibilityReadOnly = true;
      this.compatibilityProblems.push(`${COMPATIBILITY_FILE} is not JSON (${error instanceof Error ? error.message : String(error)}); no exemption applies until it is repaired by hand`);
      return;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      this.compatibilityReadOnly = true;
      this.compatibilityProblems.push(`${COMPATIBILITY_FILE} is not an object of "<plugin id>@<version>" records; no exemption applies until it is repaired by hand`);
      return;
    }
    const versions = (value: unknown) => (Array.isArray(value) && value.every((v) => typeof v === "string" && isVersion(v)) ? new Set(value as string[]) : null);
    for (const [key, record] of Object.entries(raw)) {
      const tomrade = versions((record as { tomrade?: unknown } | null)?.tomrade ?? []);
      const sdk = versions((record as { sdk?: unknown } | null)?.sdk ?? []);
      const [id, version] = [key.slice(0, key.lastIndexOf("@")), key.slice(key.lastIndexOf("@") + 1)];
      if (!id || !isVersion(version) || typeof record !== "object" || record === null || !tomrade || !sdk) {
        this.compatibilityProblems.push(`${COMPATIBILITY_FILE}: "${key}" is not a grant ({ "tomrade": [versions], "sdk": [versions] } under "<plugin id>@<version>"); it is left out`);
        // a record that cannot be read would be lost on rewrite
        this.compatibilityReadOnly = true;
        continue;
      }
      this.grants.set(key, { tomrade, sdk });
    }
  }

  private writeGrants(): void {
    const out: Record<string, { tomrade: string[]; sdk: string[] }> = {};
    for (const [key, grant] of this.grants) if (grant.tomrade.size || grant.sdk.size) out[key] = { tomrade: [...grant.tomrade].sort(), sdk: [...grant.sdk].sort() };
    fs.mkdirSync(path.dirname(this.compatibilityFile), { recursive: true });
    const tmp = `${this.compatibilityFile}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
    fs.renameSync(tmp, this.compatibilityFile);
  }

  /** The ranges a manifest names that this Tomrade is outside, and whether this exact pair was let in. */
  private misses(manifest: Manifest): RangeMiss[] {
    const grant = this.grants.get(`${manifest.id}@${manifest.version}`);
    const out: RangeMiss[] = [];
    if (!satisfies(SDK_CONTRACT, manifest.engines.sdk)) out.push({ kind: "sdk", range: manifest.engines.sdk, version: SDK_CONTRACT, granted: !!grant?.sdk.has(SDK_CONTRACT) });
    const app = this.config.appVersion;
    if (manifest.context === "full" && app && !satisfies(app, manifest.engines.tomrade!)) out.push({ kind: "tomrade", range: manifest.engines.tomrade!, version: app, granted: !!grant?.tomrade.has(app) });
    return out;
  }

  /**
   * Lets this exact version of the plugin run on this exact Tomrade, outside the ranges it names. The
   * person has been told it may crash Tomrade or lose data; neither a new plugin version nor a new
   * Tomrade inherits it.
   */
  allowVersion(id: string): LockEntry {
    const entry = this.entry(id);
    const manifest = readManifest(entry.dir);
    const misses = this.misses(manifest);
    if (!misses.length) throw new ExtensionRefused(`${id} ${manifest.version} already runs on this version of Tomrade`);
    if (this.compatibilityReadOnly) throw new ExtensionRefused(`${COMPATIBILITY_FILE} has records Tomrade cannot read; repair it by hand before letting a plugin in`);
    const key = `${manifest.id}@${manifest.version}`;
    const grant = this.grants.get(key) ?? { tomrade: new Set<string>(), sdk: new Set<string>() };
    for (const miss of misses) grant[miss.kind].add(miss.version);
    this.grants.set(key, grant);
    this.writeGrants();
    this.onChange(id);
    return entry;
  }

  /** Takes back what `allowVersion` let in for this plugin version, on any Tomrade. */
  withdrawVersion(id: string): LockEntry {
    const entry = this.entry(id);
    const manifest = readManifest(entry.dir);
    if (this.compatibilityReadOnly) throw new ExtensionRefused(`${COMPATIBILITY_FILE} has records Tomrade cannot read; repair it by hand`);
    if (this.grants.delete(`${manifest.id}@${manifest.version}`)) this.writeGrants();
    this.onChange(id);
    return entry;
  }

  /** Installed first, laid on first: an update or a switch does not move a plugin in this order. */
  private inOrder(): LockEntry[] {
    return [...this.lock.plugins].sort((a, b) => a.installedAt - b.installedAt || a.id.localeCompare(b.id));
  }

  /** A full-mode extension's manifest, when it is one that may run here; null for an SDK plugin. */
  private full(entry: LockEntry): Manifest | null {
    let manifest: Manifest;
    try {
      manifest = readManifest(entry.dir);
    } catch {
      return null;
    }
    return manifest.context === "full" ? manifest : null;
  }

  /** Why this Tomrade does not run the plugin for its ranges, or null when it does: in range, or let in for this exact pair. */
  private outOfRange(manifest: Manifest): string | null {
    const miss = this.misses(manifest).find((m) => !m.granted);
    if (!miss) return null;
    const anyway = " — Settings → Plugins can run it on this version anyway";
    return miss.kind === "sdk"
      ? `${manifest.id} needs plugin SDK ${miss.range}; this Tomrade provides ${miss.version}${anyway}`
      : `${manifest.id} runs with Tomrade's whole context and works with Tomrade ${miss.range}; this is ${miss.version}${anyway}`;
  }

  /** Each of an extension's rows as this start would lay it on, checked against the app's own rows. */
  private plan(entry: LockEntry, manifest: Manifest): RowPlan[] {
    const ns = namespaceOf(manifest);
    return manifest.rows.map((row): RowPlan => {
      const ours = this.appRows.has(row.id);
      const change: RowChange["change"] = !ours ? "adds" : row.disabled ? "switches-off" : row.name ? "replaces" : "configures";
      const refuse = (refused: string): RowPlan => ({ row, change, patch: null, refused });
      if (ours && PROTECTED_ROWS.has(row.id)) return refuse(`Tomrade keeps “${row.id}” itself: plugins are switched off, removed and revoked through it`);
      if (!ours && !ownsId(ns, row.id)) return refuse(`a row it adds is named “${ns}” or starts with it`);
      if (!ours && !row.name) return refuse("a row it adds names its plugin");
      let name: string | undefined;
      try {
        name = row.name === undefined ? undefined : rowName(entry.dir, row.name);
      } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error));
      }
      const patch: RowPatch = { id: row.id };
      // Only a plugin the extension supplies is its code; an app row it reconfigures stays the app's.
      if (name !== undefined) Object.assign(patch, { name, from: entry.id });
      if (row.title !== undefined) patch.title = row.title;
      if (row.config !== undefined) patch.config = row.config;
      if (row.disabled !== undefined) patch.disabled = row.disabled;
      return { row, change, patch };
    });
  }

  /** The rows an extension lays on now: none while it is off, unconfirmed, or outside its Tomrade range. */
  private active(entry: LockEntry): { manifest: Manifest; plan: RowPlan[] } | null {
    const manifest = this.full(entry);
    if (!manifest || entry.disabled || !this.confirmed(entry) || this.outOfRange(manifest)) return null;
    return { manifest, plan: this.plan(entry, manifest) };
  }

  /**
   * The rows full-mode extensions lay over the app's, one list per extension in
   * the order they were installed, for the composition to apply after the
   * app's rows and before the person's own patch file. What it returns is what
   * this start applies.
   */
  patches(appRows: Iterable<string>): { from: string; rows: RowPatch[] }[] {
    this.appRows = new Set(appRows);
    const out: { from: string; rows: RowPatch[] }[] = [];
    for (const entry of this.inOrder()) {
      const rows = (this.active(entry)?.plan ?? []).flatMap((p) => (p.patch ? [p.patch] : []));
      this.applied.set(entry.id, JSON.stringify(rows));
      if (rows.length) out.push({ from: entry.id, rows });
    }
    return out;
  }

  /** A plugin one of an extension's rows loads is that extension's code: its writes carry the namespace too. */
  claim(plugin: object, from: string): void {
    if (!this.has(from)) return;
    const manifest = this.full(this.entry(from));
    if (manifest) claimFullPlugin(plugin, namespaceOf(manifest));
  }

  /** What an extension's rows do, and which other extensions' rows change the same ones. */
  private fullInfo(entry: LockEntry, manifest: Manifest): FullModeInfo {
    const plan = this.plan(entry, manifest);
    const others = new Map<string, string[]>();
    for (const other of this.inOrder()) {
      if (other.id === entry.id) continue;
      for (const p of this.active(other)?.plan ?? []) if (p.patch && this.appRows.has(p.row.id)) others.set(p.row.id, [...(others.get(p.row.id) ?? []), other.id]);
    }
    const current = this.active(entry);
    const rows = JSON.stringify((current?.plan ?? []).flatMap((p) => (p.patch ? [p.patch] : [])));
    return {
      tomrade: manifest.engines.tomrade!,
      rows: plan.map((p) => ({ id: p.row.id, change: p.change, alsoBy: p.change === "adds" ? [] : (others.get(p.row.id) ?? []), ...(p.refused ? { refused: p.refused } : {}) })),
      restart: rows !== (this.applied.get(entry.id) ?? "[]")
    };
  }

  get root(): string {
    return this.config.root;
  }

  entries(): LockEntry[] {
    return this.lock.plugins;
  }

  has(id: string): boolean {
    return this.lock.plugins.some((p) => p.id === id);
  }

  entry(id: string): LockEntry {
    const entry = this.lock.plugins.find((p) => p.id === id);
    if (!entry) throw new Error(`No extension “${id}” is installed`);
    return entry;
  }

  /** One composition row per installed extension. A studio build waiting for a person stays off. */
  rows(): { id: string; name: string; disabled: boolean }[] {
    return this.lock.plugins.map((p) => ({ id: p.id, name: `ext:${p.id}`, disabled: p.disabled || !this.confirmed(p) }));
  }

  private confirmed(entry: LockEntry): boolean {
    return entry.source !== "studio" || entry.confirmed.includes(this.currentDigest(entry));
  }

  private currentDigest(entry: LockEntry): string {
    try {
      return packageDigest(entry.dir);
    } catch {
      return "";
    }
  }

  private save(): void {
    writeLock(this.config.lockFile, this.lock);
  }

  private put(entry: LockEntry): LockEntry {
    this.lock = { v: 1, plugins: [...this.lock.plugins.filter((p) => p.id !== entry.id), entry] };
    this.save();
    return entry;
  }

  info(id: string): ExtensionInfo {
    const entry = this.entry(id);
    const manifest = readManifest(entry.dir);
    const digest = this.currentDigest(entry);
    let pending: ExtensionInfo["pending"] = null;
    if (entry.source === "studio" && !entry.confirmed.includes(digest)) {
      const cached = this.pendingAnalysis.get(id);
      pending = cached?.digest === digest ? cached : { digest, analysis: analyzePackage(entry.dir, manifest) };
      this.pendingAnalysis.set(id, pending);
    }
    return {
      id,
      namespace: namespaceOf(manifest),
      version: manifest.version,
      title: manifest.title,
      description: manifest.description,
      license: manifest.license,
      repository: manifest.repository,
      source: entry.source,
      tier: tierOf(entry),
      risk: riskOf(manifest),
      permissions: manifest.permissions,
      inject: [...manifest.inject, ...manifest.optional],
      authoredBy: manifest.authoredBy,
      dir: entry.dir,
      modified: entry.modified,
      autoUpdate: entry.autoUpdate,
      previousVersion: entry.previous?.version ?? null,
      pending,
      attestation: entry.attestation,
      full: manifest.context === "full" ? this.fullInfo(entry, manifest) : null,
      agentHooks: manifest.contributes.agentHooks ?? [],
      outOfRange: this.misses(manifest)
    };
  }

  /**
   * Turns an installed entry into a row cordis can load, refusing what the
   * rules say may not run. Files that changed since install still load — they
   * are on this person's machine — but the plugin loses its store standing.
   */
  async load(id: string): Promise<Plugin> {
    const entry = this.entry(id);
    const manifest = readManifest(entry.dir);
    const refused = this.outOfRange(manifest);
    if (refused) throw new ExtensionRefused(refused);
    const digest = packageDigest(entry.dir, manifest);
    if (entry.source === "studio" && !entry.confirmed.includes(digest)) throw new ExtensionRefused(`${id} changed since it was last confirmed; confirm the new build to load it`);
    if ((entry.source === "store" || entry.source === "file") && digest !== entry.digest && !entry.modified) {
      this.put({ ...entry, modified: true, autoUpdate: false, updatedAt: now() });
    }
    const languages = manifest.languages.map((language) => {
      try {
        return readLanguagePack(entry.dir, language);
      } catch (error) {
        throw new ExtensionRefused(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    const identity = identityOf(manifest, { root: entry.dir, dataDir: dataDirFor(this.config.root, id) });
    if (manifest.main === null) return adaptLanguagePacks(identity, languages);
    const url = `${pathToFileURL(path.join(entry.dir, manifest.main)).href}?v=${digest.slice(0, 16)}`;
    const mod = (await this.config.importer(url)) as { default?: unknown };
    if (manifest.context === "full") return this.fullPlugin(id, manifest, mod.default);
    if (!isSdkPlugin(mod.default)) throw new ExtensionRefused(`${id} does not export a plugin written with @tomradex/plugin-sdk's definePlugin`);
    return adaptSdkPlugin(mod.default, identity, languages);
  }

  /** A full-mode plugin is loaded as it is, like a row of the app's own; only what it writes is marked as its. */
  private fullPlugin(id: string, manifest: Manifest, candidate: unknown): Plugin {
    if (isSdkPlugin(candidate)) throw new ExtensionRefused(`${id} is written with definePlugin, which runs behind the SDK's facade; drop "context": "full" from its manifest`);
    const applicable = typeof candidate === "function" || (typeof candidate === "object" && candidate !== null && typeof (candidate as { apply?: unknown }).apply === "function");
    if (!applicable) throw new ExtensionRefused(`${id} runs in full mode, so its main exports a cordis plugin: a function, a class, or an object with apply()`);
    claimFullPlugin(candidate as object, namespaceOf(manifest));
    return candidate as Plugin;
  }

  /**
   * A `.tomrade-plugin` file: from the store, which lists the digest its
   * contents must have (and, for Tomrade's own plugins, an attestation), or
   * handed over by a person.
   */
  async installFile(file: string, opts: { source?: "store" | "file"; digest?: string; attestation?: unknown; vet?: (manifest: Manifest) => void } = {}): Promise<LockEntry> {
    const unpacked = await unpackPlugin(file);
    if (opts.source === "store" && unpacked.digest !== opts.digest) {
      fs.rmSync(unpacked.dir, { recursive: true, force: true });
      throw new ExtensionRefused(`${unpacked.manifest.id} ${unpacked.manifest.version} is not the build the store lists for it`);
    }
    const attestation = verifyAttestation(opts.attestation ?? unpacked.attestation, unpacked.digest, this.config.trustedKeys);
    if (this.has(unpacked.manifest.id) && ["folder", "studio"].includes(this.entry(unpacked.manifest.id).source)) {
      fs.rmSync(unpacked.dir, { recursive: true, force: true });
      throw new ExtensionRefused(`${unpacked.manifest.id} is loaded from a development folder here; remove it first`);
    }
    this.refuseClash(unpacked.manifest);
    try {
      opts.vet?.(unpacked.manifest);
    } catch (error) {
      fs.rmSync(unpacked.dir, { recursive: true, force: true });
      throw error;
    }
    const dir = placePackage(unpacked, this.config.root);
    const prior = this.has(unpacked.manifest.id) ? this.entry(unpacked.manifest.id) : null;
    return this.put({
      id: unpacked.manifest.id,
      version: unpacked.manifest.version,
      dir,
      digest: unpacked.digest,
      attestation,
      source: opts.source ?? (attestation ? "store" : "file"),
      disabled: prior?.disabled ?? false,
      previous: prior && prior.version !== unpacked.manifest.version ? { version: prior.version, dir: prior.dir, digest: prior.digest, attestation: prior.attestation } : (prior?.previous ?? null),
      confirmed: [],
      modified: false,
      autoUpdate: prior?.autoUpdate ?? attestation?.tier === "official",
      installedAt: prior?.installedAt ?? now(),
      updatedAt: now()
    });
  }

  /** A person's own directory, loaded as it stands and reloaded when its build changes. */
  addFolder(dir: string, source: "folder" | "studio" = "folder", vet?: (manifest: Manifest) => void): LockEntry {
    const manifest = readManifest(dir);
    if (this.has(manifest.id) && this.entry(manifest.id).dir !== dir) throw new ExtensionRefused(`${manifest.id} is already installed; remove it before loading a folder in its place`);
    this.refuseClash(manifest);
    vet?.(manifest);
    fs.mkdirSync(dataDirFor(this.config.root, manifest.id), { recursive: true });
    const prior = this.has(manifest.id) ? this.entry(manifest.id) : null;
    const entry = this.put({
      id: manifest.id,
      version: manifest.version,
      dir,
      digest: packageDigest(dir, manifest),
      attestation: null,
      source,
      disabled: prior?.disabled ?? false,
      previous: null,
      confirmed: prior?.confirmed ?? [],
      modified: false,
      autoUpdate: false,
      installedAt: prior?.installedAt ?? now(),
      updatedAt: now()
    });
    this.watch(entry);
    return entry;
  }

  /** Two extensions sharing a namespace would share tables and ids. */
  private refuseClash(manifest: Manifest): void {
    const ns = namespaceOf(manifest);
    for (const other of this.lock.plugins) {
      if (other.id === manifest.id) continue;
      try {
        if (namespaceOf(readManifest(other.dir)) === ns) throw new ExtensionRefused(`${manifest.id} uses the namespace "${ns}", which ${other.id} already has`);
      } catch (error) {
        if (error instanceof ExtensionRefused) throw error;
      }
    }
  }

  confirm(id: string, digest: string): LockEntry {
    const entry = this.entry(id);
    if (this.currentDigest(entry) !== digest) throw new ExtensionRefused(`${id} changed again while it was being looked at; review the latest build`);
    return this.put({ ...entry, confirmed: [...entry.confirmed.slice(-9), digest], digest, version: readManifest(entry.dir).version, updatedAt: now() });
  }

  setDisabled(id: string, disabled: boolean): void {
    this.put({ ...this.entry(id), disabled, updatedAt: now() });
  }

  setAutoUpdate(id: string, autoUpdate: boolean): void {
    this.put({ ...this.entry(id), autoUpdate, updatedAt: now() });
  }

  /** Whether this build believes an attestation for a digest, before anything is downloaded. */
  verify(raw: unknown, digest: string): Attestation | null {
    return verifyAttestation(raw, digest, this.config.trustedKeys);
  }

  /** Tomrade signed the installed build as official after it was installed. */
  setAttestation(id: string, raw: unknown): Attestation | null {
    const entry = this.entry(id);
    const attestation = verifyAttestation(raw, entry.digest, this.config.trustedKeys);
    if (attestation) this.put({ ...entry, attestation, updatedAt: now() });
    return attestation;
  }

  /** Back to the version before the last update; the newer one is removed. */
  rollback(id: string): LockEntry {
    const entry = this.entry(id);
    if (!entry.previous || !fs.existsSync(entry.previous.dir)) throw new Error(`${id} has no earlier version to go back to`);
    if (entry.dir !== entry.previous.dir) fs.rmSync(entry.dir, { recursive: true, force: true });
    return this.put({ ...entry, ...entry.previous, previous: null, modified: false, autoUpdate: false, updatedAt: now() });
  }

  uninstall(id: string, opts: { removeData?: boolean } = {}): void {
    const entry = this.entry(id);
    this.unwatch(id);
    if (entry.source === "store" || entry.source === "file") {
      for (const dir of [entry.dir, entry.previous?.dir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
    if (opts.removeData) fs.rmSync(dataDirFor(this.config.root, id), { recursive: true, force: true });
    this.lock = { v: 1, plugins: this.lock.plugins.filter((p) => p.id !== id) };
    this.save();
  }

  /** Watch every development folder; a rebuilt bundle reloads the row. */
  watchAll(): void {
    for (const entry of this.lock.plugins) this.watch(entry);
  }

  private watch(entry: LockEntry): void {
    if (entry.source !== "folder" && entry.source !== "studio") return;
    this.unwatch(entry.id);
    let main: string | undefined;
    try {
      const manifest = readManifest(entry.dir);
      // A plugin that is only languages changes where its words are.
      main = manifest.main ?? manifest.languages[0]?.file;
    } catch {
      // Loading reports a folder that lost its manifest; watching it must not stop the boot.
      return;
    }
    if (!main) return;
    const dist = path.dirname(path.join(entry.dir, main));
    if (!fs.existsSync(dist)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = this.currentDigest(entry);
    try {
      const watcher = fs.watch(dist, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const digest = this.currentDigest(this.entry(entry.id));
          if (digest && digest !== last) {
            last = digest;
            this.onChange(entry.id);
          }
        }, 300);
      });
      watcher.unref();
      this.watchers.set(entry.id, watcher);
    } catch {
      // A folder that cannot be watched still loads; it reloads by hand.
    }
  }

  private unwatch(id: string): void {
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
  }

  close(): void {
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }
}
