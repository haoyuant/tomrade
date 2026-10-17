import type { WordsLocale } from "@tomradex/domain";
import type { ImContextMessage } from "@tomradex/plugin-sdk";
import { IM_WORDS } from "./words.js";

export interface ContextAuthor { id: string; name?: string; isBot: boolean }
export interface ContextLine { author: ContextAuthor; text: string }
export interface GroupContext {
  quoted?: ContextLine;
  root?: ContextLine;
  /** Oldest first. */
  recent: ContextLine[];
}

/** Each quoted line is kept short; the whole block stays well under a turn's budget. */
const LINE = 1_000;

const clip = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return [...flat].length > LINE ? `${[...flat].slice(0, LINE - 1).join("")}…` : flat;
};

export const fromAdapter = (m: ImContextMessage): ContextLine => ({ author: m.author, text: m.text });

/** The message with its context in front, as a quote block the Agent can tell apart from the request. */
export function withContext(text: string, ctx: GroupContext, locale: WordsLocale): string {
  const w = IM_WORDS(locale);
  const who = (a: ContextAuthor) => `${a.name ?? a.id}${a.isBot ? ` (${w("contextBot")})` : ""}`;
  const lines: string[] = [];
  if (ctx.root && ctx.root.text.trim()) lines.push(`${w("contextRoot")} ${who(ctx.root.author)}: ${clip(ctx.root.text)}`);
  if (ctx.quoted && ctx.quoted.text.trim()) lines.push(`${w("contextQuoted")} ${who(ctx.quoted.author)}: ${clip(ctx.quoted.text)}`);
  const recent = ctx.recent.filter(l => l.text.trim());
  if (recent.length) lines.push(w("contextRecent"), ...recent.map(l => `- ${who(l.author)}: ${clip(l.text)}`));
  if (!lines.length) return text;
  return `${[w("contextHead"), ...lines].map(l => `> ${l}`).join("\n")}\n\n${text}`;
}
