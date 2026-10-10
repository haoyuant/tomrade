import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import { riskOf, type Manifest, type RiskLevel } from "@tomradex/plugin-sdk";
import { listFiles } from "./digest.js";

export type Severity = "info" | "warn" | "high" | "critical";

export interface Finding {
  /** Stable key: what the UI and the tests match on. */
  rule: string;
  severity: Severity;
  message: string;
  file: string;
  line: number;
  snippet?: string;
}

/** What the code can actually do, read off the code rather than the manifest. */
export interface Observed {
  network: boolean;
  hosts: string[];
  fs: boolean;
  exec: boolean;
  env: boolean;
  dynamicCode: boolean;
  /** Opens SQLite itself, around the host's database and its history. */
  rawDatabase: boolean;
  /** Writes the app's own tables through SQL, around history and undo. */
  coreTableWrites: string[];
  builtins: string[];
}

export interface Analysis {
  observed: Observed;
  findings: Finding[];
  /** The worst finding's severity, or null when there are none. */
  worst: Severity | null;
}

const RANK: Record<Severity, number> = { info: 0, warn: 1, high: 2, critical: 3 };

const NETWORK_MODULES = new Set(["http", "https", "http2", "net", "tls", "dgram", "dns"]);
const FS_MODULES = new Set(["fs", "fs/promises"]);
const EXEC_MODULES = new Set(["child_process", "cluster"]);
const CODE_MODULES = new Set(["vm", "module", "worker_threads", "inspector", "v8"]);
const DB_MODULES = new Set(["sqlite", "better-sqlite3", "sqlite3"]);
const NETWORK_GLOBALS = new Set(["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]);

const CORE_TABLES = ["items", "oplog", "oplog_undone", "projects", "boards", "views", "view_ranks", "fields", "field_options", "item_values", "labels", "item_labels", "item_relations", "deliveries", "plugin_migrations"];
const CORE_WRITE = new RegExp(`\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM|DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?|ALTER\\s+TABLE)\\s+["\`]?(${CORE_TABLES.join("|")})\\b`, "i");

/** Indicators that only make sense for code that means harm. */
const MALICE: { rule: string; re: RegExp; message: string }[] = [
  { rule: "credential-paths", re: /(\.ssh[\\/]|id_rsa|id_ed25519|\.aws[\\/]credentials|\.npmrc|\.netrc|Keychains|Login Data|Cookies\.binarycookies|\.config[\\/]gh[\\/]hosts|\.docker[\\/]config\.json|wallet\.dat)/i, message: "reads a place where credentials or keys are kept" },
  { rule: "miner", re: /(stratum\+tcp|xmrig|coinhive|cryptonight|minexmr)/i, message: "carries a cryptocurrency miner's markers" },
  { rule: "download-and-run", re: /(curl|wget)[^|;&\n]{0,200}\|\s*(ba|z)?sh\b|powershell[^\n]{0,80}(iex|invoke-expression)/i, message: "downloads a script and runs it" },
  { rule: "reverse-shell", re: /(\/dev\/tcp\/|nc\s+-e\s|bash\s+-i\s+>&)/i, message: "opens a shell to a remote machine" }
];

const builtinOf = (specifier: string): string | null => {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (specifier.startsWith("node:") || [...NETWORK_MODULES, ...FS_MODULES, ...EXEC_MODULES, ...CODE_MODULES, "os", "path", "url", "crypto", "stream", "zlib", "buffer", "events", "util", "assert", "timers", "readline", "process", "string_decoder", "querystring", "async_hooks", "perf_hooks", "tty"].includes(bare))
    return bare;
  return null;
};

const hostOf = (text: string): string[] => [...text.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9.-]+\.[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?/gi)].map((m) => m[1]!.toLowerCase());

type Node = { type: string; loc?: { start: { line: number } } | null; [key: string]: unknown };

function walk(node: unknown, visit: (node: Node, parent: Node | null) => void, parent: Node | null = null): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parent);
    return;
  }
  const n = node as Node;
  if (typeof n.type !== "string") return;
  visit(n, parent);
  for (const key of Object.keys(n)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "leadingComments" || key === "trailingComments") continue;
    walk(n[key], visit, n);
  }
}

function analyzeScript(source: string, file: string, observed: Observed, findings: Finding[]): void {
  const lines = source.split("\n");
  const add = (rule: string, severity: Severity, message: string, line: number) => findings.push({ rule, severity, message, file, line, snippet: lines[line - 1]?.trim().slice(0, 200) });

  let ast: unknown;
  try {
    ast = parse(source, { sourceType: "unambiguous", errorRecovery: true, allowReturnOutsideFunction: true, plugins: ["topLevelAwait"] });
  } catch (error) {
    add("unparseable", "high", `could not be read as JavaScript: ${error instanceof Error ? error.message : String(error)}`, 1);
    return;
  }

  const useModule = (specifier: string, line: number) => {
    const builtin = builtinOf(specifier);
    const bare = builtin ?? specifier;
    if (builtin && !observed.builtins.includes(builtin)) observed.builtins.push(builtin);
    if (NETWORK_MODULES.has(bare)) observed.network = true;
    if (FS_MODULES.has(bare)) observed.fs = true;
    if (EXEC_MODULES.has(bare)) {
      observed.exec = true;
      add("exec", "high", `starts other programs (${specifier})`, line);
    }
    if (CODE_MODULES.has(bare)) {
      observed.dynamicCode = true;
      add("dynamic-code", "high", `loads or runs code that cannot be read ahead of time (${specifier})`, line);
    }
    if (DB_MODULES.has(bare)) {
      observed.rawDatabase = true;
      add("raw-database", "high", `opens SQLite directly (${specifier}), around the app's history and undo`, line);
    }
  };

  walk(ast, (node, parent) => {
    const line = node.loc?.start.line ?? 1;
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "ExportNamedDeclaration": {
        const source = node.source as { value?: string } | null | undefined;
        if (source?.value) useModule(source.value, line);
        break;
      }
      case "ImportExpression":
      case "CallExpression": {
        const callee = node.callee as Node | undefined;
        const args = (node.arguments as Node[] | undefined) ?? [];
        const target = node.type === "ImportExpression" ? (node.source as Node) : callee?.type === "Import" ? args[0] : callee?.type === "Identifier" && callee.name === "require" ? args[0] : undefined;
        if (node.type === "ImportExpression" || callee?.type === "Import" || (callee?.type === "Identifier" && callee.name === "require")) {
          if (target?.type === "StringLiteral") useModule(target.value as string, line);
          else {
            observed.dynamicCode = true;
            add("dynamic-import", "high", "loads a module whose name is computed at run time", line);
          }
        }
        if (callee?.type === "Identifier" && (callee.name === "eval" || callee.name === "Function")) {
          observed.dynamicCode = true;
          add("eval", "high", `builds code from a string (${callee.name})`, line);
        }
        if (callee?.type === "MemberExpression" && (callee.property as Node)?.type === "Identifier" && (callee.property as Node).name === "binding" && (callee.object as Node)?.type === "Identifier" && (callee.object as Node).name === "process") {
          observed.exec = true;
          add("process-binding", "critical", "reaches Node's internals (process.binding)", line);
        }
        break;
      }
      case "NewExpression": {
        const callee = node.callee as Node | undefined;
        if (callee?.type === "Identifier" && callee.name === "Function") {
          observed.dynamicCode = true;
          add("eval", "high", "builds code from a string (new Function)", line);
        }
        if (callee?.type === "Identifier" && NETWORK_GLOBALS.has(callee.name as string)) observed.network = true;
        break;
      }
      case "Identifier": {
        if (NETWORK_GLOBALS.has(node.name as string) && parent?.type !== "MemberExpression" && parent?.type !== "ObjectProperty") observed.network = true;
        break;
      }
      case "MemberExpression": {
        const object = node.object as Node;
        const property = node.property as Node;
        if (object?.type === "Identifier" && object.name === "process" && property?.type === "Identifier" && property.name === "env") {
          if (!observed.env) add("env", "warn", "reads environment variables, where API keys and tokens often live", line);
          observed.env = true;
        }
        break;
      }
      case "StringLiteral":
      case "TemplateElement": {
        const text = node.type === "StringLiteral" ? (node.value as string) : ((node.value as { cooked?: string; raw: string }).cooked ?? (node.value as { raw: string }).raw);
        for (const host of hostOf(text)) if (!observed.hosts.includes(host)) observed.hosts.push(host);
        const core = CORE_WRITE.exec(text);
        if (core && !observed.coreTableWrites.includes(core[1]!.toLowerCase())) {
          observed.coreTableWrites.push(core[1]!.toLowerCase());
          add("core-table-write", "high", `writes the app's own "${core[1]}" table through SQL, around history and undo`, line);
        }
        for (const m of MALICE) if (m.re.test(text)) add(m.rule, "critical", m.message, line);
        if (text.length > 4_000 && /^[A-Za-z0-9+/=\s]+$/.test(text)) add("opaque-blob", "warn", `carries ${text.length} characters of encoded data`, line);
        break;
      }
    }
  });

  if (/\b_0x[0-9a-f]{4,}\b/.test(source)) add("obfuscated", "critical", "is obfuscated: its names were replaced to hide what it does", 1);
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  if (longest > 20_000) add("minified", "warn", "is minified; a person reads it less well than the build's plain output", 1);
}

function analyzeDocument(html: string, file: string, observed: Observed, findings: Finding[]): void {
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    if (/^(https?:)?\/\//i.test(m[1]!)) {
      observed.network = true;
      findings.push({ rule: "remote-script", severity: "high", message: `loads a script from ${m[1]}`, file, line: html.slice(0, m.index).split("\n").length });
    }
  }
  for (const m of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) analyzeScript(m[1]!, file, observed, findings);
  for (const host of hostOf(html)) if (!observed.hosts.includes(host)) observed.hosts.push(host);
}

/** Every script and document the package ships, read against what its manifest says it does. */
export function analyzePackage(dir: string, manifest: Manifest): Analysis {
  const observed: Observed = { network: false, hosts: [], fs: false, exec: false, env: false, dynamicCode: false, rawDatabase: false, coreTableWrites: [], builtins: [] };
  const findings: Finding[] = [];
  const files = listFiles(dir, (rel) => rel === "node_modules" || rel === ".git").filter((rel) => rel.startsWith("dist/") || rel === manifest.main);
  for (const rel of files) {
    const text = fs.readFileSync(path.join(dir, rel), "utf8");
    if (/\.(m?js|cjs)$/.test(rel)) analyzeScript(text, rel, observed, findings);
    else if (/\.html?$/.test(rel)) analyzeDocument(text, rel, observed, findings);
  }
  if (observed.network) observed.hosts.sort();
  findings.push(...mismatches(manifest, observed));
  const worst = findings.reduce<Severity | null>((w, f) => (w === null || RANK[f.severity] > RANK[w] ? f.severity : w), null);
  return { observed, findings, worst };
}

const RISK_RANK: Record<RiskLevel, number> = { low: 0, elevated: 1, high: 2 };

/** Risk from what the code was seen doing, beside what the manifest declares. */
export function observedRisk(observed: Observed, manifest: Manifest): { level: RiskLevel; reasons: string[] } {
  const declared = riskOf(manifest);
  const reasons = new Set(declared.reasons);
  let level = declared.level;
  const add = (reason: string, at: RiskLevel) => {
    reasons.add(reason);
    if (RISK_RANK[at] > RISK_RANK[level]) level = at;
  };
  if (observed.exec) add("exec", "high");
  if (observed.rawDatabase) add("raw-database", "high");
  if (observed.coreTableWrites.length) add("core-table-writes", "high");
  if (observed.dynamicCode) add("dynamic-code", "high");
  if (observed.network && !manifest.permissions.network.length) add("network", "elevated");
  if (observed.fs && manifest.permissions.fs === "none") add("fs", "elevated");
  if (observed.env) add("env", "elevated");
  return { level, reasons: [...reasons] };
}

/** Where the code does more than the manifest admits. Named, not refused: the listing shows what was observed. */
export function mismatches(manifest: Manifest, observed: Observed): Finding[] {
  const out: Finding[] = [];
  const p = manifest.permissions;
  const at = (rule: string, severity: Severity, message: string): Finding => ({ rule, severity, message, file: "tomrade-plugin.json", line: 1 });
  if (observed.exec && !p.exec) out.push(at("undeclared-exec", "high", "starts other programs but does not declare exec"));
  if (observed.fs && p.fs === "none") out.push(at("undeclared-fs", "warn", "uses the file system but declares fs: none"));
  if (observed.network && !p.network.length) out.push(at("undeclared-network", "warn", "talks to the network but declares no hosts"));
  if (p.network.length && !p.network.includes("*")) {
    const undeclared = observed.hosts.filter((h) => !p.network.some((d) => h === d || h.endsWith(`.${d}`)));
    if (undeclared.length) out.push(at("undeclared-hosts", "warn", `names hosts it does not declare: ${undeclared.join(", ")}`));
  }
  if ((observed.rawDatabase || observed.coreTableWrites.length) && !manifest.inject.includes("db") && !manifest.optional.includes("db")) out.push(at("undeclared-db", "high", "writes databases without injecting db"));
  return out;
}

export const atLeast = (severity: Severity | null, floor: Severity): boolean => severity !== null && RANK[severity] >= RANK[floor];
