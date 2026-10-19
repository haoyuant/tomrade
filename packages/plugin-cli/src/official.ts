import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import { OFFICIAL_PUBLISHER, SDK_CONTRACT, nameOf, publisherOf, satisfies, type Manifest } from "@tomradex/plugin-sdk";
import { publishingProblems } from "./check.js";

/** Text written for people as `{ en, zh }` where one half is missing. */
export interface BilingualGap {
  file: string;
  line: number;
  missing: "en" | "zh";
}

const SOURCE = /\.(ts|tsx|js|jsx|mts|mjs)$/;

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return SOURCE.test(e.name) && !/\.d\.ts$/.test(e.name) ? [full] : [];
  });
}

const keyOf = (prop: { type: string; key?: { type: string; name?: string; value?: unknown }; computed?: boolean }): string | null => {
  if (prop.type !== "ObjectProperty" || prop.computed || !prop.key) return null;
  if (prop.key.type === "Identifier") return prop.key.name ?? null;
  if (prop.key.type === "StringLiteral") return String(prop.key.value);
  return null;
};

/** Every object literal in the plugin's source that carries `en` or `zh` must carry both. */
export function bilingualGaps(srcDir: string): BilingualGap[] {
  const gaps: BilingualGap[] = [];
  for (const file of sourceFiles(srcDir)) {
    let ast: unknown;
    try {
      ast = parse(fs.readFileSync(file, "utf8"), { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: true });
    } catch {
      continue;
    }
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      const n = node as { type?: string; properties?: Parameters<typeof keyOf>[0][]; loc?: { start: { line: number } } };
      if (n.type === "ObjectExpression" && n.properties) {
        const keys = new Set(n.properties.map(keyOf));
        if (keys.has("en") !== keys.has("zh")) gaps.push({ file: path.relative(path.dirname(srcDir), file), line: n.loc?.start.line ?? 0, missing: keys.has("en") ? "zh" : "en" });
      }
      for (const [k, v] of Object.entries(n)) if (k !== "loc" && k !== "start" && k !== "end") walk(v);
    };
    walk(ast);
  }
  return gaps;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The standard a plugin from Tomrade's own repository meets before it is
 * signed: everything the store asks of any plugin, plus what a person
 * installing an official plugin is promised. Running its tests is the
 * release's job; this says what is missing.
 */
export function officialProblems(dir: string, manifest: Manifest): string[] {
  const out = [...publishingProblems(dir, manifest)];
  const files = fs.readdirSync(dir);
  const name = nameOf(manifest.id);
  if (publisherOf(manifest.id) !== OFFICIAL_PUBLISHER) out.push(`an official plugin's id is ${OFFICIAL_PUBLISHER}/<name>, not ${manifest.id}`);
  if (path.basename(dir) !== name) out.push(`an official plugin lives in packages/${name}, not ${path.basename(dir)}`);
  if (!satisfies(SDK_CONTRACT, manifest.engines.sdk)) out.push(`engines.sdk "${manifest.engines.sdk}" does not include this Tomrade's SDK ${SDK_CONTRACT}`);
  if (!manifest.icon) out.push("icon is not set; name an SVG or PNG in the plugin folder");
  else if (!fs.existsSync(path.join(dir, manifest.icon))) out.push(`icon ${manifest.icon} does not exist`);
  const changelog = files.find((f) => /^CHANGELOG/i.test(f));
  if (!changelog) out.push("a CHANGELOG must say what changed in each version");
  else if (!new RegExp(`^#+\\s*\\[?v?${escape(manifest.version)}\\]?(\\s|$)`, "m").test(fs.readFileSync(path.join(dir, changelog), "utf8"))) out.push(`${changelog} has no entry for ${manifest.version}`);
  if (!fs.existsSync(path.join(dir, "src", "test.ts"))) out.push("src/test.ts, the sandbox scenario, is missing");
  if (!sourceFiles(path.join(dir, "tests")).some((f) => /\.test\.[cm]?[jt]sx?$/.test(f))) out.push("tests/ has no unit tests");
  for (const gap of bilingualGaps(path.join(dir, "src"))) out.push(`${gap.file}:${gap.line} has text without its ${gap.missing === "zh" ? "Chinese (zh)" : "English (en)"} half`);
  const p = manifest.permissions;
  if (p.network.includes("*") && !p.why?.network) out.push('permissions.network "*" (any host) needs permissions.why.network; list the hosts instead where you can');
  if (p.fs === "any" && !p.why?.fs) out.push('permissions.fs "any" needs permissions.why.fs');
  if (p.exec && !p.why?.exec) out.push("permissions.exec needs permissions.why.exec");
  if (p.window && !p.why?.window) out.push("permissions.window needs permissions.why.window");
  return out;
}
