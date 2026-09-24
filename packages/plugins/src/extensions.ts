import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "cordis";
import { adaptSdkPlugin, identityOf } from "@tomrade/extensions";
import { SDK_CONTRACT, isSdkPlugin, namespaceOf, riskOf, satisfies, type Manifest, type Risk } from "@tomrade/plugin-sdk";
import {
  analyzePackage,
  dataDirFor,
  packageDigest,
  placePackage,
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
} from "@tomrade/plugin-kit";

export interface ExtensionStoreConfig {
  /** `~/Tomrade/plugins`: installed versions and each plugin's data. */
  root: string;
  lockFile: string;
  /** keyId → public key PEM: whose attestations this build believes. */
  trustedKeys: Record<string, string>;
  /** The host's own `import()`, so a plugin's bare imports resolve the host's way. */
  importer(url: string): Promise<unknown>;
}

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
  previousVersion: string | null;
  /** A studio build nobody has confirmed yet: its digest and what the analyzer found in it. */
  pending: { digest: string; analysis: Analysis } | null;
  attestation: Attestation | null;
}

export class ExtensionRefused extends Error {
  override name = "ExtensionRefused";
}

const now = () => Date.now();

/**
 * The installed extensions and the rules for loading one: the files must be
 * the ones installed, the code must be an SDK plugin the host's contract
 * satisfies, and an agent's build loads only at a digest a person confirmed.
 */
export class ExtensionStore {
  private lock: Lock;
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly pendingAnalysis = new Map<string, { digest: string; analysis: Analysis }>();
  onChange: (id: string) => void = () => {};

  constructor(private readonly config: ExtensionStoreConfig) {
    this.lock = readLock(config.lockFile);
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
      previousVersion: entry.previous?.version ?? null,
      pending,
      attestation: entry.attestation
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
    if (!satisfies(SDK_CONTRACT, manifest.engines.sdk)) throw new ExtensionRefused(`${id} needs plugin SDK ${manifest.engines.sdk}; this Tomrade provides ${SDK_CONTRACT}`);
    const digest = packageDigest(entry.dir, manifest);
    if (entry.source === "studio" && !entry.confirmed.includes(digest)) throw new ExtensionRefused(`${id} changed since it was last confirmed; confirm the new build to load it`);
    if ((entry.source === "store" || entry.source === "file") && digest !== entry.digest && !entry.modified) {
      this.put({ ...entry, modified: true, autoUpdate: false, updatedAt: now() });
    }
    const url = `${pathToFileURL(path.join(entry.dir, manifest.main)).href}?v=${digest.slice(0, 16)}`;
    const mod = (await this.config.importer(url)) as { default?: unknown };
    if (!isSdkPlugin(mod.default)) throw new ExtensionRefused(`${id} does not export a plugin written with @tomrade/plugin-sdk's definePlugin`);
    return adaptSdkPlugin(mod.default, identityOf(manifest, { root: entry.dir, dataDir: dataDirFor(this.config.root, id) }));
  }

  /** A `.tomrade-plugin` file: from the store (with its attestation) or handed over by a person. */
  async installFile(file: string, opts: { source?: "store" | "file"; attestation?: unknown } = {}): Promise<LockEntry> {
    const unpacked = await unpackPlugin(file);
    const attestation = verifyAttestation(opts.attestation ?? unpacked.attestation, unpacked.digest, this.config.trustedKeys);
    if (opts.source === "store" && !attestation) {
      fs.rmSync(unpacked.dir, { recursive: true, force: true });
      throw new ExtensionRefused(`${unpacked.manifest.id} ${unpacked.manifest.version} came from the store without a valid attestation for its contents`);
    }
    if (this.has(unpacked.manifest.id) && ["folder", "studio"].includes(this.entry(unpacked.manifest.id).source)) {
      fs.rmSync(unpacked.dir, { recursive: true, force: true });
      throw new ExtensionRefused(`${unpacked.manifest.id} is loaded from a development folder here; remove it first`);
    }
    this.refuseClash(unpacked.manifest);
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
  addFolder(dir: string, source: "folder" | "studio" = "folder"): LockEntry {
    const manifest = readManifest(dir);
    if (this.has(manifest.id) && this.entry(manifest.id).dir !== dir) throw new ExtensionRefused(`${manifest.id} is already installed; remove it before loading a folder in its place`);
    this.refuseClash(manifest);
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

  /** The store re-vouched for the installed build (an official review landed, say). */
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
    const dist = path.dirname(path.join(entry.dir, readManifest(entry.dir).main));
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
