import fs from "node:fs";
import path from "node:path";
import { LIMITS, PACKAGE_EXT, parseCatalog, unpackPlugin, type Attestation, type Catalog, type CatalogPlugin } from "@tomradex/plugin-kit";
import { OFFICIAL_PUBLISHER, compareVersions, nameOf, namespaceOf, parseManifest } from "@tomradex/plugin-sdk";
import type { Manifest } from "@tomradex/plugin-sdk";
import { latestInstallable, type Revocation, type VersionRow } from "./rules.js";
import { errorMessage, writeJsonAtomic } from "@tomradex/contracts";

/** Where Tomrade's own plugins are released: github.com/haoyuant/tomrade-plugins. */
export const OFFICIAL_CATALOG_URL = "https://github.com/haoyuant/tomrade-plugins/releases/download/catalog/catalog.json";

const CATALOG_BYTES = 5 * 1024 * 1024;
const RETRY_MS = 60_000;

export const isOfficialId = (id: string): boolean => id.startsWith(`${OFFICIAL_PUBLISHER}/`);

/** A bundle the app carries: the catalog it was built against, in the cache's shape, beside each package named for its digest. */
export const BUNDLE_CATALOG = "catalog.json";
export const bundledPackage = (dir: string, digest: string): string => path.join(dir, `${digest}${PACKAGE_EXT}`);

export interface CatalogState {
  /** When the catalog in use was fetched; null when there is none yet. */
  fetchedAt: number | null;
  /** The last fetch failed and an earlier copy is in use. */
  stale: boolean;
  error: string | null;
}

export interface OfficialCatalogOptions {
  url: string;
  /** Where the last good catalog is kept, so a machine offline still lists what it saw. */
  cacheFile?: string;
  /** The catalog the app was built against, in the cache's shape: used offline when no newer copy is kept. */
  bundleFile?: string;
  /** How long a fetched catalog is used before it is fetched again. */
  freshMs: number;
  /** Whether this build believes an attestation for a digest. */
  verify(raw: unknown, digest: string): Attestation | null;
  warn(message: string): void;
}

interface Held {
  catalog: Catalog;
  fetchedAt: number;
}


/**
 * The official catalog as rows the store client already understands. Only
 * `tomrade/*` plugins come from here, and only versions whose attestation this
 * build verifies for the exact digest, id and version listed.
 */
export class OfficialCatalog {
  private held: Held | null = null;
  private nextFetchAt = 0;
  private loading: Promise<void> | null = null;
  private error: string | null = null;

  constructor(private readonly opts: OfficialCatalogOptions) {}

  state(): CatalogState {
    return { fetchedAt: this.held?.fetchedAt ?? null, stale: !!this.held && !!this.error, error: this.error };
  }

  /** The next read fetches again, for the periodic check. */
  expire(): void {
    this.nextFetchAt = 0;
  }

  /** The catalog to use now: the last good one when a fetch fails, and an error only when there never was one. */
  async read(): Promise<Catalog> {
    if (Date.now() >= this.nextFetchAt) {
      this.loading ??= this.fetch().finally(() => (this.loading = null));
      await this.loading;
    }
    if (!this.held) throw new Error(`the official catalog is unavailable: ${this.error ?? "not fetched yet"}`);
    return this.held.catalog;
  }

  private async fetch(): Promise<void> {
    try {
      const res = await fetch(this.opts.url, { signal: AbortSignal.timeout(30_000), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`the official catalog did not answer (${res.status})`);
      const text = await res.text();
      if (text.length > CATALOG_BYTES) throw new Error("the official catalog is larger than it may be");
      const raw: unknown = JSON.parse(text);
      const { catalog, dropped } = parseCatalog(raw);
      if (dropped.length) this.opts.warn(`official catalog: skipped ${dropped.join(", ")}`);
      this.held = { catalog, fetchedAt: Date.now() };
      this.error = null;
      this.nextFetchAt = Date.now() + this.opts.freshMs;
      this.save(raw);
    } catch (error) {
      this.error = errorMessage(error);
      // A cache from before an upgrade may lack what the new build's starters need.
      this.held ??= [this.copy(this.opts.cacheFile), this.copy(this.opts.bundleFile)].filter((h) => !!h).sort((a, b) => b.fetchedAt - a.fetchedAt)[0] ?? null;
      this.nextFetchAt = Date.now() + RETRY_MS;
    }
  }

  private save(raw: unknown) {
    if (!this.opts.cacheFile) return;
    try {
      writeJsonAtomic(this.opts.cacheFile, { fetchedAt: this.held!.fetchedAt, catalog: raw }, { pretty: false, perProcess: true });
    } catch (error) {
      this.opts.warn(`official catalog cache not written: ${errorMessage(error)}`);
    }
  }

  private copy(file: string | undefined): Held | null {
    if (!file || !fs.existsSync(file)) return null;
    try {
      const { fetchedAt, catalog } = JSON.parse(fs.readFileSync(file, "utf8")) as { fetchedAt: number; catalog: unknown };
      return { catalog: parseCatalog(catalog).catalog, fetchedAt: Number(fetchedAt) || 0 };
    } catch {
      return null;
    }
  }

  private trusted(plugin: CatalogPlugin): VersionRow[] {
    if (!isOfficialId(plugin.id)) return [];
    return plugin.versions.flatMap((v) => {
      const attestation = this.opts.verify(v.attestation, v.digest);
      if (!attestation || attestation.id !== plugin.id || attestation.version !== v.version) return [];
      let manifest: Manifest;
      try {
        manifest = parseManifest(v.manifest);
      } catch {
        return [];
      }
      if (manifest.id !== plugin.id || manifest.version !== v.version) return [];
      let url: URL;
      try {
        url = new URL(v.url, this.opts.url);
      } catch {
        return [];
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") return [];
      return [
        {
          plugin_id: plugin.id,
          version: v.version,
          commit_sha: v.commit,
          tag: null,
          status: "listed",
          tier: "official",
          risk: v.risk,
          risk_reasons: v.riskReasons,
          sdk_range: v.sdkRange,
          manifest,
          digest: v.digest,
          attestation,
          package_path: url.href,
          package_size: v.size,
          listed_at: v.releasedAt
        }
      ];
    });
  }

  /** Plugins with at least one version this build trusts, as store rows. */
  async plugins(): Promise<Record<string, unknown>[]> {
    const catalog = await this.read();
    return catalog.plugins.flatMap((p) => {
      const versions = this.trusted(p);
      if (!versions.length) return [];
      const latest = [...versions].sort((a, b) => compareVersions(b.version, a.version))[0]!;
      return [
        {
          id: p.id,
          title: p.title,
          description: p.description,
          icon: p.icon ?? null,
          publisher: OFFICIAL_PUBLISHER,
          namespace: latest.manifest ? namespaceOf(latest.manifest) : nameOf(p.id),
          repository: p.repository,
          license: p.license,
          downloads: 0,
          fork_of: null,
          updated_at: versions.map((v) => v.listed_at ?? "").sort().at(-1) ?? ""
        }
      ];
    });
  }

  /** What the app carries, read without the network: the versions of these plugins and the revocations the bundled catalog lists. */
  carried(ids: string[]): { versions: VersionRow[]; revocations: Revocation[] } | null {
    const held = this.copy(this.opts.bundleFile);
    if (!held) return null;
    return {
      versions: held.catalog.plugins.filter((p) => ids.includes(p.id)).flatMap((p) => this.trusted(p)),
      revocations: held.catalog.revoked.filter((r) => isOfficialId(r.id)).map((r) => ({ plugin_id: r.id, versions: r.versions, reason: r.reason }))
    };
  }

  async versions(ids: string[]): Promise<VersionRow[]> {
    const catalog = await this.read();
    return catalog.plugins.filter((p) => ids.includes(p.id)).flatMap((p) => this.trusted(p));
  }

  async revocations(): Promise<Revocation[]> {
    const catalog = await this.read();
    return catalog.revoked.filter((r) => isOfficialId(r.id)).map((r) => ({ plugin_id: r.id, versions: r.versions, reason: r.reason }));
  }
}

/**
 * What a build carries for a machine that cannot reach the catalog: the catalog as it stands, and the version of
 * each plugin named that this Tomrade would install, downloaded and checked as an install checks it. Throws when
 * one cannot be had, so a build never goes out without it.
 */
export async function bundleOfficialPlugins(opts: { url: string; ids: string[]; dir: string; verify(raw: unknown, digest: string): Attestation | null }): Promise<{ id: string; version: string; digest: string }[]> {
  fs.rmSync(opts.dir, { recursive: true, force: true });
  fs.mkdirSync(opts.dir, { recursive: true });
  const skipped: string[] = [];
  const catalog = new OfficialCatalog({ url: opts.url, cacheFile: path.join(opts.dir, BUNDLE_CATALOG), freshMs: 60_000, verify: opts.verify, warn: (text) => skipped.push(text) });
  const problems: string[] = [];
  const bundled: { id: string; version: string; digest: string }[] = [];
  try {
    const [versions, revocations] = await Promise.all([catalog.versions(opts.ids), catalog.revocations()]);
    for (const id of opts.ids) {
      const row = latestInstallable(versions.filter((v) => v.plugin_id === id), revocations);
      if (!row) {
        problems.push(`${id}: the catalog has no version this Tomrade can install`);
        continue;
      }
      const file = bundledPackage(opts.dir, row.digest!);
      try {
        const res = await fetch(row.package_path!, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`the package could not be downloaded (${res.status})`);
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length > LIMITS.packageBytes) throw new Error("the package is larger than a plugin may be");
        fs.writeFileSync(file, bytes);
        const unpacked = await unpackPlugin(file);
        fs.rmSync(unpacked.dir, { recursive: true, force: true });
        if (unpacked.digest !== row.digest) throw new Error("the package is not the build the catalog lists");
        bundled.push({ id, version: row.version, digest: row.digest! });
      } catch (error) {
        problems.push(`${id} ${row.version}: ${errorMessage(error)}`);
      }
    }
  } catch (error) {
    problems.push(errorMessage(error));
  }
  if (problems.length) {
    fs.rmSync(opts.dir, { recursive: true, force: true });
    throw new Error([...problems, ...skipped].join("\n"));
  }
  return bundled;
}
