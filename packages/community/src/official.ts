import fs from "node:fs";
import path from "node:path";
import { parseCatalog, type Attestation, type Catalog, type CatalogPlugin } from "@tomradex/plugin-kit";
import { OFFICIAL_PUBLISHER, compareVersions, nameOf } from "@tomradex/plugin-sdk";
import type { Manifest } from "@tomradex/plugin-sdk";
import type { Revocation, VersionRow } from "./rules.js";

/** Where Tomrade's own plugins are released: github.com/haoyuant/tomrade-plugins. */
export const OFFICIAL_CATALOG_URL = "https://github.com/haoyuant/tomrade-plugins/releases/download/catalog/catalog.json";

const CATALOG_BYTES = 5 * 1024 * 1024;
const RETRY_MS = 60_000;

export const isOfficialId = (id: string): boolean => id.startsWith(`${OFFICIAL_PUBLISHER}/`);

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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
      this.error = message(error);
      this.held ??= this.cached();
      this.nextFetchAt = Date.now() + RETRY_MS;
    }
  }

  private save(raw: unknown) {
    if (!this.opts.cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(this.opts.cacheFile), { recursive: true });
      const tmp = `${this.opts.cacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: this.held!.fetchedAt, catalog: raw }));
      fs.renameSync(tmp, this.opts.cacheFile);
    } catch (error) {
      this.opts.warn(`official catalog cache not written: ${message(error)}`);
    }
  }

  private cached(): Held | null {
    if (!this.opts.cacheFile || !fs.existsSync(this.opts.cacheFile)) return null;
    try {
      const { fetchedAt, catalog } = JSON.parse(fs.readFileSync(this.opts.cacheFile, "utf8")) as { fetchedAt: number; catalog: unknown };
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
      if (v.manifest.id !== plugin.id || v.manifest.version !== v.version) return [];
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
          manifest: v.manifest as unknown as Manifest,
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
          namespace: (latest.manifest?.namespace as string | undefined) ?? nameOf(p.id).replace(/-/g, "_"),
          repository: p.repository,
          license: p.license,
          downloads: 0,
          fork_of: null,
          updated_at: versions.map((v) => v.listed_at ?? "").sort().at(-1) ?? ""
        }
      ];
    });
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
