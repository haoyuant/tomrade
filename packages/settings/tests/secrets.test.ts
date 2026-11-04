import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import { Settings, type SecretCipher } from "@tomradex/settings";
import { fresh } from "@tomradex/testkit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-settings-secrets-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `settings-${n++}.json`);

/** A keychain stand-in: reversible, keyed, and visibly not the plain text. */
function keychain(key = "k1", up = true): SecretCipher & { calls: number } {
  const c = {
    calls: 0,
    available: () => up,
    encrypt: (value: string) => { c.calls++; return Buffer.from(`${key}|${[...value].reverse().join("")}`); },
    decrypt: (value: Buffer) => {
      const [k, body] = value.toString().split("|");
      if (k !== key) throw new Error("wrong key");
      return [...body!].reverse().join("");
    }
  };
  return c;
}

const SECRETS = {
  models: { profiles: [{ id: "p1", provider: "openai-compatible", model: "deepseek-chat", baseURL: "https://api.deepseek.com", apiKey: "sk-live-111" }], roles: { worker: "" } },
  github: { token: "ghp_222" },
  mcpServers: { servers: [{ id: "remote", transport: { type: "http", url: "https://mcp.example", headers: { "X-Team": "team-333" } } }, { id: "local", transport: { type: "stdio", command: "npx", env: { HOME_DIR: "/home/444" } } }] },
  im: { connections: [{ id: "bot", adapterId: "feishu", credentials: { appId: "cli_555", appSecret: "s-666" } }] }
};

async function open(p: string, cipher?: SecretCipher) {
  const { ctx } = await fresh({ plugins: [[Settings, { path: p, cipher }]] });
  // A plugin's own section, the way @tomradex/github declares its token.
  ctx.settings.register({ id: "github", title: "GitHub", schema: z.object({ token: z.string().meta({ format: "password" }) }), defaults: { token: "" } });
  return ctx;
}

it("keeps keys, tokens, headers and env values encrypted in the file, and plain in use", async () => {
  const p = file();
  const cipher = keychain();
  const ctx = await open(p, cipher);
  ctx.settings.set({ ...ctx.settings.get(), ...SECRETS });
  const text = fs.readFileSync(p, "utf8");
  for (const secret of ["sk-live-111", "ghp_222", "team-333", "/home/444", "cli_555", "s-666"]) expect(text).not.toContain(secret);
  // What isn't secret stays readable.
  expect(text).toContain("deepseek-chat");
  expect(text).toContain("https://api.deepseek.com");
  expect(JSON.parse(text).github.token).toMatch(/^tomrade-encrypted:v1:/);
  // POSIX modes only; Windows has no 0600.
  if (process.platform !== "win32") expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  expect(ctx.settings.secretStorage()).toBe("keychain");

  const again = await open(p, cipher);
  expect(again.settings.get().github).toEqual({ token: "ghp_222" });
  expect(again.settings.get().models.profiles[0].apiKey).toBe("sk-live-111");
  expect((again.settings.get().mcpServers as typeof SECRETS.mcpServers).servers[0]!.transport.headers).toEqual({ "X-Team": "team-333" });
  expect((again.settings.get().im as typeof SECRETS.im).connections[0]!.credentials).toEqual({ appId: "cli_555", appSecret: "s-666" });
});

it("seals a plain file the first time it is opened, and loosens nothing", async () => {
  const p = file();
  fs.writeFileSync(p, JSON.stringify({ theme: "dark", ...SECRETS }), { mode: 0o644 });
  const ctx = await open(p, keychain());
  expect(ctx.settings.get().github).toEqual({ token: "ghp_222" });
  const text = fs.readFileSync(p, "utf8");
  expect(text).not.toContain("ghp_222");
  expect(text).not.toContain("sk-live-111");
  expect(JSON.parse(text).theme).toBe("dark");
  // POSIX modes only; Windows has no 0600.
  if (process.platform !== "win32") expect(fs.statSync(p).mode & 0o777).toBe(0o600);
});

it("a key it can't decrypt reads as empty, with a warning, and is kept until it is set again", async () => {
  const p = file();
  const first = await open(p, keychain("k1"));
  first.settings.set({ ...first.settings.get(), ...SECRETS });
  const sealed = JSON.parse(fs.readFileSync(p, "utf8")).github.token;

  const { ctx } = await fresh({ plugins: [[Settings, { path: p, cipher: keychain("k2") }]] });
  ctx.settings.register({ id: "github", title: "GitHub", schema: z.object({ token: z.string().meta({ format: "password" }) }), defaults: { token: "" } });
  expect(ctx.settings.get().github).toEqual({ token: "" });
  expect(ctx.settings.get().models.profiles[0].apiKey).toBe("");
  // Another save doesn't overwrite what this keychain can't read.
  ctx.settings.set({ ...ctx.settings.get(), theme: "matcha" });
  expect(JSON.parse(fs.readFileSync(p, "utf8")).github.token).toBe(sealed);
  // Entering it again replaces it.
  ctx.settings.set({ ...ctx.settings.get(), github: { token: "ghp_new" } });
  const reopened = await open(p, keychain("k2"));
  expect(reopened.settings.get().github).toEqual({ token: "ghp_new" });
});

it("warns when a saved key can't be decrypted", async () => {
  const p = file();
  const first = await open(p, keychain("k1"));
  first.settings.set({ ...first.settings.get(), github: { token: "ghp_222" } });
  const warnings: string[] = [];
  const { ctx } = await fresh({ plugins: [] });
  ctx.logger.exporter({ colors: 0, export: (message: { type: string; args: unknown[] }) => void (message.type === "warn" && warnings.push(String(message.args[0]))) } as never);
  await ctx.plugin(Settings, { path: p, cipher: keychain("k2") });
  expect(warnings.some((w) => w.includes("can't be decrypted on this system"))).toBe(true);
});

it("without a usable keychain, keys stay plain text and still work", async () => {
  for (const cipher of [undefined, keychain("k1", false)]) {
    const p = file();
    const ctx = await open(p, cipher);
    expect(ctx.settings.secretStorage()).toBe("plaintext");
    ctx.settings.set({ ...ctx.settings.get(), github: { token: "ghp_plain" } });
    expect(JSON.parse(fs.readFileSync(p, "utf8")).github.token).toBe("ghp_plain");
    expect((await open(p, cipher)).settings.get().github).toEqual({ token: "ghp_plain" });
  }
});
