/**
 * The one join between a ticket and its code is the ticket key (TOM-42) in a
 * branch name, a commit message or a pull request. These helpers read it out
 * and write it in; nothing else in the plugin knows the spelling.
 */

import { z } from "zod";
import type { LlmService } from "@tomradex/llm";

/** `{key}` lowercase key, `{KEY}` as written, `{num}` the number, `{slug}` from the title. */
export const DEFAULT_BRANCH_TEMPLATE = "{key}/{slug}";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a branch slug may be: lowercase letters, digits and single dashes. */
export const SLUG_MAX = 40;
const FALLBACK_SLUG = "work";

/** A title a local rule can slug on its own: Latin letters and digits, no CJK to translate. */
const hasCjk = (title: string) => /[\u3400-\u9fff\uf900-\ufaff]/.test(title);

/** ASCII slug of a title for a branch name: lowercase, dashes, capped, never empty. */
export function slugify(title: string, max = SLUG_MAX): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || FALLBACK_SLUG;
}

/** Whatever a model answered, forced into a slug shape: lowercase, dashes, capped, or "" when nothing is left. */
export function usableSlug(value: unknown, max = SLUG_MAX): string {
  if (typeof value !== "string") return "";
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug;
}

const SLUG_SYSTEM = [
  "You name a git branch for one backlog ticket.",
  "Translate the title into 2–4 short English words that say what the work is.",
  'Reply with JSON only: {"slug": "lowercase-words-joined-by-dashes"}.',
  "The slug is lowercase ASCII letters, digits and dashes; keep it under 40 characters, meaningful and specific.",
  "Never include the ticket key, prefixes like feat/fix, or any prose."
].join("\n");

const slugAnswer = z.object({ slug: z.string() });

const SLUG_TIMEOUT_MS = 8000;

/**
 * The slug half of a branch name, from the title.
 *
 * A title a local rule can read (no CJK) is slugged here, so English branches
 * are the same every run and cost nothing. A CJK title is translated by the
 * worker model into a short English slug; a model that is absent, offline or
 * answers with something unusable leaves the local rule's result — never an
 * error, and only for a NEW branch (an existing one is reused untouched).
 */
export async function titleSlug(llm: LlmService | null, title: string, max = SLUG_MAX): Promise<string> {
  const trimmed = title.trim();
  if (!trimmed) return FALLBACK_SLUG;
  if (!hasCjk(trimmed)) return slugify(trimmed, max);
  if (llm) {
    // Start waits on this: a model that streams on (DeepSeek's JSON mode can pad to the limit) must not hold it.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error("the model did not answer in time")), SLUG_TIMEOUT_MS);
    try {
      const out = await llm.completeJson(slugAnswer, { system: SLUG_SYSTEM, user: trimmed, temperature: 0, maxTokens: 100, signal: deadline.signal });
      const slug = usableSlug(out.slug, max);
      if (slug) return slug;
    } catch {
      // A model that cannot answer, or not in time, is not a failed start: fall through.
    } finally {
      clearTimeout(timer);
    }
  }
  return slugify(trimmed, max);
}

/** `slug` lets the caller pass a title's slug in; without it a plain title is slugged locally. */
export function branchFor(template: string, key: string, title: string, slug?: string): string {
  const num = key.split("-").pop() ?? "";
  return template
    .replace(/\{key\}/g, key.toLowerCase())
    .replace(/\{KEY\}/g, key)
    .replace(/\{num\}/g, num)
    .replace(/\{slug\}/g, slug ?? slugify(title));
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

/** The pull request a squash or merge commit's subject names: `… (#243)` or `Merge pull request #243 from …`. */
export function subjectPr(subject: string): number | null {
  const m = /\(#(\d+)\)\s*$/.exec(subject) ?? /^Merge pull request #(\d+)\b/.exec(subject);
  return m ? Number(m[1]) : null;
}
