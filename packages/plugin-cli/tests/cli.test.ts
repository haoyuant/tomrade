import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MANIFEST_FILE } from "@tomradex/plugin-sdk";
import { unpackPlugin } from "@tomradex/plugin-kit";
import { check, pack, scaffold, test } from "@tomradex/plugin-cli";

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
