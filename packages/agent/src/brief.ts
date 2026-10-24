import { BRIEF_MAX_CHARS } from "./prompt.js";

/**
 * The project brief as sections: a preamble, then `## Heading` blocks. An
 * agent that learned one thing rewrites one section, not the whole text, so
 * what the others wrote stays and the cached prompt moves as little as it can.
 */
export interface BriefSection {
  heading: string;
  text: string;
}

const HEADING = /^##\s+(.+?)\s*$/;

export function parseBrief(body: string): { preamble: string; sections: BriefSection[] } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const sections: BriefSection[] = [];
  const preamble: string[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    const match = HEADING.exec(line);
    if (match) {
      if (current) sections.push({ heading: current.heading, text: current.lines.join("\n").trim() });
      current = { heading: match[1]!, lines: [] };
    } else if (current) current.lines.push(line);
    else preamble.push(line);
  }
  if (current) sections.push({ heading: current.heading, text: current.lines.join("\n").trim() });
  return { preamble: preamble.join("\n").trim(), sections };
}

export function renderBrief(preamble: string, sections: BriefSection[]): string {
  return [preamble.trim(), ...sections.map((s) => `## ${s.heading}\n${s.text.trim()}`)].filter(Boolean).join("\n\n").trim();
}

const sameHeading = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The section under this heading replaced, or added at the end; `null` text removes it. */
export function withSection(body: string, heading: string, text: string | null): string {
  const { preamble, sections } = parseBrief(body);
  const at = sections.findIndex((s) => sameHeading(s.heading, heading));
  if (text === null) return renderBrief(preamble, sections.filter((_, i) => i !== at));
  const next = { heading: at >= 0 ? sections[at]!.heading : heading.trim(), text };
  return renderBrief(preamble, at >= 0 ? sections.map((s, i) => (i === at ? next : s)) : [...sections, next]);
}

/** Why a brief this long is refused: the size, the cap, and what to do — never a silent cut. */
export function briefTooLong(length: number): string {
  return `The project brief is kept under ${BRIEF_MAX_CHARS} characters (about ${Math.round(BRIEF_MAX_CHARS / 4)} tokens) because every run reads it; this would make it ${length}. Shorten it — merge or drop sections, keep facts over prose — or compact it.`;
}

export const COMPACT_SYSTEM = [
  "You compact a project brief: the durable memory every agent working on this software product reads before it plans or writes anything.",
  "Rewrite it shorter, keeping every fact — what the product is, the stack and commands, the layout, where data comes from (managed here versus fetched from elsewhere), domain vocabulary, conventions — and dropping prose, repetition and hedging.",
  "Keep the `## Heading` sections where they exist (merge duplicates); keep the language the brief is written in; keep code identifiers, paths and commands as they are.",
  'Return JSON: {"brief": "..."}'
].join("\n");
