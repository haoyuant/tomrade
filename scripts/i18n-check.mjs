/**
 * How complete and current each partial UI locale (packages/ui/src/lib/i18n-messages/locales/) is.
 * A string a locale lacks shows in English, so a check only warns and exits 0.
 * A translation is stale when the English it was made from has changed since; source-hashes.json
 * keeps a short hash of that English per translated key.
 *
 *   pnpm i18n:check                     counts per locale, grouped by namespace
 *   pnpm i18n:check de ja               …only these locales
 *   pnpm i18n:check --keys              …and every key
 *   pnpm i18n:check --update de         after translating de: record the English its strings now come from (no locale: all)
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const messagesDir = path.join(root, "packages/ui/src/lib/i18n-messages");
const hashesFile = path.join(messagesDir, "locales/source-hashes.json");

export const sourceHash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 8);

/** Per locale: the keys it lacks, the ones whose English changed since they were translated, and the ones with no recorded source. */
export function checkLocales(en, locales, hashes) {
  const report = {};
  for (const [locale, dict] of Object.entries(locales)) {
    const result = { missing: [], stale: [], unrecorded: [] };
    for (const [ns, entries] of Object.entries(en)) {
      for (const [key, text] of Object.entries(entries)) {
        const id = `${ns}.${key}`;
        if (typeof dict[ns]?.[key] !== "string") result.missing.push(id);
        else if (hashes[locale]?.[ns]?.[key] === undefined) result.unrecorded.push(id);
        else if (hashes[locale][ns][key] !== sourceHash(text)) result.stale.push(id);
      }
    }
    report[locale] = result;
  }
  return report;
}

/** The hashes of the English each of the locale's translations stands for now; keys it no longer translates drop out. */
export function recordHashes(en, dict) {
  const out = {};
  for (const ns of Object.keys(dict).sort()) {
    for (const key of Object.keys(dict[ns]).sort()) {
      const text = en[ns]?.[key];
      if (typeof text !== "string" || typeof dict[ns][key] !== "string") continue;
      (out[ns] ??= {})[key] = sourceHash(text);
    }
  }
  return out;
}

/** "ledger 40, repositories 30, …" — namespaces by count, most first. */
export function byNamespace(ids) {
  const counts = new Map();
  for (const id of ids) {
    const ns = id.slice(0, id.indexOf("."));
    counts.set(ns, (counts.get(ns) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([ns, n]) => `${ns} ${n}`).join(", ");
}

async function loadMessages() {
  const { registerHooks } = await import("node:module");
  // The messages are TypeScript with extensionless relative imports, as the bundler resolves them; node strips the types itself.
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (err) {
        if (!specifier.startsWith(".")) throw err;
        return next(`${specifier}.ts`, context);
      }
    }
  });
  const { en } = await import(pathToFileURL(path.join(messagesDir, "index.ts")).href);
  const locales = await import(pathToFileURL(path.join(messagesDir, "locales/index.ts")).href);
  return { en, locales: { ...locales } };
}

function readHashes() {
  try {
    return JSON.parse(fs.readFileSync(hashesFile, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function main(argv) {
  const update = argv.includes("--update") || argv.includes("--accept");
  const listKeys = argv.includes("--keys");
  const named = argv.filter((a) => !a.startsWith("-"));
  const { en, locales } = await loadMessages();
  const unknown = named.filter((l) => !(l in locales));
  if (unknown.length) {
    console.error(`i18n: no locale ${unknown.join(", ")} (there are ${Object.keys(locales).join(", ")})`);
    return 1;
  }
  const chosen = named.length ? named : Object.keys(locales);
  const hashes = readHashes();
  const rel = path.relative(root, hashesFile);

  if (update) {
    for (const locale of chosen) hashes[locale] = recordHashes(en, locales[locale]);
    const sorted = Object.fromEntries(Object.keys(hashes).sort().map((l) => [l, hashes[l]]));
    fs.writeFileSync(hashesFile, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`i18n: recorded the English behind ${chosen.join(", ")} in ${rel}`);
    return 0;
  }

  const total = Object.values(en).reduce((n, entries) => n + Object.keys(entries).length, 0);
  const report = checkLocales(en, Object.fromEntries(chosen.map((l) => [l, locales[l]])), hashes);
  console.log(`i18n: ${total} English strings; a string a locale lacks shows in English.`);
  const width = Math.max(...chosen.map((l) => l.length));
  for (const locale of chosen) {
    const r = report[locale];
    const counts = ["missing", "stale", "unrecorded"].filter((kind) => r[kind].length).map((kind) => `${kind} ${r[kind].length}`);
    console.log(`  ${locale.padEnd(width)}  ${counts.length ? counts.join(" · ") : "complete"}`);
    for (const kind of ["missing", "stale", "unrecorded"]) {
      if (!r[kind].length) continue;
      console.log(`  ${" ".repeat(width)}    ${kind}: ${byNamespace(r[kind])}`);
      if (listKeys) for (const id of r[kind]) console.log(`  ${" ".repeat(width)}      ${id}`);
    }
  }
  const any = (kind) => chosen.some((l) => report[l][kind].length);
  if (!listKeys && (any("missing") || any("stale") || any("unrecorded"))) console.log("--keys lists every key.");
  if (any("stale")) console.log("stale: English changed after the translation; fix the translation, then `pnpm i18n:check --update <locale>`.");
  if (any("unrecorded")) console.log("unrecorded: no English on record for a translation; `pnpm i18n:check --update <locale>` records it.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
