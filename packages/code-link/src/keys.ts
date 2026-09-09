/**
 * The one join between a ticket and its code is the ticket key (TOM-42) in a
 * branch name, a commit message or a pull request. These helpers read it out
 * and write it in; nothing else in the plugin knows the spelling.
 */

/** `{key}` lowercase key, `{KEY}` as written, `{num}` the number, `{slug}` from the title. */
export const DEFAULT_BRANCH_TEMPLATE = "{key}/{slug}";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** ASCII slug of a title for a branch name: lowercase, dashes, capped, never empty. */
export function slugify(title: string, max = 40): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "work";
}

export function branchFor(template: string, key: string, title: string): string {
  const num = key.split("-").pop() ?? "";
  return template.replace(/\{key\}/g, key.toLowerCase()).replace(/\{KEY\}/g, key).replace(/\{num\}/g, num).replace(/\{slug\}/g, slugify(title));
}

/** The ticket number a branch name carries, wherever the template put it; null when none. */
export function parseBranch(name: string, prefix: string): number | null {
  const bare = name.replace(/^refs\/(heads|remotes\/[^/]+)\//, "").replace(/^origin\//, "");
  const m = new RegExp(`(?:^|[/_.-])${escapeRe(prefix)}-(\\d+)(?=$|[/_.-])`, "i").exec(bare);
  return m ? Number(m[1]) : null;
}

/** Every ticket number a commit message or PR title mentions, deduplicated, in order. */
export function keysInText(text: string, prefix: string): number[] {
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(prefix)}-(\\d+)(?![A-Za-z0-9])`, "gi");
  const out: number[] = [];
  const seen = new Set<number>();
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}
