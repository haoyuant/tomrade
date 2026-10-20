/**
 * The local agents that left the app for official plugins (TOM-378), for the
 * checks that drive them: each plugin's build from a tomrade-plugins checkout
 * beside this one (TOMRADE_PLUGINS names another; `pnpm -r build` there), as
 * rows the composition loads the way an install would.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const dir = path.dirname(fileURLToPath(import.meta.url));

export const pluginsCheckout = () => process.env.TOMRADE_PLUGINS ?? path.resolve(dir, "../../../../tomrade-plugins");

/** Rows that load these plugins (folders under packages/) from their builds. */
export function officialAgentRows(folders) {
  return folders.map((folder) => {
    const main = path.join(pluginsCheckout(), "packages", folder, "dist", "index.js");
    if (!fs.existsSync(main)) throw new Error(`${main} is missing: build tomrade-plugins beside this checkout (pnpm -r build there), or name it with TOMRADE_PLUGINS`);
    return { id: `official-${folder}`, name: main };
  });
}

/** A file from a plugin's tests, such as a stand-in for its CLI. */
export const officialTestFile = (folder, file) => path.join(pluginsCheckout(), "packages", folder, "tests", file);

/**
 * The starters counted as put on already, so a check's run installs none of
 * them from the catalog mid-way: which engines exist stays what the check set up.
 */
export function quietStarters(userData) {
  const { plugins } = parse(fs.readFileSync(path.join(dir, "../tomrade.yml"), "utf8"));
  const starters = plugins.find((row) => row.id === "community")?.config?.starters ?? [];
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "official-starters.json"), JSON.stringify(starters.map((s) => (typeof s === "string" ? s : s.id))));
}
