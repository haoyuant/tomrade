import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Service } from "cordis";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type {} from "@tomradex/github";
import type {} from "@tomradex/hub-cloud";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/settings";
import { ATTESTATION_FILE, LIMITS, PACKAGE_EXT, analyzePackage, observedRisk, packPlugin, readManifest, tierOf, unpackPlugin, type Finding, type TrustTier } from "@tomradex/plugin-kit";
import { SDK_CONTRACT, satisfies, type Manifest } from "@tomradex/plugin-sdk";
import type { Plugins, PluginsSnapshot } from "@tomradex/plugins";
import { linkGitHub } from "./oauth.js";
import { OFFICIAL_CATALOG_URL, OfficialCatalog, isOfficialId } from "./official.js";
import { githubAccess, prepareRelease, type GitHubAccess } from "./publish.js";
import { latestInstallable, planUpdate, revoked, type Revocation, type Tier, type UpdatePlan, type VersionRow } from "./rules.js";

export const CommunityConfig = z.preprocess(
  (v) => v ?? {},
  z.object({
    /** A mirror or CDN in front of the package bucket; the digest the store lists, not the host, is what is checked. */
    packagesBaseUrl: z.string().optional(),
    /** Tomrade's own plugins, released from its plugins repository; needs no cloud account. */
    officialCatalog: z.preprocess(
      (v) => v ?? {},
      z.object({
        /** A mirror may serve it elsewhere: what is trusted is each version's signature, not the host. */
        url: z.string().default(OFFICIAL_CATALOG_URL),
        cacheFile: z.string().optional(),
        freshMs: z.number().int().min(60_000).default(15 * 60_000)
      })
    ),
    /** Official plugins put on every machine once, the way the app's own were; one the person uninstalls stays gone. */
    starters: z.array(z.string()).default([]),
    /** Where the starters already put on are remembered; without it, only for this run. */
    startersFile: z.string().optional(),
    /** How often revocations and updates are checked while online. */
    checkEveryMs: z.number().int().min(60_000).default(6 * 3_600_000),
    /** The binary that runs a plugin's check as Node; defaults to the running one. */
    nodeBinary: z.string().default(process.execPath)
  })
);
export type CommunityConfig = z.infer<typeof CommunityConfig>;

export interface VersionSummary {
  version: string;
  /** The commit of the public repository this version was built from. */
  commit: string;
  tier: Tier;
  /** What the publisher's own check found; installing reads the package again. */
  risk: VersionRow["risk"];
  riskReasons: string[];
  listedAt: string | null;
  compatible: boolean;
  revoked: boolean;
}

/** `official`: Tomrade's own plugins repository; `community`: the store anyone publishes to. */
export type SourceName = "official" | "community";

export interface SourceStatus {
  name: SourceName;
  available: boolean;
  /** Official: when the catalog in use was fetched. */
  fetchedAt: number | null;
  /** The last fetch failed and an earlier copy is in use. */
  stale: boolean;
  error: string | null;
  /** `no-cloud`: Community is not part of this build, which is no failure. */
  reason: "no-cloud" | null;
}

/** Both sources in one answer: what each found, and how each one fared. */
export interface BrowseResult {
  /** Official first, then Community; an id appears once. */
  listings: Listing[];
  sources: SourceStatus[];
}

export interface Listing {
  source: SourceName;
  id: string;
  title: string;
  description: string;
  publisher: string;
  namespace: string;
  repository: string;
  license: string;
  downloads: number;
  forkOf: string | null;
  latest: VersionSummary | null;
  installed: { version: string; tier: TrustTier } | null;
}

export interface PluginDetail extends Listing {
  versions: VersionSummary[];
  manifest: Manifest | null;
}

/** One version as this machine read it before installing: nobody else reviewed it. */
export interface Inspection {
  id: string;
  version: string;
  tier: Tier;
  commit: string;
  repository: string;
  risk: "low" | "elevated" | "high";
  riskReasons: string[];
  findings: Finding[];
  inject: string[];
  hosts: string[];
}

export interface CommunityAccount {
  signedIn: boolean;
  email: string | null;
  /** The GitHub login Supabase has linked to this account. */
  github: string | null;
  publisher: string | null;
  /** A GitHub token is set in Settings → GitHub, which pushing needs. */
  githubToken: boolean;
}

export interface PublishedVersion {
  pluginId: string;
  version: string;
  status: string;
  tier: Tier;
  risk: VersionRow["risk"];
  listedAt: string | null;
}

export interface Published {
  id: string;
  version: string;
  repository: string;
  commit: string;
  digest: string;
}

declare module "cordis" {
  interface Context {
    community: Community;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "community.search": (query: { text?: string; sort?: SortKey; source?: SourceName }) => Listing[];
    "community.sources": () => SourceStatus[];
    "community.browse": (query: { text?: string; sort?: SortKey; officialOnly?: boolean }) => BrowseResult;
    "community.plugin": (id: string) => PluginDetail;
    "community.inspect": (id: string, version?: string) => Inspection;
    "community.install": (id: string, version?: string) => PluginsSnapshot;
    "community.updates": () => UpdatePlan[];
    "community.update": (id: string) => PluginsSnapshot;
    "community.revoked": () => { id: string; reason: string }[];
    "community.report": (id: string, version: string | null, reason: string, details: string) => void;
    "community.account": () => CommunityAccount;
    "community.linkGitHub": () => { url: string };
    "community.becomePublisher": () => CommunityAccount;
    "community.publish": (dir: string) => Published;
    "community.published": () => PublishedVersion[];
  }
  interface Broadcasts {
    "community.changed": () => void;
  }
}

export type SortKey = "downloads" | "updated" | "title";

const safeText = (text: string) => text.replace(/[^\p{L}\p{N}\s_./-]/gu, " ").trim().slice(0, 80);

const summarize = (v: VersionRow, revocations: Revocation[]): VersionSummary => ({
  version: v.version,
  commit: v.commit_sha,
  tier: v.tier,
  risk: v.risk,
  riskReasons: v.risk_reasons ?? [],
  listedAt: v.listed_at,
  compatible: !v.sdk_range || satisfies(SDK_CONTRACT, v.sdk_range),
  revoked: v.status === "revoked" || !!revoked(v.plugin_id, v.version, revocations)
});

/** Where listings, versions, revocations and packages come from. */
interface Source {
  name: SourceName;
  search(text: string, sort: SortKey): Promise<Record<string, unknown>[]>;
  plugin(id: string): Promise<Record<string, unknown> | null>;
  versions(ids: string[]): Promise<VersionRow[]>;
  revocations(): Promise<Revocation[]>;
  packageUrl(row: VersionRow): string;
  downloaded(id: string): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The store, as the app sees it: browse Tomrade's official plugins and
 * Community, read a version on this machine and install it, keep installed
 * plugins up to date within the rules, switch off what was revoked, report a
 * plugin, and publish one. Nobody reviews what Community lists: every plugin
 * is open source and its person judges it. What is installed must be the
 * exact build its source lists; an official one must carry Tomrade's signature.
 */
export class Community extends Service {
  static provide = "community";
  static inject = ["settings", "github"];
  static Config = CommunityConfig;

  private readonly home: Context;
  private revokedNow = new Map<string, string>();
  private startersSeen = new Set<string>();
  private publisherCache: string | null = null;
  /** Packages fetched to be read before installing, by digest; installing takes them from here. */
  private downloadDir: string | null = null;
  /** For tests: GitHub access other than through the connected account. */
  github: GitHubAccess;
  readonly official: OfficialCatalog;
  private readonly officialSource: Source;
  private readonly storeSource: Source;

  constructor(
    ctx: Context,
    public readonly config: CommunityConfig
  ) {
    super(ctx, "community");
    this.home = ctx;
    this.github = githubAccess(() => this.home.github.token());
    this.official = new OfficialCatalog({
      ...config.officialCatalog,
      verify: (raw, digest) => this.plugins.extensions!.verify(raw, digest),
      warn: (text) => this.home.logger.warn(text)
    });
    this.officialSource = this.officialFrom(this.official);
    this.storeSource = this.store();
  }

  [Service.init]() {
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("community.search", (q) => this.search(q));
      ctx.ipc.handle("community.sources", () => this.sources());
      ctx.ipc.handle("community.browse", (q) => this.browse(q));
      ctx.ipc.handle("community.plugin", (id) => this.plugin(id));
      ctx.ipc.handle("community.inspect", (id, version) => this.inspect(id, version));
      ctx.ipc.handle("community.install", (id, version) => this.install(id, version));
      ctx.ipc.handle("community.updates", () => this.updates());
      ctx.ipc.handle("community.update", (id) => this.update(id));
      ctx.ipc.handle("community.revoked", () => [...this.revokedNow].map(([id, reason]) => ({ id, reason })));
      ctx.ipc.handle("community.report", (id, version, reason, details) => this.report(id, version, reason, details));
      ctx.ipc.handle("community.account", () => this.account());
      ctx.ipc.handle("community.linkGitHub", async () => {
        const { url, done } = await linkGitHub(this.client);
        void done.then(
          () => this.changed(),
          (error: unknown) => this.home.logger.warn(`GitHub link: ${message(error)}`)
        );
        return { url };
      });
      ctx.ipc.handle("community.becomePublisher", () => this.becomePublisher());
      ctx.ipc.handle("community.publish", (dir) => this.publish(dir));
      ctx.ipc.handle("community.published", () => this.published());
    });
    const sweep = () => void this.sweep().catch((error: unknown) => this.home.logger.info(`community check skipped: ${message(error)}`));
    const first = setTimeout(sweep, 15_000);
    const every = setInterval(sweep, this.config.checkEveryMs);
    first.unref?.();
    every.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(every);
      if (this.downloadDir) fs.rmSync(this.downloadDir, { recursive: true, force: true });
    };
  }

  private get cloud(): { client: SupabaseClient } | undefined {
    return this.home.get("cloudHub") as { client: SupabaseClient } | undefined;
  }

  private get client(): SupabaseClient {
    const cloud = this.cloud;
    if (!cloud) throw new Error("Community needs Tomrade cloud, which this build does not have");
    return cloud.client;
  }

  private get plugins(): Plugins {
    const plugins = this.home.get("plugins") as Plugins | undefined;
    if (!plugins?.extensions) throw new Error("the plugin manager is not running");
    return plugins;
  }

  private changed() {
    this.home.get("ipc")?.send("community.changed");
  }

  private async rows<T>(query: PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
    const { data, error } = await query;
    if (error) throw new Error(`the store did not answer: ${error.message}`);
    return data ?? [];
  }

  private store(): Source {
    return {
      name: "community",
      search: (text, sort) => {
        let q = this.client.from("tomrade_plugins").select("*").eq("delisted", false);
        if (text) q = q.or(`title.ilike.%${text}%,description.ilike.%${text}%,id.ilike.%${text}%`);
        const order = sort === "title" ? "title" : sort === "updated" ? "updated_at" : "downloads";
        return this.rows<Record<string, unknown>>(q.order(order, { ascending: order === "title" }).limit(100));
      },
      plugin: async (id) => (await this.rows<Record<string, unknown>>(this.client.from("tomrade_plugins").select("*").eq("id", id).limit(1)))[0] ?? null,
      versions: (ids) => {
        if (!ids.length) return Promise.resolve([]);
        return this.rows<VersionRow>(this.client.from("tomrade_plugin_versions").select("*").in("plugin_id", ids).in("status", ["listed", "revoked"]));
      },
      revocations: () => this.rows<Revocation>(this.client.from("tomrade_plugin_revocations").select("plugin_id, versions, reason")),
      packageUrl: (row) => {
        if (this.config.packagesBaseUrl) return `${this.config.packagesBaseUrl.replace(/\/$/, "")}/${row.package_path}`;
        return this.client.storage.from("plugin-packages").getPublicUrl(row.package_path!).data.publicUrl;
      },
      downloaded: (id) => void this.client.rpc("tomrade_count_download", { p_plugin: id })
    };
  }

  private officialFrom(catalog: OfficialCatalog): Source {
    return {
      name: "official",
      search: async (text, sort) => {
        const needle = text.toLowerCase();
        const rows = (await catalog.plugins()).filter((p) => !needle || [p.title, p.description, p.id].some((f) => String(f).toLowerCase().includes(needle)));
        const byTitle = (a: Record<string, unknown>, b: Record<string, unknown>) => String(a.title).localeCompare(String(b.title));
        return rows.sort(sort === "updated" ? (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || byTitle(a, b) : byTitle);
      },
      plugin: async (id) => (await catalog.plugins()).find((p) => p.id === id) ?? null,
      versions: (ids) => catalog.versions(ids),
      revocations: () => catalog.revocations(),
      // The catalog resolved it to a full URL; the digest and signature are what is checked.
      packageUrl: (row) => row.package_path!,
      downloaded: () => undefined
    };
  }

  private source(name: SourceName): Source {
    return name === "official" ? this.officialSource : this.storeSource;
  }

  /** Only Tomrade's own publisher comes from the official catalog, and Community cannot list it. */
  private sourceFor(id: string): Source {
    return this.source(isOfficialId(id) ? "official" : "community");
  }

  sources(): SourceStatus[] {
    return [
      { name: "official", available: true, ...this.official.state(), reason: null },
      { name: "community", available: !!this.cloud, fetchedAt: null, stale: false, error: this.cloud ? null : "Community needs Tomrade cloud", reason: this.cloud ? null : "no-cloud" }
    ];
  }

  private installedOf(id: string): Listing["installed"] {
    const store = this.plugins.extensions!;
    if (!store.has(id)) return null;
    const entry = store.entry(id);
    return { version: entry.version, tier: tierOf(entry) };
  }

  async search(query: { text?: string; sort?: SortKey; source?: SourceName } = {}): Promise<Listing[]> {
    const source = this.source(query.source ?? "community");
    const plugins = await source.search(safeText(query.text ?? ""), query.sort ?? "downloads");
    const [versions, revocations] = await Promise.all([source.versions(plugins.map((p) => String(p.id))), source.revocations()]);
    return plugins.map((p) => this.listing(source.name, p, versions.filter((v) => v.plugin_id === p.id), revocations));
  }

  /** One search over Tomrade's own plugins and Community; one source that cannot answer leaves the other's results. */
  async browse(query: { text?: string; sort?: SortKey; officialOnly?: boolean } = {}): Promise<BrowseResult> {
    const names: SourceName[] = query.officialOnly ? ["official"] : ["official", "community"];
    const settled = await Promise.allSettled(names.map((source) => this.search({ text: query.text, sort: query.sort, source })));
    const seen = new Set<string>();
    const listings = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).filter((l) => !seen.has(l.id) && !!seen.add(l.id));
    const known = this.sources();
    const sources = names.map((name, i) => {
      const r = settled[i]!;
      const status = known.find((k) => k.name === name)!;
      return r.status === "fulfilled" ? { ...status, available: true } : { ...status, available: false, error: message(r.reason) };
    });
    return { listings, sources };
  }

  private listing(source: SourceName, p: Record<string, unknown>, versions: VersionRow[], revocations: Revocation[]): Listing {
    const latest = latestInstallable(versions, revocations) ?? versions.filter((v) => v.status === "listed").sort((a, b) => (a.version < b.version ? 1 : -1))[0] ?? null;
    return {
      source,
      id: String(p.id),
      title: String(p.title),
      description: String(p.description ?? ""),
      publisher: String(p.publisher),
      namespace: String(p.namespace),
      repository: String(p.repository),
      license: String(p.license),
      downloads: Number(p.downloads ?? 0),
      forkOf: (p.fork_of as string | null) ?? null,
      latest: latest ? summarize(latest, revocations) : null,
      installed: this.installedOf(String(p.id))
    };
  }

  async plugin(id: string): Promise<PluginDetail> {
    const source = this.sourceFor(id);
    const plugin = await source.plugin(id);
    if (!plugin) throw new Error(`${id} is not in the ${source.name === "official" ? "official catalog" : "store"}`);
    const [versions, revocations] = await Promise.all([source.versions([id]), source.revocations()]);
    const listing = this.listing(source.name, plugin, versions, revocations);
    const latest = versions.find((v) => v.version === listing.latest?.version) ?? null;
    return {
      ...listing,
      versions: versions.sort((a, b) => (a.version < b.version ? 1 : -1)).map((v) => summarize(v, revocations)),
      manifest: latest?.manifest ?? null
    };
  }

  /** Fetched once per digest: reading a version before installing it costs no second download. */
  private async download(row: VersionRow, source: Source): Promise<string> {
    if (!row.package_path || !row.digest) throw new Error(`${row.plugin_id} ${row.version} has no package`);
    this.downloadDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-download-"));
    const file = path.join(this.downloadDir, `${row.digest}${PACKAGE_EXT}`);
    if (fs.existsSync(file)) return file;
    const res = await fetch(source.packageUrl(row), { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`the package could not be downloaded (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > LIMITS.packageBytes) throw new Error("the package is larger than a plugin may be");
    fs.writeFileSync(`${file}.part`, bytes);
    fs.renameSync(`${file}.part`, file);
    return file;
  }

  private async pick(id: string, version?: string): Promise<{ row: VersionRow; source: Source }> {
    const source = this.sourceFor(id);
    const [versions, revocations] = await Promise.all([source.versions([id]), source.revocations()]);
    const row = version ? versions.find((v) => v.version === version && v.status === "listed") : latestInstallable(versions, revocations);
    if (!row) throw new Error(version ? `${id} ${version} is not available` : `${id} has no version this Tomrade can run`);
    if (revoked(id, row.version, revocations)) throw new Error(`${id} ${row.version} was revoked by the store`);
    return { row, source };
  }

  /** Reads the exact package that would be installed, here, with the same analyzer the publisher ran. */
  async inspect(id: string, version?: string): Promise<Inspection> {
    const { row, source } = await this.pick(id, version);
    const unpacked = await unpackPlugin(await this.download(row, source));
    try {
      if (unpacked.digest !== row.digest) throw new Error(`${id} ${row.version} is not the build the store lists for it`);
      const m = unpacked.manifest;
      const analysis = analyzePackage(unpacked.dir, m);
      const risk = observedRisk(analysis.observed, m);
      return {
        id,
        version: row.version,
        tier: row.tier,
        commit: row.commit_sha,
        repository: m.repository ?? "",
        risk: risk.level,
        riskReasons: risk.reasons,
        findings: analysis.findings.filter((f) => f.severity !== "info"),
        inject: [...m.inject, ...m.optional],
        hosts: m.permissions.network
      };
    } finally {
      fs.rmSync(unpacked.dir, { recursive: true, force: true });
    }
  }

  private async installVersion(row: VersionRow, source: Source): Promise<PluginsSnapshot> {
    const file = await this.download(row, source);
    try {
      const snapshot = await this.plugins.installFile(file, { source: "store", digest: row.digest!, attestation: row.attestation ?? undefined });
      source.downloaded(row.plugin_id);
      this.changed();
      return snapshot;
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  async install(id: string, version?: string): Promise<PluginsSnapshot> {
    const { row, source } = await this.pick(id, version);
    return this.installVersion(row, source);
  }

  private installedFromStore() {
    const store = this.plugins.extensions!;
    return store
      .entries()
      .filter((e) => e.source === "store")
      .map((e) => {
        let manifest: Manifest | null = null;
        try {
          manifest = readManifest(e.dir);
        } catch {
          // A copy that no longer reads is still listed; it just cannot be compared.
        }
        return { id: e.id, version: e.version, tier: tierOf(e), autoUpdate: e.autoUpdate, manifest };
      });
  }

  /** Each source on its own: one that cannot be reached leaves the other's plugins checked. */
  private async perSource<T>(ids: string[], read: (source: Source, ids: string[]) => Promise<T>): Promise<{ source: Source; ids: string[]; result: T }[]> {
    const groups = (["official", "community"] as const).map((name) => ({ source: this.source(name), ids: ids.filter((id) => this.sourceFor(id).name === name) })).filter((g) => g.ids.length);
    const settled = await Promise.allSettled(groups.map((g) => read(g.source, g.ids)));
    const ok = groups.flatMap((g, i) => (settled[i]!.status === "fulfilled" ? [{ ...g, result: (settled[i] as PromiseFulfilledResult<T>).value }] : []));
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed && !ok.length) throw failed.reason;
    return ok;
  }

  async updates(): Promise<UpdatePlan[]> {
    const installed = this.installedFromStore();
    const read = await this.perSource(
      installed.map((i) => i.id),
      async (source, ids) => {
        const [versions, revocations] = await Promise.all([source.versions(ids), source.revocations()]);
        return installed.filter((e) => ids.includes(e.id)).flatMap((entry) => planUpdate(entry, versions.filter((v) => v.plugin_id === entry.id), revocations) ?? []);
      }
    );
    return read.flatMap((r) => r.result);
  }

  async update(id: string): Promise<PluginsSnapshot> {
    const plan = (await this.updates()).find((u) => u.id === id);
    if (!plan) throw new Error(`${id} is up to date`);
    return this.installVersion(plan.to, this.sourceFor(id));
  }

  private startersPut(): Set<string> {
    if (!this.config.startersFile) return this.startersSeen;
    try {
      return new Set(JSON.parse(fs.readFileSync(this.config.startersFile, "utf8")) as string[]);
    } catch {
      return new Set();
    }
  }

  /** Each starter goes on once; one that cannot be fetched yet is tried again at the next check. */
  async installStarters(): Promise<void> {
    const put = this.startersPut();
    const installed = new Set(this.plugins.extensions!.entries().map((e) => e.id));
    for (const id of this.config.starters.filter((id) => !put.has(id))) {
      if (!installed.has(id)) {
        try {
          await this.install(id);
        } catch (error) {
          this.home.logger.info(`${id} is not installed yet: ${message(error)}`);
          continue;
        }
      }
      put.add(id);
      this.startersSeen = put;
      if (this.config.startersFile) fs.writeFileSync(this.config.startersFile, JSON.stringify([...put]));
    }
  }

  /** Revocations switch a plugin off; updates the rules allow land by themselves. */
  async sweep(): Promise<void> {
    this.official.expire();
    await this.installStarters();
    const store = this.plugins.extensions!;
    const entries = store.entries();
    const read = await this.perSource(
      entries.map((e) => e.id),
      (source) => source.revocations()
    );
    // A source that could not be reached keeps what it said last time.
    const checked = new Set(read.flatMap((r) => r.ids));
    const now = new Map([...this.revokedNow].filter(([id]) => !checked.has(id)));
    for (const { ids, result } of read) {
      for (const entry of entries.filter((e) => ids.includes(e.id))) {
        const hit = revoked(entry.id, entry.version, result);
        if (!hit) continue;
        now.set(entry.id, hit.reason);
        if (!entry.disabled) await this.plugins.setEnabled(entry.id, false).catch(() => undefined);
      }
    }
    this.revokedNow = now;
    for (const plan of await this.updates().catch(() => [])) {
      if (plan.automatic && !now.has(plan.id)) await this.installVersion(plan.to, this.sourceFor(plan.id)).catch((error: unknown) => this.home.logger.warn(`update ${plan.id}: ${message(error)}`));
    }
    this.changed();
  }

  async report(id: string, version: string | null, reason: string, details: string): Promise<void> {
    const { error } = await this.client.rpc("tomrade_report_plugin", { p_plugin: id, p_version: version, p_reason: reason, p_details: details });
    if (error) throw new Error(error.message);
  }

  async account(): Promise<CommunityAccount> {
    const { data } = await this.client.auth.getUser();
    const user = data?.user ?? null;
    const identity = user?.identities?.find((i) => i.provider === "github");
    let publisher: string | null = null;
    if (user) {
      const rows = await this.rows<{ github_login: string }>(this.client.from("tomrade_publishers").select("github_login").eq("user_id", user.id).limit(1)).catch(() => []);
      publisher = rows[0]?.github_login ?? null;
    }
    this.publisherCache = publisher;
    const token = await this.home.github.token();
    return {
      signedIn: !!user,
      email: user?.email ?? null,
      github: identity ? String((identity.identity_data as Record<string, unknown> | undefined)?.user_name ?? "").toLowerCase() || null : null,
      publisher,
      githubToken: !!token
    };
  }

  /** The login a new plugin is published under, once this account has become a publisher. */
  publisherLogin(): string | null {
    return this.publisherCache;
  }

  async becomePublisher(): Promise<CommunityAccount> {
    const { error } = await this.client.rpc("tomrade_become_publisher");
    if (error) throw new Error(error.message);
    this.changed();
    return this.account();
  }

  /**
   * The source goes to the publisher's public repository first; the package
   * is the check's build of that same tree, uploaded under the publisher's
   * login and listed at once.
   */
  async publish(dir: string): Promise<Published> {
    const account = await this.account();
    if (!account.signedIn) throw new Error("Sign in to your Tomrade account first");
    if (!account.publisher) throw new Error("Link GitHub and become a publisher first");
    const store = this.plugins.extensions!;
    const before = readManifest(dir).id;
    const release = await prepareRelease(dir, account.publisher, this.github, { checkOptions: { execPath: this.config.nodeBinary } });
    fs.rmSync(path.join(dir, ATTESTATION_FILE), { force: true });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-publish-"));
    let digest: string;
    try {
      const packed = await packPlugin(dir, path.join(work, `package${PACKAGE_EXT}`));
      digest = packed.digest;
      const risk = observedRisk((release.report.analysis ?? analyzePackage(dir, packed.manifest)).observed, packed.manifest);
      const packagePath = `${release.id}/${release.version}/${digest}${PACKAGE_EXT}`;
      const bytes = fs.readFileSync(packed.file);
      const upload = await this.client.storage.from("plugin-packages").upload(packagePath, bytes, { contentType: "application/gzip", upsert: false });
      // The path names the digest, so what is already there is this same build: a retry after a failed listing.
      if (upload.error && !/exists/i.test(upload.error.message)) throw new Error(`the package could not be uploaded: ${upload.error.message}`);
      const { error } = await this.client.rpc("tomrade_publish_plugin", {
        p_manifest: release.manifest,
        p_repository: release.repository,
        p_commit: release.commit,
        p_tag: release.tag,
        p_digest: digest,
        p_package_path: packagePath,
        p_package_size: bytes.length,
        p_risk: risk.level,
        p_risk_reasons: risk.reasons
      });
      if (error) throw new Error(error.message);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    // A plugin that changed id is a new row: the old one goes, and the new build waits to be confirmed again.
    if (release.renamedFrom && store.has(before)) {
      const source = store.entry(before).source;
      await this.plugins.uninstall(before);
      if (source === "studio" || source === "folder") await this.plugins.addFolder(dir, source);
    }
    this.changed();
    return { id: release.id, version: release.version, repository: release.repository, commit: release.commit, digest };
  }

  async published(): Promise<PublishedVersion[]> {
    const { data } = await this.client.auth.getUser();
    if (!data?.user) return [];
    const rows = await this.rows<VersionRow>(this.client.from("tomrade_plugin_versions").select("*").eq("submitted_by", data.user.id).order("submitted_at", { ascending: false }).limit(50));
    return rows.map((v) => ({ pluginId: v.plugin_id, version: v.version, status: v.status, tier: v.tier, risk: v.risk, listedAt: v.listed_at }));
  }
}

export default Community;
