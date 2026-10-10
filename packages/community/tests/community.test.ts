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
import { ATTESTATION_FILE, LOCK_FILE, attest, generateSigningKey, packPlugin, packageDigest } from "@tomradex/plugin-kit";
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
  status: "listed",
  tier: "ai-reviewed",
  risk: "low",
  risk_reasons: [],
  sdk_range: "^0.2.0",
  manifest: manifest({ version }),
  digest: "d".repeat(64),
  attestation: {},
  report: null,
  reviewed_as: null,
  package_path: `alice/notes/${version}.tomrade-plugin`,
  package_size: 100,
  listed_at: null,
  ...over
});

describe("update rules", () => {
  const installed = { id: "alice/notes", version: "1.0.0", tier: "reviewed" as const, autoUpdate: true, manifest: manifest() };

  it("keeps a human-reviewed install at human-reviewed versions, unless the store carried the badge over", () => {
    expect(planUpdate(installed, [row("1.0.0", { tier: "reviewed" }), row("1.1.0")], [])).toMatchObject({ automatic: false, reasons: ["the new version has not been reviewed by Tomrade"] });
    expect(planUpdate(installed, [row("1.0.0", { tier: "reviewed" }), row("1.1.0", { tier: "reviewed", reviewed_as: "1.0.0" })], [])).toMatchObject({ automatic: true });
  });

  it("never moves by itself to a version that reaches further, is riskier, or was revoked", () => {
    const wider = row("1.1.0", { tier: "reviewed", manifest: manifest({ version: "1.1.0", inject: ["items", "db"], permissions: { network: ["api.example.com"], fs: "none", exec: false } }) });
    expect(planUpdate(installed, [row("1.0.0", { tier: "reviewed" }), wider], [])).toMatchObject({ automatic: false, expands: ["service:db", "host:api.example.com"] });
    expect(planUpdate(installed, [row("1.0.0", { tier: "reviewed" }), row("1.1.0", { tier: "reviewed", risk: "high" })], [])?.reasons).toContain("it is riskier than the installed version");
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
function fakeSupabase(tables: Record<string, Record<string, unknown>[]>, baseUrl: string) {
  const rpc: [string, unknown][] = [];
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
    from: (table: string) => query(tables[table] ?? []),
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `${baseUrl}/${p}` } }) }) },
    auth: { getUser: async () => ({ data: { user: null } }) }
  };
}

const importer = async (url: string) => {
  const u = new URL(url);
  const copy = path.join(tmp, "imports", `${u.searchParams.get("v")}-${path.basename(fileURLToPath(u))}`);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(fileURLToPath(u), copy);
  return import(copy);
};

async function signedPackage(version: string, tier: "ai-reviewed" | "reviewed") {
  const dir = path.join(tmp, `pkg-${version}`);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tomrade-plugin.json"), JSON.stringify(manifest({ version, inject: ["tools"] })));
  fs.writeFileSync(
    path.join(dir, "dist/index.js"),
    `export default { [Symbol.for("tomrade.sdk-plugin")]: 1, inject: ["tools"], async apply(ctx) { await ctx.tools.register({ name: "notes_version", title: "v", description: "v", input: { safeParse: (v) => ({ success: true, data: v }) }, execute: () => "${version}" }); } };`
  );
  const digest = packageDigest(dir);
  const attestation = attest({ v: 1, id: "alice/notes", version, digest, tier, risk: "low", issuedAt: 1 }, key.privateKey);
  fs.writeFileSync(path.join(dir, ATTESTATION_FILE), JSON.stringify(attestation));
  const { file } = await packPlugin(dir, path.join(tmp, "served", "alice", "notes", `${version}.tomrade-plugin`));
  return { file, attestation, digest };
}

describe("the store client", () => {
  it("installs a signed package, switches off what the store revoked, and updates within the rules", async () => {
    fs.mkdirSync(path.join(tmp, "served", "alice", "notes"), { recursive: true });
    const v1 = await signedPackage("1.0.0", "reviewed");
    const v2 = await signedPackage("1.1.0", "ai-reviewed");
    const server = http.createServer((req, res) => {
      const file = path.join(tmp, "served", decodeURIComponent(req.url ?? ""));
      if (!fs.existsSync(file)) return res.writeHead(404).end();
      res.writeHead(200).end(fs.readFileSync(file));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const tables: Record<string, Record<string, unknown>[]> = {
      tomrade_plugins: [{ id: "alice/notes", title: "Notes", description: "", publisher: "alice", namespace: "notes", repository: "https://github.com/alice/x", license: "MIT", downloads: 3, delisted: false }],
      tomrade_plugin_versions: [row("1.0.0", { tier: "reviewed", attestation: v1.attestation, digest: v1.digest })],
      tomrade_plugin_revocations: [],
      tomrade_plugin_reviews: []
    };
    const client = fakeSupabase(tables, base);
    class FakeCloud extends Service {
      static provide = "cloudHub";
      client = client;
      constructor(ctx: Context) {
        super(ctx, "cloudHub");
      }
    }
    const root = path.join(tmp, "root");
    const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(tmp, "settings.json") }], FakeCloud] });
    const store = new ExtensionStore({ root, lockFile: path.join(root, LOCK_FILE), trustedKeys: { [key.keyId]: key.publicKey }, importer });
    await w.ctx.plugin(Plugins, { rows: [], modules: [], extensions: store, resolve: async () => ({ apply() {} }) });
    await w.ctx.plugin(Community, {});
    await settle();
    const community = w.ctx.community;

    const [listing] = await community.search({ text: "notes" });
    expect(listing).toMatchObject({ id: "alice/notes", latest: { version: "1.0.0", tier: "reviewed", compatible: true }, installed: null });
    await community.install("alice/notes");
    expect(await w.ctx.tools.execute("notes_version", {}, { by: "human" })).toBe("1.0.0");
    expect(store.info("alice/notes")).toMatchObject({ tier: "reviewed", source: "store" });
    expect(client.calls.map(([name]) => name)).toContain("tomrade_count_download");

    // An ai-reviewed 1.1.0 does not replace a human-reviewed install by itself.
    store.setAutoUpdate("alice/notes", true);
    tables.tomrade_plugin_versions!.push(row("1.1.0", { attestation: v2.attestation, digest: v2.digest }));
    await community.sweep();
    expect(await w.ctx.tools.execute("notes_version", {}, { by: "human" })).toBe("1.0.0");
    expect((await community.updates())[0]).toMatchObject({ automatic: false, to: { version: "1.1.0" } });
    await community.update("alice/notes");
    expect(await w.ctx.tools.execute("notes_version", {}, { by: "human" })).toBe("1.1.0");

    tables.tomrade_plugin_revocations!.push({ plugin_id: "alice/notes", versions: "*", reason: "exfiltrates data" });
    await community.sweep();
    expect(w.ctx.plugins.snapshot().plugins.find((p) => p.id === "alice/notes")?.state).toBe("disabled");
    await expect(community.install("alice/notes")).rejects.toThrow(/no version this Tomrade can run|revoked/);
    server.close();
  }, 60_000);
});
