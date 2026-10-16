import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MANIFEST_FILE } from "@tomradex/plugin-sdk";
import { generateSigningKey, parseCatalog, unpackPlugin, verifyAttestation } from "@tomradex/plugin-kit";
import { check, release, scaffold } from "@tomradex/plugin-cli";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-official-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const editManifest = (dir: string, edit: (m: Record<string, unknown>) => void) => {
  const file = path.join(dir, MANIFEST_FILE);
  const m = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  edit(m);
  fs.writeFileSync(file, JSON.stringify(m, null, 2));
};

/** A plugin that meets the official standard as scaffolded, plus what the standard adds. */
function official(name: string) {
  const dir = path.join(tmp, name);
  scaffold(dir, { id: `tomrade/${name}`, title: "Memo", description: "Quick notes." });
  editManifest(dir, (m) => Object.assign(m, { icon: "icon.svg", repository: "https://github.com/haoyuant/tomrade-plugins" }));
  fs.writeFileSync(path.join(dir, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"/>');
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## 0.1.0\n\n- First release.\n");
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tests", "memo.test.ts"), 'import { it } from "vitest";\nit("works", () => {});\n');
  return dir;
}

describe("the official standard", () => {
  it("names everything a plugin lacks before it can be one of Tomrade's own", async () => {
    const dir = path.join(tmp, "elsewhere");
    scaffold(dir, { id: "someone/counter", title: "Counter", description: "Counts." });
    const report = await check(dir, { official: true });
    expect(report.verdict).toBe("blocked");
    expect(report.official).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/repository must be/),
        "an official plugin's id is tomrade/<name>, not someone/counter",
        "an official plugin lives in packages/counter, not elsewhere",
        expect.stringMatching(/^icon is not set/),
        "a CHANGELOG must say what changed in each version",
        "tests/ has no unit tests"
      ])
    );
    expect((await check(dir)).official).toEqual([]);
  }, 60_000);

  it("passes a plugin that meets it, and holds its text, permissions and changelog to it", async () => {
    const dir = official("memo");
    const ok = await check(dir, { official: true });
    expect(ok.official).toEqual([]);
    expect(ok.verdict).toBe("ok");

    fs.writeFileSync(path.join(dir, "src", "strings.ts"), 'export const hello = { en: "Hello" };\nexport const both = { en: "Bye", zh: "再见" };\nexport const only = { "zh": "只有中文" };\n');
    fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## 0.0.9\n");
    editManifest(dir, (m) => Object.assign(m, { permissions: { network: ["*"], fs: "none", exec: true, why: { exec: "Runs git to read the history." } } }));
    const report = await check(dir, { official: true });
    expect(report.verdict).toBe("blocked");
    expect(report.official).toEqual([
      "CHANGELOG.md has no entry for 0.1.0",
      "src/strings.ts:1 has text without its Chinese (zh) half",
      "src/strings.ts:3 has text without its English (en) half",
      'permissions.network "*" (any host) needs permissions.why.network; list the hosts instead where you can'
    ]);
  }, 60_000);

  it("holds a plugin to its own scenario", async () => {
    const dir = official("failing");
    fs.writeFileSync(path.join(dir, "src", "test.ts"), 'export default async function scenario(t: { check(name: string, ok: boolean): void }) {\n  t.check("adds up", Number("2") === 3);\n}\n');
    const report = await check(dir, { official: true });
    expect(report.official).toEqual([expect.stringMatching(/^src\/test.ts: "adds up" failed/)]);
  }, 60_000);
});

describe("releasing one of Tomrade's own", () => {
  const key = generateSigningKey();

  it("signs the exact build, packs it, and adds it to the catalog once", async () => {
    const dir = official("notebook");
    const out = path.join(tmp, "release");
    const first = await release(dir, { privateKey: key.privateKey, out, commit: "a".repeat(40) });
    expect(first.report.official).toEqual([]);
    expect(path.basename(first.file!)).toBe("tomrade-notebook-0.1.0.tomrade-plugin");
    const unpacked = await unpackPlugin(first.file!);
    expect(unpacked.digest).toBe(first.digest);
    expect(fs.existsSync(path.join(dir, "ATTESTATION.json"))).toBe(false);

    const catalog = parseCatalog(JSON.parse(fs.readFileSync(first.catalog!, "utf8"))).catalog;
    const [plugin] = catalog.plugins;
    expect(plugin).toMatchObject({ id: "tomrade/notebook", title: "Memo", license: "MIT", repository: "https://github.com/haoyuant/tomrade-plugins" });
    expect(plugin!.versions[0]).toMatchObject({ version: "0.1.0", commit: "a".repeat(40), digest: first.digest, url: "tomrade-notebook-0.1.0.tomrade-plugin", risk: "low" });
    expect(verifyAttestation(plugin!.versions[0]!.attestation, first.digest!, { [key.keyId]: key.publicKey })).toMatchObject({ id: "tomrade/notebook", version: "0.1.0" });

    // The same build again changes nothing; another build under the same version is refused.
    const again = await release(dir, { privateKey: key.privateKey, out, commit: "b".repeat(40), catalog: first.catalog! });
    expect(again).toMatchObject({ unchanged: true, file: null });
    fs.appendFileSync(path.join(dir, "CHANGELOG.md"), "- Edited after the release.\n");
    await expect(release(dir, { privateKey: key.privateKey, out, commit: "c".repeat(40), catalog: first.catalog! })).rejects.toThrow(/released already as another build/);

    editManifest(dir, (m) => (m.version = "0.2.0"));
    fs.appendFileSync(path.join(dir, "CHANGELOG.md"), "\n## 0.2.0\n\n- A comment.\n");
    const revoked = path.join(tmp, "revoked.json");
    fs.writeFileSync(revoked, JSON.stringify([{ id: "tomrade/notebook", versions: "0.1.0", reason: "loses notes" }]));
    const second = await release(dir, { privateKey: key.privateKey, out, commit: "d".repeat(40), catalog: first.catalog!, revoked });
    const next = parseCatalog(JSON.parse(fs.readFileSync(second.catalog!, "utf8"))).catalog;
    expect(next.plugins[0]!.versions.map((v) => v.version)).toEqual(["0.1.0", "0.2.0"]);
    expect(next.revoked).toEqual([{ id: "tomrade/notebook", versions: "0.1.0", reason: "loses notes" }]);
  }, 120_000);

  it("releases nothing that falls short of the standard", async () => {
    const dir = path.join(tmp, "plain");
    scaffold(dir, { id: "tomrade/plain", title: "Plain", description: "Plain." });
    const result = await release(dir, { privateKey: key.privateKey, out: path.join(tmp, "nothing"), commit: "e".repeat(40) });
    expect(result).toMatchObject({ file: null, catalog: null });
    expect(result.report.official.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tmp, "nothing", "catalog.json"))).toBe(false);
  }, 60_000);
});
