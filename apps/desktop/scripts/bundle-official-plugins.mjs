/**
 * Puts the official plugins tomrade.yml lists as starters into official-plugins/,
 * with the catalog they came from, so a machine that cannot reach GitHub still
 * gets them (the community row's officialBundle). Each is the version the app
 * would install, its digest and signature checked with the app's own keys.
 * Fails when one cannot be had: a release never goes out without them.
 * Needs the backend built (pnpm build:backend); scripts/package.mjs runs it.
 *
 *   pnpm --filter @tomrade/desktop bundle:official
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { OFFICIAL_CATALOG_URL, bundleOfficialPlugins } from "@tomradex/community";
import { verifyAttestation } from "@tomradex/plugin-kit";
import { trustedKeys } from "../dist/trust.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "..");
const { plugins } = parse(fs.readFileSync(path.join(desktop, "tomrade.yml"), "utf8"));
const config = plugins.find((row) => row.id === "community")?.config ?? {};
const ids = (config.starters ?? []).map((s) => (typeof s === "string" ? s : s.id));
const keys = trustedKeys();

try {
  const bundled = await bundleOfficialPlugins({
    url: config.officialCatalog?.url ?? OFFICIAL_CATALOG_URL,
    ids,
    dir: path.join(desktop, "official-plugins"),
    verify: (raw, digest) => verifyAttestation(raw, digest, keys)
  });
  for (const b of bundled) console.log(`official-plugins: ${b.id} ${b.version}`);
} catch (error) {
  console.error(`official-plugins: not every starter could be bundled\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
