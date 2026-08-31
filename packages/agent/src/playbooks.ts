import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Playbook, PlaybookIndexEntry, PlaybookSource } from "./types.js";

export const frontmatter = (raw: string): { meta: Record<string, unknown>; body: string } => {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) return { meta: {}, body: raw.trim() };
  const meta = parseYaml(match[1]) as Record<string, unknown> | null;
  return { meta: meta ?? {}, body: raw.slice(match[0].length).trim() };
};

/**
 * `<dir>/<name>/SKILL.md` — the same file format Claude Code skills use.
 * Frontmatter: `name` → id, `description` → the when line, plus `title` and a
 * Tomrade-only `tools` list. A file that fails to parse is reported and skipped,
 * never fatal — one broken playbook must not take the rest down.
 */
export function loadPlaybookDir(dir: string, onError?: (file: string, err: unknown) => void): Playbook[] {
  if (!fs.existsSync(dir)) return [];
  const out: Playbook[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    try {
      const { meta, body } = frontmatter(fs.readFileSync(file, "utf8"));
      out.push({
        id: typeof meta.name === "string" ? meta.name : entry.name,
        title: typeof meta.title === "string" ? meta.title : entry.name,
        when: typeof meta.description === "string" ? meta.description : "",
        tools: Array.isArray(meta.tools) ? meta.tools.filter((t): t is string => typeof t === "string") : [],
        body
      });
    } catch (err) {
      onError?.(file, err);
    }
  }
  return out;
}

/** Same id from several sources is a conflict, not an error: every variant is kept and one wins. */
export interface PlaybookVariants {
  plugin?: Playbook;
  user?: Playbook;
  project?: Playbook;
}

/** Most specific wins by default; an explicit per-id choice in settings overrides. */
const PRECEDENCE: readonly PlaybookSource[] = ["project", "user", "plugin"];

export function resolvePlaybook(variants: PlaybookVariants, choice?: PlaybookSource): { winner: Playbook; entry: PlaybookIndexEntry } | null {
  const present = PRECEDENCE.filter((s) => variants[s]);
  if (!present.length) return null;
  // A choice pointing at a source that is gone (file deleted, plugin disabled) falls back to precedence.
  const source = choice && variants[choice] ? choice : present[0];
  const winner = variants[source]!;
  const { id, title, when, tools } = winner;
  return { winner, entry: { id, title, when, tools, source, shadows: present.filter((s) => s !== source) } };
}
