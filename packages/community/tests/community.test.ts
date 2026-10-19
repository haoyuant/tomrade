import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Service } from "cordis";
import { afterAll, describe, expect, it, vi } from "vitest";
import GitHubAccount from "@tomradex/github";
import { Settings } from "@tomradex/settings";
import { Tools } from "@tomradex/tools";
import { fresh, settle } from "@tomradex/testkit";
import { ATTESTATION_FILE, LOCK_FILE, attest, generateSigningKey, packPlugin, packageDigest, unpackPlugin } from "@tomradex/plugin-kit";
import { ExtensionStore, Plugins } from "@tomradex/plugins";
import { release, scaffold } from "@tomradex/plugin-cli";
import { Community, planUpdate, prepareRelease, type GitHubAccess, type VersionRow } from "@tomradex/community";
import type { Manifest } from "@tomradex/plugin-sdk";

// Inside the repository: vitest's module runner will not import from the system temp directory.
const tmp = fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const key = generateSigningKey();

const manifest = (over: Partial<Manifest> = {}): Manifest =>
  ({ id: "alice/notes", version: "1.0.0", title: "Notes", description: "", license: "MIT", engines: { sdk: "^0.2.0" }, main: "dist/index.js", permissions: { network: [], fs: "none", exec: false }, inject: ["items"], optional: [], contributes: {}, authoredBy: "human", ...over }) as Manifest;
const row = (version: string, over: Partial<VersionRow> = {}): VersionRow => ({
  plugin_id: "alice/notes",
  version,
  commit_sha: "c".repeat(40),
  tag: `v${version}`,
  status: "listed",
  tier: "community",
  risk: "low",
  risk_reasons: [],
  sdk_range: "^0.2.0",
  manifest: manifest({ version }),
  digest: "d".repeat(64),
  attestation: null,
  package_path: `alice/notes/${version}.tomrade-plugin`,
  package_size: 100,
  listed_at: null,
  ...over
});

describe("update rules", () => {
  const installed = { id: "alice/notes", version: "1.0.0", tier: "community" as const, autoUpdate: true, manifest: manifest() };

  it("moves a community plugin by itself only when its person switched updates on", () => {
    expect(planUpdate(installed, [row("1.0.0"), row("1.1.0")], [])).toMatchObject({ automatic: true, to: { version: "1.1.0" } });
    expect(planUpdate({ ...installed, autoUpdate: false }, [row("1.0.0"), row("1.1.0")], [])).toMatchObject({ automatic: false, reasons: ["automatic updates are off"] });
  });

  it("keeps one of Tomrade's own at versions Tomrade signed", () => {
    const official = { ...installed, tier: "official" as const };
    expect(planUpdate(official, [row("1.0.0", { tier: "official" }), row("1.1.0")], [])).toMatchObject({ automatic: false, reasons: ["Tomrade did not sign the new version"] });
    expect(planUpdate(official, [row("1.0.0", { tier: "official" }), row("1.1.0", { tier: "official" })], [])).toMatchObject({ automatic: true });
  });

  it("never moves by itself to a version that reaches further, is riskier, or was revoked", () => {
    const wider = row("1.1.0", { manifest: manifest({ version: "1.1.0", inject: ["items", "db"], permissions: { network: ["api.example.com"], fs: "none", exec: false } }) });
    expect(planUpdate(installed, [row("1.0.0"), wider], [])).toMatchObject({ automatic: false, expands: ["service:db", "host:api.example.com"] });
    expect(planUpdate(installed, [row("1.0.0"), row("1.1.0", { risk: "high" })], [])?.reasons).toContain("it is riskier than the installed version");
    expect(planUpdate(installed, [row("1.0.0"), row("1.1.0")], [{ plugin_id: "alice/notes", versions: ">=1.1.0", reason: "broken" }])).toBeNull();
    expect(planUpdate(installed, [row("1.0.0"), row("2.0.0", { sdk_range: "^9.0.0" })], [])).toBeNull();
  });
});

const fakeGitHub = (login: string, bare: string): GitHubAccess => ({
  login: async () => login,
  ensureRepo: async () => {
    if (!fs.existsSync(bare)) execFileSync("git", ["init", "-q", "--bare", bare]);
  },
  remote: () => ({ url: bare, env: {} })
});

describe("publishing", () => {
  it("renames a local plugin to the publisher, checks it, and pushes a tagged commit the store can build", async () => {
    const dir = path.join(tmp, "pub");
    scaffold(dir, { id: "local/notes", description: "Keeps notes." });
    const bare = path.join(tmp, "remote.git");
    const release = await prepareRelease(dir, "alice", fakeGitHub("alice", bare));
    expect(release).toMatchObject({ id: "alice/notes", version: "0.1.0", repository: "https://github.com/alice/tomrade-plugin-notes", tag: "v0.1.0", renamedFrom: "local/notes" });
    expect(release.manifest).toMatchObject({ namespace: "notes", inject: ["items", "tools", "contributions"] });
    const pushed = execFileSync("git", ["--git-dir", bare, "rev-parse", "refs/tags/v0.1.0^{commit}"]).toString().trim();
    expect(pushed).toBe(release.commit);
    const files = execFileSync("git", ["--git-dir", bare, "ls-tree", "-r", "--name-only", release.commit]).toString();
    expect(files).toContain("src/index.ts");
    expect(files).not.toContain("dist/");
    await expect(prepareRelease(dir, "alice", fakeGitHub("alice", bare))).rejects.toThrow(/v0.1.0 was published already/);
    await expect(prepareRelease(dir, "alice", fakeGitHub("mallory", bare))).rejects.toThrow(/belongs to mallory/);
  }, 60_000);
});

/** Just enough of supabase-js for the service: chained filters over fixed rows, rpc calls recorded. */
function fakeSupabase(tables: Record<string, Record<string, unknown>[]>, baseUrl: string, user: Record<string, unknown> | null = null) {
  const rpc: [string, unknown][] = [];
  const uploads = new Map<string, Buffer>();
  const query = (rows: Record<string, unknown>[]) => {
    let out = rows;
    const builder = {
      select: () => builder,
      eq: (k: string, v: unknown) => ((out = out.filter((r) => r[k] === v)), builder),
      in: (k: string, vs: unknown[]) => ((out = out.filter((r) => vs.includes(r[k]))), builder),
      or: () => builder,
      order: () => builder,
      limit: () => builder,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: out, error: null }).then(resolve)
    };
    return builder;
  };
  return {
    rpc: (name: string, args: unknown) => (rpc.push([name, args]), Promise.resolve({ data: null, error: null })),
    calls: rpc,
    uploads,
    from: (table: string) => query(tables[table] ?? []),
    storage: {
      from: () => ({
        getPublicUrl: (p: string) => ({ data: { publicUrl: `${baseUrl}/${p}` } }),
        upload: async (p: string, bytes: Buffer) => (uploads.has(p) ? { error: { message: "The resource already exists" } } : (uploads.set(p, bytes), { data: { path: p }, error: null }))
      })
    },
    auth: { getUser: async () => ({ data: { user } }) }
  };
}

const importer = async (url: string) => {
  const u = new URL(url);
  const copy = path.join(tmp, "imports", `${u.searchParams.get("v")}-${path.basename(fileURLToPath(u))}`);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(fileURLToPath(u), copy);
  return import(copy);
};

async function storePackage(version: string, opts: { official?: boolean; served?: string } = {}) {
  const dir = path.join(tmp, `pkg-${version}`);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tomrade-plugin.json"), JSON.stringify(manifest({ version, inject: ["tools"], repository: "https://github.com/alice/x" })));
  fs.writeFileSync(
    path.join(dir, "dist/index.js"),
    `export default { [Symbol.for("tomrade.sdk-plugin")]: 1, inject: ["tools"], async apply(ctx) { await ctx.tools.register({ name: "notes_version", title: "v", description: "v", input: { safeParse: (v) => ({ success: true, data: v }) }, execute: () => "${opts.served ?? version}" }); } };`
  );
  const digest = packageDigest(dir);
  const attestation = opts.official ? attest({ v: 1, id: "alice/notes", version, digest, tier: "official", risk: "low", issuedAt: 1 }, key.privateKey) : null;
  if (attestation) fs.writeFileSync(path.join(dir, ATTESTATION_FILE), JSON.stringify(attestation));
  const { file } = await packPlugin(dir, path.join(tmp, "served", "alice", "notes", `${version}.tomrade-plugin`));
  return { file, attestation, digest };
}

async function storeHost(tables: Record<string, Record<string, unknown>[]>, base: string, user: Record<string, unknown> | null = null, opts: { cloud?: boolean; config?: Record<string, unknown> } = {}) {
  const client = fakeSupabase(tables, base, user);
  class FakeCloud extends Service {
    static provide = "cloudHub";
    client = client;
    constructor(ctx: Context) {
      super(ctx, "cloudHub");
    }
  }
  const root = fs.mkdtempSync(path.join(tmp, "root-"));
  const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], GitHubAccount, ...(opts.cloud === false ? [] : [FakeCloud])] });
  const store = new ExtensionStore({ root, lockFile: path.join(root, LOCK_FILE), trustedKeys: { [key.keyId]: key.publicKey }, importer });
  await w.ctx.plugin(Plugins, { rows: [], modules: [], extensions: store, resolve: async () => ({ apply() {} }) });
  await w.ctx.plugin(Community, opts.config ?? {});
  await settle();
  return { ...w, client, store, community: w.ctx.community };
}

describe("the store client", () => {
  it("reads a version here before installing it, installs only the listed build, follows updates within the rules, and switches off what was revoked", async () => {
    fs.mkdirSync(path.join(tmp, "served", "alice", "notes"), { recursive: true });
    const v1 = await storePackage("1.0.0");
    const v2 = await storePackage("1.1.0");
    const swapped = await storePackage("1.2.0", { served: "something else" });
    const server = http.createServer((req, res) => {
      const file = path.join(tmp, "served", decodeURIComponent(req.url ?? ""));
      if (!fs.existsSync(file)) return res.writeHead(404).end();
      res.writeHead(200).end(fs.readFileSync(file));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const tables: Record<string, Record<string, unknown>[]> = {
      tomrade_plugins: [{ id: "alice/notes", title: "Notes", description: "", publisher: "alice", namespace: "notes", repository: "https://github.com/alice/x", license: "MIT", downloads: 3, delisted: false }],
      tomrade_plugin_versions: [row("1.0.0", { digest: v1.digest, manifest: manifest({ version: "1.0.0", inject: ["tools"] }) })],
      tomrade_plugin_revocations: []
    };
    const { ctx, store, client, community } = await storeHost(tables, base);

    const [listing] = await community.search({ text: "notes" });
    expect(listing).toMatchObject({ id: "alice/notes", latest: { version: "1.0.0", tier: "community", commit: "c".repeat(40), compatible: true }, installed: null });
    expect(await community.inspect("alice/notes")).toMatchObject({ version: "1.0.0", tier: "community", commit: "c".repeat(40), repository: "https://github.com/alice/x", risk: "low", inject: ["tools"] });
    await community.install("alice/notes");
    expect(await ctx.tools.execute("notes_version", {}, { by: "human" })).toBe("1.0.0");
    expect(store.info("alice/notes")).toMatchObject({ tier: "community", source: "store" });
    expect(client.calls.map(([name]) => name)).toContain("tomrade_count_download");

    // Updates are off until the person switches them on; then a version that reaches no further lands by itself.
    tables.tomrade_plugin_versions!.push(row("1.1.0", { digest: v2.digest, manifest: manifest({ version: "1.1.0", inject: ["tools"] }) }));
    await community.sweep();
    expect(await ctx.tools.execute("notes_version", {}, { by: "human" })).toBe("1.0.0");
    store.setAutoUpdate("alice/notes", true);
    await community.sweep();
    expect(await ctx.tools.execute("notes_version", {}, { by: "human" })).toBe("1.1.0");

    // A package that is not the build the store lists is refused, read or installed.
    tables.tomrade_plugin_versions!.push(row("1.2.0", { digest: "e".repeat(64) }));
    await expect(community.inspect("alice/notes", "1.2.0")).rejects.toThrow(/not the build the store lists/);
    await expect(community.install("alice/notes", "1.2.0")).rejects.toThrow(/not the build the store lists/);
    expect(swapped.digest).not.toBe("e".repeat(64));

    tables.tomrade_plugin_revocations!.push({ plugin_id: "alice/notes", versions: "*", reason: "exfiltrates data" });
    await community.sweep();
    expect(ctx.plugins.snapshot().plugins.find((p) => p.id === "alice/notes")?.state).toBe("disabled");
    await expect(community.install("alice/notes")).rejects.toThrow(/no version this Tomrade can run|revoked/);
    server.close();
  }, 60_000);

  it("calls a version official only when Tomrade signed that build", async () => {
    fs.mkdirSync(path.join(tmp, "served", "alice", "notes"), { recursive: true });
    const v3 = await storePackage("3.0.0", { official: true });
    const server = http.createServer((req, res) => res.writeHead(200).end(fs.readFileSync(path.join(tmp, "served", decodeURIComponent(req.url ?? "")))));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { store, community } = await storeHost({ tomrade_plugin_versions: [row("3.0.0", { tier: "official", digest: v3.digest, attestation: v3.attestation })], tomrade_plugin_revocations: [] }, base);
    await community.install("alice/notes");
    expect(store.info("alice/notes")).toMatchObject({ tier: "official", source: "store" });
    server.close();
  }, 60_000);

  it("publishes the check's build of the pushed commit under the publisher's login, and lists it in one call", async () => {
    const user = { id: "u1", email: "alice@example.com", identities: [{ provider: "github", identity_data: { user_name: "alice" } }] };
    const { client, community } = await storeHost({ tomrade_publishers: [{ user_id: "u1", github_login: "alice" }] }, "http://127.0.0.1:9", user);
    const dir = path.join(tmp, "to-publish");
    scaffold(dir, { id: "local/notes", description: "Keeps notes." });
    community.github = fakeGitHub("alice", path.join(tmp, "published.git"));
    const published = await community.publish(dir);
    expect(published).toMatchObject({ id: "alice/notes", version: "0.1.0", repository: "https://github.com/alice/tomrade-plugin-notes" });
    const packagePath = `alice/notes/0.1.0/${published.digest}.tomrade-plugin`;
    expect([...client.uploads.keys()]).toEqual([packagePath]);
    const uploaded = path.join(tmp, "uploaded.tomrade-plugin");
    fs.writeFileSync(uploaded, client.uploads.get(packagePath)!);
    expect((await unpackPlugin(uploaded)).digest).toBe(published.digest);
    const [name, args] = client.calls.find(([n]) => n === "tomrade_publish_plugin")!;
    expect(name).toBe("tomrade_publish_plugin");
    expect(args).toMatchObject({ p_commit: published.commit, p_tag: "v0.1.0", p_digest: published.digest, p_package_path: packagePath, p_risk: "low", p_manifest: { id: "alice/notes" } });
  }, 60_000);
});

describe("the official catalog", () => {
  const other = generateSigningKey();
  const memo = (version: string, over: Partial<Manifest> = {}) => manifest({ id: "tomrade/memo", version, inject: ["tools"], repository: "https://github.com/haoyuant/tomrade-plugins", ...over });

  /** A build of tomrade/memo, signed by `signer` (or for another digest), served under official/. */
  async function officialPackage(version: string, opts: { signer?: typeof key; attestDigest?: string; id?: string } = {}) {
    const id = opts.id ?? "tomrade/memo";
    const dir = path.join(tmp, `official-${id.replace("/", "-")}-${version}`);
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    const m = memo(version, { id });
    fs.writeFileSync(path.join(dir, "tomrade-plugin.json"), JSON.stringify(m));
    // As a build writes it: what the schema defaults is left out.
    const { optional: _optional, contributes: _contributes, ...written } = m;
    fs.writeFileSync(
      path.join(dir, "dist/index.js"),
      `export default { [Symbol.for("tomrade.sdk-plugin")]: 1, inject: ["tools"], async apply(ctx) { await ctx.tools.register({ name: "memo_version", title: "v", description: "v", input: { safeParse: (v) => ({ success: true, data: v }) }, execute: () => "${version}" }); } };`
    );
    const digest = packageDigest(dir);
    const attestation = attest({ v: 1, id, version, digest: opts.attestDigest ?? digest, tier: "official", risk: "low", issuedAt: 1 }, (opts.signer ?? key).privateKey);
    const file = path.join(tmp, "served", "official", id.replace("/", "-"), `${version}.tomrade-plugin`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const packed = await packPlugin(dir, file);
    return { version, sdkRange: "^0.2.0", commit: "f".repeat(40), manifest: written, risk: "low", riskReasons: [], digest: packed.digest, size: fs.statSync(file).size, url: `${id.replace("/", "-")}/${version}.tomrade-plugin`, releasedAt: `2026-10-1${version.split(".")[1]}T00:00:00Z`, attestation };
  }

  async function catalogServer() {
    const catalog = { v: 1, generatedAt: "2026-10-17T00:00:00Z", plugins: [] as Record<string, unknown>[], revoked: [] as Record<string, unknown>[] };
    const server = http.createServer((req, res) => {
      if (req.url === "/official/catalog.json") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(catalog));
      const file = path.join(tmp, "served", decodeURIComponent(req.url ?? ""));
      if (!fs.existsSync(file)) return res.writeHead(404).end();
      res.writeHead(200).end(fs.readFileSync(file));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/official/catalog.json`;
    return { catalog, server, url };
  }

  it("lists, reads and installs Tomrade's own plugins without a cloud account, signed and kept up to date", async () => {
    const { catalog, server, url } = await catalogServer();
    const v1 = await officialPackage("1.0.0");
    catalog.plugins.push({ id: "tomrade/memo", title: "Memo", description: "Quick notes", license: "Apache-2.0", repository: "https://github.com/haoyuant/tomrade-plugins", versions: [v1] });
    const { ctx, store, community } = await storeHost({}, "http://127.0.0.1:9", null, { cloud: false, config: { officialCatalog: { url } } });

    expect(community.sources()).toMatchObject([{ name: "official", available: true }, { name: "community", available: false }]);
    await expect(community.search({ text: "memo" })).rejects.toThrow(/needs Tomrade cloud/);
    const [listing] = await community.search({ text: "quick", source: "official" });
    expect(listing).toMatchObject({ source: "official", id: "tomrade/memo", publisher: "tomrade", license: "Apache-2.0", latest: { version: "1.0.0", tier: "official", compatible: true }, installed: null });
    expect(await community.search({ text: "nothing like it", source: "official" })).toEqual([]);
    expect(await community.plugin("tomrade/memo")).toMatchObject({ source: "official", versions: [{ version: "1.0.0" }], manifest: { id: "tomrade/memo", optional: [], permissions: { exec: false } } });
    expect(await community.inspect("tomrade/memo")).toMatchObject({ version: "1.0.0", tier: "official", inject: ["tools"] });

    await community.install("tomrade/memo");
    expect(await ctx.tools.execute("memo_version", {}, { by: "human" })).toBe("1.0.0");
    expect(store.info("tomrade/memo")).toMatchObject({ tier: "official", source: "store" });

    // Official plugins update by themselves, to versions Tomrade signed.
    (catalog.plugins[0]!.versions as unknown[]).push(await officialPackage("1.1.0"));
    await community.sweep();
    expect(await ctx.tools.execute("memo_version", {}, { by: "human" })).toBe("1.1.0");

    catalog.revoked.push({ id: "tomrade/memo", versions: "*", reason: "leaks drafts" });
    await community.sweep();
    expect(ctx.plugins.snapshot().plugins.find((p) => p.id === "tomrade/memo")?.state).toBe("disabled");
    server.close();
  }, 60_000);

  it("puts each starter on once, tries again while the catalog lacks it, and leaves one the person uninstalled gone", async () => {
    const { catalog, server, url } = await catalogServer();
    const startersFile = path.join(fs.mkdtempSync(path.join(tmp, "starters-")), "official-starters.json");
    const { ctx, store, community } = await storeHost({}, "http://127.0.0.1:9", null, { cloud: false, config: { officialCatalog: { url }, starters: ["tomrade/memo"], startersFile } });

    await community.installStarters();
    expect(store.has("tomrade/memo")).toBe(false);
    expect(fs.existsSync(startersFile)).toBe(false);

    catalog.plugins.push({ id: "tomrade/memo", title: "Memo", description: "Quick notes", license: "Apache-2.0", repository: "https://github.com/haoyuant/tomrade-plugins", versions: [await officialPackage("1.0.0")] });
    community.official.expire();
    await community.installStarters();
    expect(store.info("tomrade/memo")).toMatchObject({ tier: "official", source: "store" });
    expect(await ctx.tools.execute("memo_version", {}, { by: "human" })).toBe("1.0.0");
    expect(JSON.parse(fs.readFileSync(startersFile, "utf8"))).toEqual(["tomrade/memo"]);

    await ctx.plugins.uninstall("tomrade/memo");
    await community.installStarters();
    expect(store.has("tomrade/memo")).toBe(false);
    server.close();
  }, 60_000);

  it("puts a provider's starter on only once the person has that provider's model, offers it again after an uninstall, and never to anyone else", async () => {
    const { catalog, server, url } = await catalogServer();
    const startersFile = path.join(fs.mkdtempSync(path.join(tmp, "starters-")), "official-starters.json");
    const pkg = await officialPackage("1.0.0");
    // The catalog says what each version contributes; this one answers web search.
    catalog.plugins.push({ id: "tomrade/memo", title: "Memo Search", description: "x", license: "Apache-2.0", repository: "https://github.com/haoyuant/tomrade-plugins", versions: [{ ...pkg, manifest: { ...pkg.manifest, contributes: { webSearchProviders: ["memo"] } } }] });
    const { ctx, store, community } = await storeHost({}, "http://127.0.0.1:9", null, { cloud: false, config: { officialCatalog: { url }, starters: [{ id: "tomrade/memo", whenModelHost: ["api.moonshot.cn", "api.moonshot.ai"] }], startersFile } });
    const models = (baseURL: string) => ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [{ id: "m", provider: "openai-compatible", baseURL, apiKey: "k", model: "x" }], roles: { worker: "" } } } as never);

    await community.installStarters();
    expect(store.has("tomrade/memo")).toBe(false);
    expect(await community.offers("webSearchProviders")).toEqual([]);
    models("https://api.deepseek.com");
    await settle();
    expect(store.has("tomrade/memo")).toBe(false);

    // Adding the model is enough: it goes on now, not at the next store check.
    models("https://api.moonshot.ai/v1");
    await vi.waitFor(() => expect(store.info("tomrade/memo")).toMatchObject({ tier: "official", source: "store" }), { timeout: 20_000 });
    expect(await community.offers("webSearchProviders")).toEqual([]);

    await ctx.plugins.uninstall("tomrade/memo");
    await community.installStarters();
    expect(store.has("tomrade/memo")).toBe(false);
    expect(await community.offers("webSearchProviders")).toEqual([{ id: "tomrade/memo", title: "Memo Search" }]);
    expect(await community.offers("imAdapters")).toEqual([]);
    models("https://api.deepseek.com");
    await settle();
    expect(await community.offers("webSearchProviders")).toEqual([]);
    server.close();
  }, 60_000);

  it("offers the official plugins that bring a model provider until one is installed, and never a revoked one", async () => {
    const { catalog, server, url } = await catalogServer();
    const pkg = await officialPackage("1.0.0");
    const other = await officialPackage("1.0.0", { id: "tomrade/notes" });
    catalog.plugins.push(
      { id: "tomrade/memo", title: "Memo Models", description: "x", license: "Apache-2.0", repository: "https://github.com/haoyuant/tomrade-plugins", versions: [{ ...pkg, manifest: { ...pkg.manifest, contributes: { modelProviders: ["memo"] } } }] },
      { id: "tomrade/notes", title: "Notes", description: "x", license: "Apache-2.0", repository: "https://github.com/haoyuant/tomrade-plugins", versions: [other] }
    );
    const { ctx, store, community } = await storeHost({}, "http://127.0.0.1:9", null, { cloud: false, config: { officialCatalog: { url } } });

    expect(await community.providing("modelProviders")).toEqual([{ id: "tomrade/memo", title: "Memo Models", ids: ["memo"] }]);
    await community.install("tomrade/memo");
    expect(store.has("tomrade/memo")).toBe(true);
    expect(await community.providing("modelProviders")).toEqual([]);

    await ctx.plugins.uninstall("tomrade/memo");
    catalog.revoked.push({ id: "tomrade/memo", versions: "*", reason: "Built into Tomrade" });
    community.official.expire();
    expect(await community.providing("modelProviders")).toEqual([]);
    server.close();
  }, 60_000);

  it("shows and installs only versions Tomrade signed for that exact build, under its own publisher, that this Tomrade can run", async () => {
    const { catalog, server, url } = await catalogServer();
    const good = await officialPackage("1.0.0");
    const foreignKey = await officialPackage("1.1.0", { signer: other });
    const otherDigest = await officialPackage("1.2.0", { attestDigest: "a".repeat(64) });
    const future = { ...(await officialPackage("1.3.0")), sdkRange: "^9.0.0" };
    const swapped = { ...(await officialPackage("1.4.0")), digest: good.digest };
    catalog.plugins.push(
      { id: "tomrade/memo", title: "Memo", license: "MIT", versions: [good, foreignKey, otherDigest, future, swapped] },
      { id: "alice/memo", title: "Not ours", license: "MIT", versions: [await officialPackage("1.0.0", { id: "alice/memo" })] },
      { id: "tomrade/unsigned", title: "Unsigned", license: "MIT", versions: [{ ...(await officialPackage("1.0.0", { id: "tomrade/unsigned", signer: other })) }] },
      { id: "tomrade/broken", title: "Broken", versions: "not a list" }
    );
    const { store, community } = await storeHost({}, "http://127.0.0.1:9", null, { cloud: false, config: { officialCatalog: { url } } });

    const listings = await community.search({ source: "official" });
    expect(listings.map((l) => l.id)).toEqual(["tomrade/memo"]);
    expect((await community.plugin("tomrade/memo")).versions.map((v) => [v.version, v.compatible])).toEqual([
      ["1.3.0", false],
      ["1.0.0", true]
    ]);
    await expect(community.install("tomrade/memo", "1.1.0")).rejects.toThrow(/not available/);
    await expect(community.install("tomrade/memo", "1.2.0")).rejects.toThrow(/not available/);
    await expect(community.install("tomrade/memo", "1.4.0")).rejects.toThrow(/not available/);
    await expect(community.plugin("alice/memo")).rejects.toThrow(/needs Tomrade cloud/);
    await community.install("tomrade/memo");
    expect(store.info("tomrade/memo")).toMatchObject({ version: "1.0.0", tier: "official" });
    server.close();
  }, 60_000);

  it("browses both sources in one search, Tomrade's own first, and keeps one when the other cannot answer", async () => {
    const { catalog, server, url } = await catalogServer();
    catalog.plugins.push({ id: "tomrade/memo", title: "Memo", description: "Notes in a hurry", license: "MIT", versions: [await officialPackage("1.0.0")] });
    const tables = {
      tomrade_plugins: [{ id: "alice/notes", title: "Notes", description: "", publisher: "alice", namespace: "notes", repository: "https://github.com/alice/x", license: "MIT", downloads: 3, delisted: false }],
      tomrade_plugin_versions: [row("1.0.0")],
      tomrade_plugin_revocations: []
    };
    const both = await storeHost(tables, "http://127.0.0.1:9", null, { config: { officialCatalog: { url } } });
    const all = await both.community.browse({});
    expect(all.listings.map((l) => [l.source, l.id])).toEqual([
      ["official", "tomrade/memo"],
      ["community", "alice/notes"]
    ]);
    expect(all.sources.map((s) => [s.name, s.available])).toEqual([
      ["official", true],
      ["community", true]
    ]);
    expect((await both.community.browse({ officialOnly: true })).listings.map((l) => l.id)).toEqual(["tomrade/memo"]);
    expect((await both.community.browse({ officialOnly: true })).sources.map((s) => s.name)).toEqual(["official"]);

    const noCloud = await storeHost({}, "http://127.0.0.1:9", null, { cloud: false, config: { officialCatalog: { url } } });
    const officialAlone = await noCloud.community.browse({ text: "hurry" });
    expect(officialAlone.listings.map((l) => l.id)).toEqual(["tomrade/memo"]);
    expect(officialAlone.sources[1]).toMatchObject({ name: "community", available: false, reason: "no-cloud", error: expect.stringMatching(/needs Tomrade cloud/) });
    await new Promise((r) => server.close(r));

    const offline = await storeHost(tables, "http://127.0.0.1:9", null, { config: { officialCatalog: { url, cacheFile: path.join(tmp, "never.json") } } });
    const communityAlone = await offline.community.browse({});
    expect(communityAlone.listings.map((l) => l.id)).toEqual(["alice/notes"]);
    expect(communityAlone.sources[0]).toMatchObject({ name: "official", available: false, error: expect.stringMatching(/official catalog is unavailable/) });
  }, 60_000);

  it("installs what tomrade-plugin release wrote, served as it is", async () => {
    const dir = path.join(tmp, "released", "journal");
    scaffold(dir, { id: "tomrade/journal", title: "Journal", description: "Daily entries." });
    const file = path.join(dir, "tomrade-plugin.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), icon: "icon.svg", repository: "https://github.com/haoyuant/tomrade-plugins" }));
    fs.writeFileSync(path.join(dir, "icon.svg"), "<svg/>");
    fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "## 0.1.0\n");
    fs.mkdirSync(path.join(dir, "tests"));
    fs.writeFileSync(path.join(dir, "tests", "journal.test.ts"), "");
    const out = path.join(tmp, "released", "out");
    const released = await release(dir, { privateKey: key.privateKey, out, commit: "9".repeat(40) });
    expect(released.report.official).toEqual([]);
    const server = http.createServer((req, res) => {
      const served = path.join(out, decodeURIComponent((req.url ?? "").slice(1)));
      if (!fs.existsSync(served)) return res.writeHead(404).end();
      res.writeHead(200).end(fs.readFileSync(served));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/catalog.json`;
    const { store, community } = await storeHost({}, "http://127.0.0.1:9", null, { cloud: false, config: { officialCatalog: { url } } });
    expect((await community.browse({})).listings.map((l) => [l.id, l.latest?.tier])).toEqual([["tomrade/journal", "official"]]);
    await community.install("tomrade/journal");
    expect(store.info("tomrade/journal")).toMatchObject({ version: "0.1.0", tier: "official" });
    server.close();
  }, 120_000);

  it("keeps listing what it fetched last when the catalog cannot be reached, and says so", async () => {
    const { catalog, server, url } = await catalogServer();
    catalog.plugins.push({ id: "tomrade/memo", title: "Memo", license: "MIT", versions: [await officialPackage("1.0.0")] });
    const cacheFile = path.join(tmp, "official-catalog.json");
    const online = await storeHost({}, "http://127.0.0.1:9", null, { cloud: false, config: { officialCatalog: { url, cacheFile } } });
    expect(await online.community.search({ source: "official" })).toHaveLength(1);
    expect(online.community.sources()[0]).toMatchObject({ stale: false, error: null });
    await new Promise((r) => server.close(r));

    const offline = await storeHost({}, "http://127.0.0.1:9", null, { cloud: false, config: { officialCatalog: { url, cacheFile } } });
    expect((await offline.community.search({ source: "official" })).map((l) => l.id)).toEqual(["tomrade/memo"]);
    expect(offline.community.sources()[0]).toMatchObject({ name: "official", stale: true, error: expect.any(String) });

    const never = await storeHost({}, "http://127.0.0.1:9", null, { cloud: false, config: { officialCatalog: { url, cacheFile: path.join(tmp, "none.json") } } });
    await expect(never.community.search({ source: "official" })).rejects.toThrow(/official catalog is unavailable/);
  }, 60_000);
});
