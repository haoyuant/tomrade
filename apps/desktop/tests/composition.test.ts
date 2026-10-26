import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isPlugin, readConfig } from "../src/loader.js";

// Every row reaches for Electron when the app runs it; loading one must not need it.
vi.mock("electron", () => ({}));

const DESKTOP = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(DESKTOP, "../..");

/**
 * The file a row's name stands for: the app's own `src/x.ts` for `./dist/x.js`,
 * else the package entry its `exports` name, which `tsc` builds from `src/`.
 * Null for anything this test cannot find, so the row fails with a reason.
 */
function sourceOf(name: string): string | null {
  const own = /^\.\/dist\/(.+)\.js$/.exec(name);
  if (own) return path.join(DESKTOP, "src", `${own[1]}.ts`);
  if (name.startsWith(".") || path.isAbsolute(name)) return null;
  const [scope, pkg, ...rest] = name.split("/");
  if (!scope || !pkg) return null;
  const dir = path.join(ROOT, "packages", pkg);
  const manifest = path.join(dir, "package.json");
  if (!fs.existsSync(manifest)) return null;
  const targets = (JSON.parse(fs.readFileSync(manifest, "utf8")) as { exports?: Record<string, string | { default?: string }> }).exports ?? {};
  const target = targets[rest.length ? `./${rest.join("/")}` : "."];
  const built = typeof target === "string" ? target : target?.default;
  const entry = built ? /^\.\/dist\/(.+)\.js$/.exec(built) : null;
  return entry ? path.join(dir, "src", `${entry[1]}.ts`) : null;
}

describe("the composition the app boots", () => {
  it("loads every module tomrade.yml declares", async () => {
    const { rows } = readConfig(path.join(DESKTOP, "tomrade.yml"));
    const problems: string[] = [];
    for (const row of rows) {
      const file = sourceOf(row.name);
      if (!file) {
        problems.push(`${row.id}: ${row.name} is not a module this test can find`);
        continue;
      }
      if (!fs.existsSync(file)) {
        problems.push(`${row.id}: ${row.name} has no ${path.relative(ROOT, file)}`);
        continue;
      }
      const mod = (await import(pathToFileURL(file).href).catch((error: unknown) => error)) as Record<string, unknown> | Error;
      if (mod instanceof Error) {
        problems.push(`${row.id}: ${row.name} does not load — ${mod.message}`);
        continue;
      }
      // What the loader hands cordis: the default export, else the module itself.
      if (!isPlugin(mod.default ?? mod)) problems.push(`${row.id}: ${row.name} does not export a plugin (a function, a class, or an object with apply())`);
    }
    expect(problems).toEqual([]);
  }, 120_000);
});
