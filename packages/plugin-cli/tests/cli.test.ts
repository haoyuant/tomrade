import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MANIFEST_FILE } from "@tomradex/plugin-sdk";
import { unpackPlugin } from "@tomradex/plugin-kit";
import { check, pack, scaffold, sdkImportsOf, test } from "@tomradex/plugin-cli";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-cli-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const manifestOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8")) as Record<string, unknown>;

describe("tomrade-plugin", () => {
  it("scaffolds a plugin that builds, passes its own scenario, and packs", async () => {
    const dir = path.join(tmp, "counter");
    scaffold(dir, { id: "someone/counter", title: "Counter", description: "Counts open issues." });
    const report = await check(dir);
    expect(report.problems).toEqual([]);
    expect(report.verdict).toBe("ok");
    expect(manifestOf(dir)).toMatchObject({ inject: ["items", "tools", "contributions"], contributes: { tools: ["counter_count_open"], statusItems: ["counter"] } });
    expect(report.publishing).toEqual([expect.stringMatching(/repository/)]);

    const result = await test(dir, { build: false });
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["loads", "counts open issues", "shows the count in the status bar"]));

    const { file } = await pack(dir, { out: path.join(tmp, "counter.tomrade-plugin") });
    const unpacked = await unpackPlugin(file!);
    expect(fs.existsSync(path.join(unpacked.dir, "src"))).toBe(false);
    expect(fs.existsSync(path.join(unpacked.dir, "dist/index.js"))).toBe(true);
  }, 60_000);

  it("runs a local agent's scenario in the sandbox, which may not listen, and takes its installer by address", async () => {
    const dir = path.join(tmp, "acme");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ id: "someone/acme", version: "0.1.0", title: "Acme", license: "MIT", engines: { sdk: "^0.2.18" }, main: "dist/index.js", permissions: { exec: true, fs: "any" }, inject: ["agent"] }));
    fs.writeFileSync(
      path.join(dir, "src/index.ts"),
      `import { definePlugin } from "@tomradex/plugin-sdk";
export default definePlugin({
  inject: ["agent"],
  async apply(ctx) {
    await ctx.agent.localAgent({ id: "acme", title: "Acme", cli: { name: "acme" }, install: "install Acme ({install})", setup: { install: [{ script: "https://acme.example/install.sh" }] }, picks: [{ key: "model", title: "Model", choices: [], freeText: true }] });
  }
});
`
    );
    fs.writeFileSync(
      path.join(dir, "src/test.ts"),
      `export default async function scenario(t: any) {
  const engine = t.localAgents.engine("acme");
  t.check("registers the agent with its installer written out", engine?.terminalOnly === true && engine.setup.install[0].startsWith("curl -fsSL https://acme.example/install.sh "), JSON.stringify(engine));
}
`
    );
    const report = await check(dir);
    expect(report.problems).toEqual([]);
    expect(report.analysis.findings.filter((f) => f.severity === "critical")).toEqual([]);
    expect(report.manifest?.contributes?.localAgents).toEqual(["acme"]);
    const result = await test(dir, { build: false });
    expect(result.error).toBeUndefined();
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.checks.map((c) => c.name)).toContain("registers the agent with its installer written out");

    // An older SDK range cannot show the installer.
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ ...manifestOf(dir), engines: { sdk: "^0.2.17" } }));
    expect((await check(dir)).problems).toEqual([expect.stringMatching(/installer script needs SDK 0\.2\.18/)]);
  }, 60_000);

  it("checks and runs an IM adapter against the real IM layer and Agent", async () => {
    const dir = path.join(tmp, "fake-im");
    fs.cpSync(path.join(import.meta.dirname, "../../im/tests/fixtures/fake-adapter"), dir, { recursive: true });
    const report = await check(dir);
    expect(report.problems).toEqual([]);
    expect(report.verdict).toBe("ok");
    expect(report.manifest?.contributes?.imAdapters).toEqual(["fake_im"]);
    expect(report.imAdapters).toEqual([{ id: "fake_im", contract: "0.2.2", capabilities: [] }]);
    expect(report.notes).toEqual([]);
    const result = await test(dir, { build: false });
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["outside allowlist creates no conversation", "one execution despite duplicate"]));
  }, 60_000);

  it("recognizes an IM adapter written against contract 0.2.5", async () => {
    const dir = path.join(tmp, "fake-im-v2");
    fs.cpSync(path.join(import.meta.dirname, "../../im/tests/fixtures/fake-adapter"), dir, { recursive: true });
    const source = path.join(dir, "src/index.ts");
    fs.writeFileSync(source, fs.readFileSync(source, "utf8").replace("maxFileBytes: 0 }", 'maxFileBytes: 0, stream: "native", reactions: true, markdown: "slack" }'));
    const lenient = await check(dir);
    expect(lenient.verdict).toBe("ok");
    expect(lenient.imAdapters).toEqual([{ id: "fake_im", contract: "0.2.5", capabilities: ["reactions", "stream", "markdown"] }]);
    expect(lenient.notes).toEqual([expect.stringMatching(/fake_im.*\^0\.2\.5/)]);

    const manifest = path.join(dir, "tomrade-plugin.json");
    fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace("^0.2.2", "^0.2.5"));
    expect((await check(dir)).notes).toEqual([]);

    fs.writeFileSync(source, fs.readFileSync(source, "utf8").replace('stream: "native"', 'stream: "sometimes"'));
    const invalid = await check(dir);
    expect(invalid.verdict).toBe("blocked");
    expect(invalid.problems).toEqual([expect.stringMatching(/IM adapter "fake_im" declares invalid capabilities: stream/)]);
  }, 60_000);

  it("blocks a plugin whose ids leave its namespace", async () => {
    const dir = path.join(tmp, "stray");
    scaffold(dir, { id: "someone/stray" });
    fs.writeFileSync(
      path.join(dir, "src/index.ts"),
      `import { definePlugin } from "@tomradex/plugin-sdk";
       export default definePlugin({ inject: ["contributions"], async apply(ctx) { await ctx.contributions.badge({ id: "blocked", compute: () => ({}) }); } });`
    );
    const report = await check(dir);
    expect(report.verdict).toBe("blocked");
    expect(report.problems).toEqual([expect.stringMatching(/badge "blocked" must start with the namespace/)]);
  }, 60_000);

  it("checks a full-mode plugin for its shape, labels what it can reach, and leaves running it to Tomrade", async () => {
    const dir = path.join(tmp, "deep");
    scaffold(dir, { id: "someone/deep" });
    fs.writeFileSync(path.join(dir, "src/index.ts"), `export default { name: "deep", inject: ["llm"], apply() {} };`);
    const manifest = { ...manifestOf(dir), engines: { sdk: "^0.2.13", tomrade: ">=0.13.0" }, context: "full", rows: [{ id: "web-search-tavily", disabled: true }] };
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
    const report = await check(dir);
    expect(report.problems).toEqual([]);
    expect(report.verdict).toBe("review");
    expect(report.risk).toEqual({ level: "high", reasons: ["full", "rows"] });
    expect(report.analysis!.findings.map((f) => f.rule)).toEqual(expect.arrayContaining(["full-context", "rows"]));
    expect(report.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^full mode: /)]));
    // Nothing of the SDK's is stamped: it names no SDK services.
    expect(manifestOf(dir)).not.toHaveProperty("contributes");
    expect((await test(dir, { build: false })).error).toMatch(/plugin_try/);

    fs.writeFileSync(path.join(dir, "src/index.ts"), `export default 42;`);
    expect((await check(dir)).problems).toEqual([expect.stringMatching(/a cordis plugin/)]);
  }, 60_000);

  it("blocks an import from the SDK that the oldest Tomrade its engines.sdk accepts does not have", async () => {
    const dir = path.join(tmp, "speaks");
    scaffold(dir, { id: "someone/speaks" });
    fs.writeFileSync(
      path.join(dir, "src/index.ts"),
      `import { definePlugin, wordsFor } from "@tomradex/plugin-sdk";
       export default definePlugin({ inject: ["settings"], async apply(ctx) { wordsFor(await ctx.settings.locale(), { en: "Hi", zh: "你好" }); } });`
    );
    const edit = (sdk: string) => fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ ...manifestOf(dir), engines: { sdk } }, null, 2));
    edit("^0.2.6");
    const old = await check(dir);
    expect(old.verdict).toBe("blocked");
    expect(old.problems).toEqual([
      'imports "wordsFor" from @tomradex/plugin-sdk, which Tomrade has from SDK 0.2.9; engines.sdk "^0.2.6" also accepts SDK 0.2.6, where the plugin fails to load',
      expect.stringMatching(/^raise engines.sdk to "\^0.2.9"/)
    ]);
    edit("^0.2.9");
    expect((await check(dir)).problems).toEqual([]);
  }, 60_000);

  it("reads which names a built plugin takes from the SDK", () => {
    expect(sdkImportsOf(`import { definePlugin, wordsFor as w } from "@tomradex/plugin-sdk";\nimport { z } from "zod";\nexport { satisfies } from "@tomradex/plugin-sdk";`)).toEqual({ names: ["definePlugin", "satisfies", "wordsFor"], namespace: false });
    expect(sdkImportsOf(`import * as sdk from "@tomradex/plugin-sdk";`)).toEqual({ names: [], namespace: true });
  });

  it("runs a plugin where it cannot write to disk or start a program", async () => {
    const dir = path.join(tmp, "escape");
    scaffold(dir, { id: "someone/escape" });
    const target = path.join(os.homedir(), `tomrade-sandbox-escape-${process.pid}.txt`);
    fs.writeFileSync(
      path.join(dir, "src/index.ts"),
      `import fs from "node:fs"; import { execSync } from "node:child_process";
       import { definePlugin } from "@tomradex/plugin-sdk";
       export default definePlugin({ inject: ["tools"], async apply(ctx) {
         let wrote = "no", ran = "no";
         try { fs.writeFileSync(${JSON.stringify(target)}, "x"); wrote = "yes"; } catch (e) { wrote = e.code; }
         try { execSync("echo hi"); ran = "yes"; } catch (e) { ran = e.code; }
         await ctx.tools.register({ name: "escape_report", title: "r", description: "r", input: (await import("zod")).z.object({}), execute: () => wrote + "," + ran });
       } });`
    );
    fs.writeFileSync(path.join(dir, "src/test.ts"), `export default async (t) => t.check("report", true, String(await t.tool("escape_report")));`);
    const result = await test(dir);
    expect(result.checks.find((c) => c.name === "report")?.detail).toBe("ERR_ACCESS_DENIED,ERR_ACCESS_DENIED");
    expect(fs.existsSync(target)).toBe(false);
    const report = await check(dir, { build: false });
    expect(report.analysis?.findings.map((f) => f.rule)).toEqual(expect.arrayContaining(["exec", "undeclared-exec", "undeclared-fs"]));
    expect(report.verdict).toBe("review");
  }, 60_000);
});
