import fs from "node:fs";
import path from "node:path";
import { frontmatter } from "@tomradex/agent";
import { slugify } from "./keys.js";

export type DecisionStatus = "proposed" | "accepted" | "superseded";

/** One cross-cutting choice, recorded once so no ticket has to make it again silently. */
export interface Decision {
  id: string;
  title: string;
  status: DecisionStatus;
  /** What it settles: "state management", "routing", "deployment"… free words, matched loosely. */
  areas: string[];
  date: string;
  file: string;
}

export interface DecisionInput {
  title: string;
  context: string;
  decision: string;
  alternatives?: string;
  consequences?: string;
  areas?: string[];
  status?: DecisionStatus;
  /** The id this one replaces; that file is marked superseded. */
  supersedes?: string;
}

/** `<project folder>/.tomrade/docs/decisions/` — text beside the project's other files, diffable, travelling with it. */
export const decisionsDir = (artifactDir: string): string => path.join(artifactDir, "docs", "decisions");

const FILE = /^(\d{4})-(.+)\.md$/;

export function listDecisions(artifactDir: string): Decision[] {
  const dir = decisionsDir(artifactDir);
  if (!fs.existsSync(dir)) return [];
  const out: Decision[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const m = FILE.exec(name);
    if (!m) continue;
    try {
      const { meta } = frontmatter(fs.readFileSync(path.join(dir, name), "utf8"));
      out.push({
        id: m[1]!,
        title: typeof meta.title === "string" ? meta.title : m[2]!.replace(/-/g, " "),
        status: (["proposed", "accepted", "superseded"] as const).includes(meta.status as DecisionStatus) ? (meta.status as DecisionStatus) : "accepted",
        areas: Array.isArray(meta.areas) ? meta.areas.filter((a): a is string => typeof a === "string") : [],
        date: typeof meta.date === "string" ? meta.date : "",
        file: path.join(dir, name)
      });
    } catch {
      // one unreadable note must not hide the rest
    }
  }
  return out;
}

/** Write the next numbered note. Returns what was written, so a tool can hand the id back. */
export function recordDecision(artifactDir: string, input: DecisionInput, now = new Date()): Decision {
  const dir = decisionsDir(artifactDir);
  fs.mkdirSync(dir, { recursive: true });
  const existing = listDecisions(artifactDir);
  const next = String((existing.length ? Math.max(...existing.map((d) => Number(d.id))) : 0) + 1).padStart(4, "0");
  const status = input.status ?? "accepted";
  const date = now.toISOString().slice(0, 10);
  const areas = (input.areas ?? []).map((a) => a.trim()).filter(Boolean);
  const file = path.join(dir, `${next}-${slugify(input.title, 60)}.md`);
  const body = [
    "---",
    `title: ${JSON.stringify(input.title)}`,
    `status: ${status}`,
    `date: ${date}`,
    `areas: ${JSON.stringify(areas)}`,
    ...(input.supersedes ? [`supersedes: ${JSON.stringify(input.supersedes)}`] : []),
    "---",
    "",
    `# ${input.title}`,
    "",
    "## Context",
    "",
    input.context.trim(),
    "",
    "## Decision",
    "",
    input.decision.trim(),
    "",
    "## Alternatives considered",
    "",
    (input.alternatives ?? "").trim() || "—",
    "",
    "## Consequences",
    "",
    (input.consequences ?? "").trim() || "—",
    ""
  ].join("\n");
  fs.writeFileSync(file, body);
  if (input.supersedes) {
    const old = existing.find((d) => d.id === input.supersedes);
    if (old) fs.writeFileSync(old.file, fs.readFileSync(old.file, "utf8").replace(/^status: .*$/m, "status: superseded"));
  }
  return { id: next, title: input.title, status, areas, date, file };
}

/** Whether any accepted decision speaks to one of these areas — the pre-flight's question. */
export function covered(decisions: Decision[], area: string): boolean {
  const needle = area.trim().toLowerCase();
  return decisions.some((d) => d.status === "accepted" && d.areas.some((a) => a.toLowerCase() === needle || needle.includes(a.toLowerCase()) || a.toLowerCase().includes(needle)));
}
