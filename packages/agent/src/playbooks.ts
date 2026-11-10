import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Playbook, PlaybookIndexEntry, PlaybookOrigin, PlaybookSource } from "./workflow.js";

export type { PlaybookOrigin };
/** Beside a playbook's SKILL.md: where it came from, and which version this is. */
export const ORIGIN_FILE = ".tomrade-source.json";
/** Earlier versions of a playbook, one folder per version number, inside the playbook's own folder. */
export const VERSIONS_DIR = ".versions";

const requirementsSchema = z.object({
  workTypes: z.array(z.enum(["coding", "general"])).optional(),
  requires: z.array(z.string().min(1)).optional(),
  optionalCapabilities: z.array(z.string().min(1)).optional(),
  outputs: z.array(z.string().min(1)).optional()
});

/** Throws when the frontmatter's work types or capabilities are malformed. */
export const playbookRequirements = (meta: Record<string, unknown>) => requirementsSchema.parse(meta);

export function readOrigin(dir: string): PlaybookOrigin | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, ORIGIN_FILE), "utf8")) as PlaybookOrigin;
    return typeof parsed.version === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/** Missing capabilities are visible to the caller; recommendations never hide a method. */
export function missingPlaybookCapabilities(playbook: Pick<Playbook, "requires">, available: readonly string[]): string[] {
  const capabilities = new Set(available);
  return (playbook.requires ?? []).filter(capability => !capabilities.has(capability));
}

export const frontmatter = (raw: string): { meta: Record<string, unknown>; body: string } => {
  // A file saved on Windows ends its lines in CRLF, a SKILL.md or decision note as much as any.
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
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
    // Dot folders are an import or undo under way, never a playbook.
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const file = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    try {
      const { meta, body } = frontmatter(fs.readFileSync(file, "utf8"));
      const origin = readOrigin(path.join(dir, entry.name));
      out.push({
        ...requirementsSchema.parse(meta),
        id: typeof meta.name === "string" ? meta.name : entry.name,
        title: typeof meta.title === "string" ? meta.title : entry.name,
        when: typeof meta.description === "string" ? meta.description : "",
        tools: Array.isArray(meta.tools) ? meta.tools.filter((t): t is string => typeof t === "string") : [],
        body,
        ...(origin ? { origin } : {})
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
  const { body: _body, ...index } = winner;
  return { winner, entry: { ...index, source, shadows: present.filter((s) => s !== source) } };
}
