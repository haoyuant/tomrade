/**
 * How complete and current each partial UI locale (packages/ui/src/lib/i18n-messages/locales/) is.
 * A string a locale lacks shows in English, so a check only warns and exits 0.
 * A translation is stale when its English changed in a later commit than the translation's own line (git blame);
 * editing the translation (committed or not) makes it current again. Without git history, only missing keys are told.
 *
 *   pnpm i18n:check              counts per locale, grouped by namespace
 *   pnpm i18n:check de ja        …only these locales
 *   pnpm i18n:check --keys       …and every key
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const messagesDir = path.join(root, "packages/ui/src/lib/i18n-messages");

/** Per locale: the keys it lacks, and the translated ones `stale` names (absent: not checked). */
export function checkLocales(en, locales, stale) {
  const report = {};
  for (const [locale, dict] of Object.entries(locales)) {
    const result = { missing: [], stale: [] };
    for (const [ns, entries] of Object.entries(en)) {
      for (const key of Object.keys(entries)) {
        const id = `${ns}.${key}`;
        if (typeof dict[ns]?.[key] !== "string") result.missing.push(id);
        else if (stale?.[locale]?.has(id)) result.stale.push(id);
      }
    }
    report[locale] = result;
  }
  return report;
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

/**
 * The lines each property of a message file's object literals spans, by dotted path from the `const`
 * that holds it ("about.en.label" → [3, 3]). Only properties whose value is not itself an object.
 */
export function keyLines(source) {
  const out = new Map();
  const stack = [];
  let line = 1;
  let i = 0;
  let prev = null;
  let constName = null;
  let leaf = null;
  let lastLine = 1;
  const finish = () => {
    if (leaf) out.set(leaf.path, [leaf.start, lastLine]);
    leaf = null;
  };
  while (i < source.length) {
    const c = source[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      const end = source[i + 1] === "/" ? source.indexOf("\n", i) : source.indexOf("*/", i) + 2;
      const stop = end < i + 2 ? source.length : end;
      line += (source.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop;
      continue;
    }
    let token;
    const startLine = line;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      const raw = source.slice(i, j + 1);
      line += (raw.match(/\n/g) ?? []).length;
      token = { name: raw.slice(1, -1) };
      i = j + 1;
    } else if (/[\w$]/.test(c)) {
      const m = /^[\w$]+/.exec(source.slice(i, i + 200));
      token = { name: m[0], word: true };
      i += m[0].length;
    } else {
      token = { punct: c };
      i++;
    }
    const top = stack.at(-1);
    if (token.punct === ":" && prev?.name !== undefined && top?.open === "{" && !leaf) {
      leaf = { path: [...stack.map((f) => f.name), prev.name].join("."), key: prev.name, start: prev.line, depth: stack.length };
    } else if (token.punct === "{" || token.punct === "[" || token.punct === "(") {
      let name = "?";
      if (token.punct === "{" && leaf?.depth === stack.length) {
        name = leaf.key;
        leaf = null;
      } else if (!stack.length && constName) name = constName;
      stack.push({ open: token.punct, name });
    } else if (token.punct === "}" || token.punct === "]" || token.punct === ")" || token.punct === ",") {
      if (leaf?.depth === stack.length && token.punct !== "]" && token.punct !== ")") finish();
      if (token.punct !== ",") stack.pop();
    }
    if (prev?.word && prev.name === "const" && token.name !== undefined) constName = token.name;
    if (token.punct !== "," && token.punct !== "}") lastLine = line;
    prev = { ...token, line: startLine };
  }
  return out;
}

/** The commit and commit time of each line of a file (1-based); an uncommitted line is the newest of all. */
export function parseBlame(porcelain) {
  const lines = [];
  let at = 0;
  for (const row of porcelain.split("\n")) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(row);
    if (head) {
      at = Number(head[2]);
      lines[at] = /^0+$/.test(head[1]) ? { commit: null, time: Infinity } : { commit: head[1], time: 0 };
    } else if (row.startsWith("committer-time ") && lines[at].commit) lines[at].time = Number(row.slice(15));
  }
  return lines;
}

/** The newest line of a span: when, and in which commit, the property last changed. */
const lastOf = (lines, [start, end]) => lines.slice(start, end + 1).reduce((a, b) => (b && b.time > a.time ? b : a), { commit: null, time: -1 });

/** A property's source text, without the separator after it, to compare one version with another. */
const textOf = (source, [start, end]) => source.split("\n").slice(start - 1, end).join("\n").trim().replace(/,$/, "");

const git = async (args) => (await run("git", args, { cwd: root, maxBuffer: 256 * 1024 * 1024 })).stdout;

async function blame(file) {
  try {
    // -w: a reindent is no change of wording; -M: a line moved within the file keeps its age.
    return parseBlame(await git(["blame", "-w", "-M", "--line-porcelain", "--", file]));
  } catch (err) {
    // A file git does not track yet is all new.
    if (/no such path/.test(err.stderr ?? "")) return [null, ...fs.readFileSync(file, "utf8").split("\n").map(() => ({ commit: null, time: Infinity }))];
    throw err;
  }
}

/**
 * Per locale, the translations whose English changed after them: blame says the English line is newer, and the
 * English text then differs from the one at the translation's commit (so an added comma or a reflow is no change).
 * Or why that cannot be told.
 */
async function findStale(locales) {
  try {
    if ((await git(["rev-parse", "--is-shallow-repository"])).trim() === "true") return { skipped: "a shallow clone has no history to compare" };
  } catch {
    return { skipped: "no git history here" };
  }
  // Which file defines each namespace: index.ts imports `{ ns, … } from "./file"` and maps `ns: ns.en`.
  const index = fs.readFileSync(path.join(messagesDir, "index.ts"), "utf8");
  const fileOf = new Map();
  for (const m of index.matchAll(/import \{([^}]+)\} from "\.\/([\w-]+)"/g)) for (const ns of m[1].split(",")) fileOf.set(ns.trim(), path.join(messagesDir, `${m[2]}.ts`));
  const localeFile = (l) => path.join(messagesDir, "locales", `${l}.ts`);
  try {
    const all = [...new Set(fileOf.values()), ...Object.keys(locales).map(localeFile)];
    const blamed = new Map();
    for (let i = 0; i < all.length; i += 8) {
      const batch = all.slice(i, i + 8);
      (await Promise.all(batch.map(blame))).forEach((lines, j) => blamed.set(batch[j], lines));
    }
    const english = new Map();
    for (const [ns, file] of fileOf) {
      const source = fs.readFileSync(file, "utf8");
      for (const [p, span] of keyLines(source)) {
        if (p.startsWith(`${ns}.en.`)) english.set(`${ns}.${p.slice(ns.length + 4)}`, { file, text: textOf(source, span), ...lastOf(blamed.get(file), span) });
      }
    }
    const past = new Map();
    const englishAt = async (commit, file) => {
      const id = `${commit}:${file}`;
      if (!past.has(id)) past.set(id, git(["show", `${commit}:${path.relative(root, file)}`]).then((source) => ({ source, lines: keyLines(source) }), () => null));
      return past.get(id);
    };
    const stale = {};
    for (const locale of Object.keys(locales)) {
      stale[locale] = new Set();
      for (const [p, span] of keyLines(fs.readFileSync(localeFile(locale), "utf8"))) {
        const id = p.slice(locale.length + 1);
        const source = english.get(id);
        const translated = lastOf(blamed.get(localeFile(locale)), span);
        if (!p.startsWith(`${locale}.`) || !source || !(source.time > translated.time)) continue;
        const then = translated.commit && (await englishAt(translated.commit, source.file));
        const ns = id.slice(0, id.indexOf("."));
        const before = then?.lines.get(`${ns}.en.${id.slice(ns.length + 1)}`);
        if (!before || textOf(then.source, before) !== source.text) stale[locale].add(id);
      }
    }
    return { stale };
  } catch (err) {
    return { skipped: `git failed (${String(err.stderr || err.message).trim().split("\n")[0]})` };
  }
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

async function main(argv) {
  const listKeys = argv.includes("--keys");
  const named = argv.filter((a) => !a.startsWith("-"));
  const { en, locales } = await loadMessages();
  const unknown = named.filter((l) => !(l in locales));
  if (unknown.length) {
    console.error(`i18n: no locale ${unknown.join(", ")} (there are ${Object.keys(locales).join(", ")})`);
    return 1;
  }
  const chosen = Object.fromEntries((named.length ? named : Object.keys(locales)).map((l) => [l, locales[l]]));
  const { stale, skipped } = await findStale(chosen);
  const report = checkLocales(en, chosen, stale);

  const total = Object.values(en).reduce((n, entries) => n + Object.keys(entries).length, 0);
  console.log(`i18n: ${total} English strings; a string a locale lacks shows in English.`);
  if (skipped) console.log(`stale translations not checked: ${skipped}.`);
  const names = Object.keys(chosen);
  const width = Math.max(...names.map((l) => l.length));
  for (const locale of names) {
    const r = report[locale];
    const counts = ["missing", "stale"].filter((kind) => r[kind].length).map((kind) => `${kind} ${r[kind].length}`);
    console.log(`  ${locale.padEnd(width)}  ${counts.length ? counts.join(" · ") : "complete"}`);
    for (const kind of ["missing", "stale"]) {
      if (!r[kind].length) continue;
      console.log(`  ${" ".repeat(width)}    ${kind}: ${byNamespace(r[kind])}`);
      if (listKeys) for (const id of r[kind]) console.log(`  ${" ".repeat(width)}      ${id}`);
    }
  }
  const any = (kind) => names.some((l) => report[l][kind].length);
  if (!listKeys && (any("missing") || any("stale"))) console.log("--keys lists every key.");
  if (any("stale")) console.log("stale: the English changed in a later commit than the translation; updating the translation clears it.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
