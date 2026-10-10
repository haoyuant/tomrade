import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Service } from "cordis";
import { afterAll, describe, expect, it } from "vitest";
import { Settings } from "@tomradex/settings";
import { Tools } from "@tomradex/tools";
import { fresh, settle } from "@tomradex/testkit";
import { ATTESTATION_FILE, LOCK_FILE, attest, generateSigningKey, packPlugin, packageDigest, unpackPlugin } from "@tomradex/plugin-kit";
import { ExtensionStore, Plugins } from "@tomradex/plugins";
import { scaffold } from "@tomradex/plugin-cli";
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

async function storeHost(tables: Record<string, Record<string, unknown>[]>, base: string, user: Record<string, unknown> | null = null) {
  const client = fakeSupabase(tables, base, user);
  class FakeCloud extends Service {
    static provide = "cloudHub";
    client = client;
    constructor(ctx: Context) {
      super(ctx, "cloudHub");
    }
  }
  const root = fs.mkdtempSync(path.join(tmp, "root-"));
  const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], FakeCloud] });
  const store = new ExtensionStore({ root, lockFile: path.join(root, LOCK_FILE), trustedKeys: { [key.keyId]: key.publicKey }, importer });
  await w.ctx.plugin(Plugins, { rows: [], modules: [], extensions: store, resolve: async () => ({ apply() {} }) });
  await w.ctx.plugin(Community, {});
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
