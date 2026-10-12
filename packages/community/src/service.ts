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
import { githubAccess, prepareRelease, type GitHubAccess } from "./publish.js";
import { latestInstallable, planUpdate, revoked, type Revocation, type Tier, type UpdatePlan, type VersionRow } from "./rules.js";

export const CommunityConfig = z.preprocess(
  (v) => v ?? {},
  z.object({
    /** A mirror or CDN in front of the package bucket; the digest the store lists, not the host, is what is checked. */
    packagesBaseUrl: z.string().optional(),
    /** How often revocations and updates are checked while online. */
    checkEveryMs: z.number().int().min(60_000).default(6 * 3_600_000)
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

export interface Listing {
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
    "community.search": (query: { text?: string; sort?: "downloads" | "updated" | "title" }) => Listing[];
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

/**
 * The store, as the app sees it: browse Community, read a version on this
 * machine and install it, keep installed plugins up to date within the rules,
 * switch off what the store revoked, report a plugin, and publish one. Nobody
 * reviews what is listed: every plugin is open source and its person judges
 * it. What is installed must be the exact build the store lists.
 */
export class Community extends Service {
  static provide = "community";
  static inject = ["cloudHub", "settings", "github"];
  static Config = CommunityConfig;

  private readonly home: Context;
  private revokedNow = new Map<string, string>();
  private publisherCache: string | null = null;
  /** Packages fetched to be read before installing, by digest; installing takes them from here. */
  private downloadDir: string | null = null;
  /** For tests: GitHub access other than through the connected account. */
  github: GitHubAccess;

  constructor(
    ctx: Context,
    public readonly config: CommunityConfig
  ) {
    super(ctx, "community");
    this.home = ctx;
    this.github = githubAccess(() => this.home.github.token());
  }

  [Service.init]() {
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("community.search", (q) => this.search(q));
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
          (error: unknown) => this.home.logger.warn(`GitHub link: ${error instanceof Error ? error.message : String(error)}`)
        );
        return { url };
      });
      ctx.ipc.handle("community.becomePublisher", () => this.becomePublisher());
      ctx.ipc.handle("community.publish", (dir) => this.publish(dir));
      ctx.ipc.handle("community.published", () => this.published());
    });
    const sweep = () => void this.sweep().catch((error: unknown) => this.home.logger.info(`community check skipped: ${error instanceof Error ? error.message : String(error)}`));
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

  private get client(): SupabaseClient {
    return this.home.cloudHub.client;
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

  private revocations(): Promise<Revocation[]> {
    return this.rows<Revocation>(this.client.from("tomrade_plugin_revocations").select("plugin_id, versions, reason"));
  }

  private versionsOf(ids: string[]): Promise<VersionRow[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.rows<VersionRow>(this.client.from("tomrade_plugin_versions").select("*").in("plugin_id", ids).in("status", ["listed", "revoked"]));
  }

  private installedOf(id: string): Listing["installed"] {
    const store = this.plugins.extensions!;
    if (!store.has(id)) return null;
    const entry = store.entry(id);
    return { version: entry.version, tier: tierOf(entry) };
  }

  async search(query: { text?: string; sort?: "downloads" | "updated" | "title" } = {}): Promise<Listing[]> {
    let q = this.client.from("tomrade_plugins").select("*").eq("delisted", false);
    const text = safeText(query.text ?? "");
    if (text) q = q.or(`title.ilike.%${text}%,description.ilike.%${text}%,id.ilike.%${text}%`);
    const order = query.sort === "title" ? "title" : query.sort === "updated" ? "updated_at" : "downloads";
    const plugins = await this.rows<Record<string, unknown>>(q.order(order, { ascending: order === "title" }).limit(100));
    const [versions, revocations] = await Promise.all([this.versionsOf(plugins.map((p) => String(p.id))), this.revocations()]);
    return plugins.map((p) => this.listing(p, versions.filter((v) => v.plugin_id === p.id), revocations));
  }

  private listing(p: Record<string, unknown>, versions: VersionRow[], revocations: Revocation[]): Listing {
    const latest = latestInstallable(versions, revocations) ?? versions.filter((v) => v.status === "listed").sort((a, b) => (a.version < b.version ? 1 : -1))[0] ?? null;
    return {
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
    const [plugin] = await this.rows<Record<string, unknown>>(this.client.from("tomrade_plugins").select("*").eq("id", id).limit(1));
    if (!plugin) throw new Error(`${id} is not in the store`);
    const [versions, revocations] = await Promise.all([this.versionsOf([id]), this.revocations()]);
    const listing = this.listing(plugin, versions, revocations);
    const latest = versions.find((v) => v.version === listing.latest?.version) ?? null;
    return {
      ...listing,
      versions: versions.sort((a, b) => (a.version < b.version ? 1 : -1)).map((v) => summarize(v, revocations)),
      manifest: latest?.manifest ?? null
    };
  }

  private packageUrl(pathInBucket: string): string {
    if (this.config.packagesBaseUrl) return `${this.config.packagesBaseUrl.replace(/\/$/, "")}/${pathInBucket}`;
    return this.client.storage.from("plugin-packages").getPublicUrl(pathInBucket).data.publicUrl;
  }

  /** Fetched once per digest: reading a version before installing it costs no second download. */
  private async download(row: VersionRow): Promise<string> {
    if (!row.package_path || !row.digest) throw new Error(`${row.plugin_id} ${row.version} has no package`);
    this.downloadDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-download-"));
    const file = path.join(this.downloadDir, `${row.digest}${PACKAGE_EXT}`);
    if (fs.existsSync(file)) return file;
    const res = await fetch(this.packageUrl(row.package_path), { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`the package could not be downloaded (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > LIMITS.packageBytes) throw new Error("the package is larger than a plugin may be");
    fs.writeFileSync(`${file}.part`, bytes);
    fs.renameSync(`${file}.part`, file);
    return file;
  }

  private async pick(id: string, version?: string): Promise<VersionRow> {
    const [versions, revocations] = await Promise.all([this.versionsOf([id]), this.revocations()]);
    const row = version ? versions.find((v) => v.version === version && v.status === "listed") : latestInstallable(versions, revocations);
    if (!row) throw new Error(version ? `${id} ${version} is not available` : `${id} has no version this Tomrade can run`);
    if (revoked(id, row.version, revocations)) throw new Error(`${id} ${row.version} was revoked by the store`);
    return row;
  }

  /** Reads the exact package that would be installed, here, with the same analyzer the publisher ran. */
  async inspect(id: string, version?: string): Promise<Inspection> {
    const row = await this.pick(id, version);
    const unpacked = await unpackPlugin(await this.download(row));
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

  private async installVersion(row: VersionRow): Promise<PluginsSnapshot> {
    const file = await this.download(row);
    try {
      const snapshot = await this.plugins.installFile(file, { source: "store", digest: row.digest!, attestation: row.attestation ?? undefined });
      void this.client.rpc("tomrade_count_download", { p_plugin: row.plugin_id });
      this.changed();
      return snapshot;
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  async install(id: string, version?: string): Promise<PluginsSnapshot> {
    return this.installVersion(await this.pick(id, version));
  }

  private async installedFromStore() {
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

  async updates(): Promise<UpdatePlan[]> {
    const installed = await this.installedFromStore();
    const [versions, revocations] = await Promise.all([this.versionsOf(installed.map((i) => i.id)), this.revocations()]);
    return installed.flatMap((entry) => planUpdate(entry, versions.filter((v) => v.plugin_id === entry.id), revocations) ?? []);
  }

  async update(id: string): Promise<PluginsSnapshot> {
    const plan = (await this.updates()).find((u) => u.id === id);
    if (!plan) throw new Error(`${id} is up to date`);
    return this.installVersion(plan.to);
  }

  /** Revocations switch a plugin off; updates the rules allow land by themselves. */
  async sweep(): Promise<void> {
    const store = this.plugins.extensions!;
    const revocations = await this.revocations();
    const now = new Map<string, string>();
    for (const entry of store.entries()) {
      const hit = revoked(entry.id, entry.version, revocations);
      if (!hit) continue;
      now.set(entry.id, hit.reason);
      if (!entry.disabled) await this.plugins.setEnabled(entry.id, false).catch(() => undefined);
    }
    this.revokedNow = now;
    for (const plan of await this.updates()) {
      if (plan.automatic && !now.has(plan.id)) await this.installVersion(plan.to).catch((error: unknown) => this.home.logger.warn(`update ${plan.id}: ${error instanceof Error ? error.message : String(error)}`));
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
    const release = await prepareRelease(dir, account.publisher, this.github, { checkOptions: { execPath: process.execPath } });
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
