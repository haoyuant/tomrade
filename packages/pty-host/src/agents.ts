import path from "node:path";
import type { TerminalStatus } from "@tomradex/contracts";

/*
 * What runs in a pane, read off Windows' process table the way herdr reads a
 * pane's foreground on macOS and Linux: which coding agent it is, and what its
 * terminal title says about it.
 */

/** One row of the process table. `created` is a FILETIME (0 when Windows would not say). */
export interface ProcessRow {
  pid: number;
  ppid: number;
  created: number;
  name: string;
  cmdline: string;
}

/** The console's own processes, which hold the pane rather than run in it. */
const PLUMBING = new Set(["conhost.exe", "openconsole.exe"]);

/** The agents recognised: by their own executable, or by their npm package when Node or Bun runs them. */
const AGENTS: { id: string; exe: string[]; packages: string[] }[] = [
  { id: "claude", exe: ["claude"], packages: ["@anthropic-ai/claude-code"] },
  { id: "codex", exe: ["codex"], packages: ["@openai/codex"] },
  { id: "gemini", exe: ["gemini"], packages: ["@google/gemini-cli"] },
  { id: "qwen", exe: ["qwen"], packages: ["@qwen-code/qwen-code"] },
  { id: "cursor", exe: ["cursor-agent"], packages: [] },
  { id: "opencode", exe: ["opencode"], packages: ["opencode-ai"] },
  { id: "droid", exe: ["droid"], packages: [] },
  { id: "copilot", exe: ["copilot"], packages: ["@github/copilot"] },
  { id: "kimi", exe: ["kimi"], packages: [] },
  { id: "amp", exe: ["amp"], packages: ["@sourcegraph/amp"] },
  { id: "codebuddy", exe: ["codebuddy"], packages: ["@tencent-ai/codebuddy-code"] }
];

const SCRIPT_RUNNERS = new Set(["node", "bun"]);

const stem = (name: string) => name.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");

/** Lines of `pid\tppid\tcreated\tname\tcommand line`, as the scan prints them; anything else is skipped. */
export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, created, name, ...rest] = line.split("\t");
    const row = { pid: Number(pid), ppid: Number(ppid), created: Number(created) || 0, name: name?.trim() ?? "", cmdline: rest.join("\t").trim() };
    if (Number.isInteger(row.pid) && row.pid > 0 && Number.isInteger(row.ppid) && row.name) rows.push(row);
  }
  return rows;
}

/**
 * The processes under a pane's root, nearest first and the newest of each generation first, without the console's
 * plumbing. Windows reuses a dead parent's pid, so a child is taken only when it is no older than its parent.
 */
export function descendants(rows: ProcessRow[], rootPid: number): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const siblings = byParent.get(row.ppid) ?? [];
    siblings.push(row);
    byParent.set(row.ppid, siblings);
  }
  const root = rows.find((r) => r.pid === rootPid);
  const out: ProcessRow[] = [];
  const seen = new Set([rootPid]);
  let generation = [{ pid: rootPid, created: root?.created ?? 0 }];
  while (generation.length) {
    const next = generation
      .flatMap((parent) => (byParent.get(parent.pid) ?? []).filter((c) => !parent.created || !c.created || c.created >= parent.created))
      .filter((c) => !seen.has(c.pid))
      .sort((a, b) => b.created - a.created);
    for (const c of next) seen.add(c.pid);
    out.push(...next.filter((c) => !PLUMBING.has(c.name.toLowerCase())));
    generation = next;
  }
  return out;
}

/** A command line with its program named alone, `claude --resume x` rather than its full quoted path. */
export function shortCommand(row: Pick<ProcessRow, "name" | "cmdline">): string {
  const cmd = row.cmdline.trim();
  if (!cmd) return stem(row.name);
  const quote = cmd.startsWith('"') ? cmd.indexOf('"', 1) : -1;
  if (cmd.startsWith('"') && quote < 0) return stem(row.name);
  const first = quote > 0 ? cmd.slice(1, quote) : cmd.split(/\s/, 1)[0]!.replace(/^"/, "");
  const rest = quote > 0 ? cmd.slice(quote + 1) : cmd.slice(cmd.split(/\s/, 1)[0]!.length);
  return `${stem(path.win32.basename(first))}${rest.replace(/^\s+/, " ").trimEnd()}`;
}

/** Which agent a process is: by its executable, or by the package a script runner was given. Null for anything else. */
export function agentOfProcess(row: Pick<ProcessRow, "name" | "cmdline">): string | null {
  const exe = stem(row.name);
  const byExe = AGENTS.find((a) => a.exe.includes(exe));
  if (byExe) return byExe.id;
  if (!SCRIPT_RUNNERS.has(exe)) return null;
  const cmd = row.cmdline.toLowerCase().replaceAll("\\", "/");
  return AGENTS.find((a) => a.packages.some((p) => cmd.includes(`/${p}/`)))?.id ?? null;
}

/** The agent running in a pane: the nearest one under its root, or the root itself. */
export function agentIn(root: Pick<ProcessRow, "name" | "cmdline"> | undefined, below: ProcessRow[]): string | null {
  if (root) {
    const own = agentOfProcess(root);
    if (own) return own;
  }
  for (const row of below) {
    const agent = agentOfProcess(row);
    if (agent) return agent;
  }
  return null;
}

/** Claude Code's busy spinner leading its title (herdr's `osc_title_working`, claude.toml): braille, then 2.1.228's half circles. */
const CLAUDE_WORKING_TITLE = /^[\u2800-\u28FF\u25D0-\u25D3] /u;

/** What the title alone says of an agent herdr has no detection manifest for: only Claude's spinner reads as working. */
export function titleStatus(agent: string | null, title: string | null): TerminalStatus {
  return agent === "claude" && title && CLAUDE_WORKING_TITLE.test(title) ? "working" : "unknown";
}

/** An activity glyph an agent leads its title with, and the space after it (herdr's `terminal_title_stripped`). */
const ACTIVITY_GLYPH = /^[\u2800-\u28FF\u25D0-\u25D3\u2722\u2733\u2736\u273B\u273D\u00B7*]\s+/u;

export function strippedTitle(title: string | null): string | null {
  return title?.replace(ACTIVITY_GLYPH, "").trim() || null;
}
