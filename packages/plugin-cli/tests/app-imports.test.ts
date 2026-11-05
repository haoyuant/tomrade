import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { appExports, appImportProblems, build, type AppExports } from "@tomradex/plugin-cli";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-app-imports-"));
const file = (code: string) => {
  const f = path.join(tmp, `${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(f, code);
  return f;
};
const app: AppExports = { tomrade: "0.14.0", modules: { "@tomradex/llm": ["Llm", "collect"], "@tomradex/llm/provider": ["default"] } };
const full = { context: "full" as const, engines: { sdk: "^0.2.13", tomrade: ">=0.14.0 <0.15.0" } };

it("holds a full-mode plugin's imports of the app's packages to the Tomrade it names, and an SDK plugin to none", () => {
  const code = file(`import { Llm, collect } from "@tomradex/llm";\nimport row from "@tomradex/llm/provider";\nimport { gone } from "@tomradex/llm";\nimport { x } from "@tomradex/nowhere";\nimport { definePlugin } from "@tomradex/plugin-sdk";`);
  expect(appImportProblems(code, full, app).problems).toEqual(['imports "gone" from @tomradex/llm, which Tomrade 0.14.0 does not export', "imports @tomradex/nowhere, which Tomrade 0.14.0 does not have"]);
  expect(appImportProblems(code, { ...full, engines: { ...full.engines, tomrade: ">=0.15.0" } }, app)).toEqual({ problems: [], notes: [expect.stringContaining('outside engines.tomrade ">=0.15.0"')] });
  expect(appImportProblems(code, { context: "sdk", engines: { sdk: "^0.2.16" } }, app).problems).toEqual([
    expect.stringContaining("imports @tomradex/llm, which only a full-mode plugin gets"),
    expect.stringContaining("imports @tomradex/llm/provider"),
    expect.stringContaining("imports @tomradex/nowhere")
  ]);
  // the SDK and the domain types are every plugin's
  expect(appImportProblems(file(`import { z } from "@tomradex/domain";\nimport { definePlugin } from "@tomradex/plugin-sdk";`), { context: "sdk", engines: { sdk: "^0.2.16" } }, app)).toEqual({ problems: [], notes: [] });
});

// It reads every package and runs a real build: a shared two-core runner takes longer than the default 5 s.
it("knows the checkout's packages, and builds a full-mode plugin with them left to the app", { timeout: 30_000 }, async () => {
  const known = await appExports();
  expect(known?.tomrade).toBeNull();
  expect(known?.modules["@tomradex/llm"]).toContain("Llm");
  const dir = path.join(tmp, "full");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tomrade-plugin.json"), JSON.stringify({ id: "someone/full", version: "1.0.0", title: "Full", license: "MIT", engines: { sdk: "^0.2.13", tomrade: ">=0.14.0" }, context: "full" }));
  fs.writeFileSync(path.join(dir, "src/index.ts"), `import { Llm } from "@tomradex/llm";\nexport default { name: "full", apply() { return Llm; } };\n`);
  const built = await build(dir);
  expect(built).toMatchObject({ ok: true, bundled: [] });
  expect(fs.readFileSync(built.outfile, "utf8")).toContain('from "@tomradex/llm"');
});
