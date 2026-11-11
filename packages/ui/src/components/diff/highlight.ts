import type { Parser } from "@lezer/common";
import { parser as css } from "@lezer/css";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { parser as html } from "@lezer/html";
import { parser as js } from "@lezer/javascript";
import { parser as markdown } from "@lezer/markdown";
import type { ChangeHunk } from "@tomradex/code-link";

/** A coloured stretch of one line: offsets into its text and the token kind (`diff__tok--<kind>`). */
export interface Token {
  from: number;
  to: number;
  kind: string;
}

const KINDS = tagHighlighter([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.self], class: "keyword" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.attributeValue], class: "string" },
  { tag: [t.comment, t.meta, t.processingInstruction], class: "comment" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color], class: "literal" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], class: "type" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "function" },
  { tag: [t.propertyName, t.attributeName, t.labelName], class: "property" },
  { tag: [t.heading, t.strong], class: "strong" },
  { tag: [t.emphasis], class: "emphasis" },
  { tag: [t.link, t.url], class: "link" }
]);

// Lezer's JSON grammar is not installed; a JSON document is one JavaScript expression.
const PARSERS: Record<string, Parser> = {
  js,
  mjs: js,
  cjs: js,
  jsx: js.configure({ dialect: "jsx" }),
  ts: js.configure({ dialect: "ts" }),
  mts: js.configure({ dialect: "ts" }),
  cts: js.configure({ dialect: "ts" }),
  tsx: js.configure({ dialect: "ts jsx" }),
  json: js.configure({ top: "SingleExpression" }),
  css,
  html,
  htm: html,
  md: markdown,
  markdown
};

/** The extensions that get colours, for whoever lists them. */
export const HIGHLIGHTED = Object.keys(PARSERS);

/** Past this many lines a file is drawn plain: colours are not worth the parse. */
const LINES_MAX = 4000;

export const parserFor = (path: string): Parser | null => PARSERS[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? null;

/** Tokens per line for lines parsed as one text. */
export function highlightLines(parser: Parser, lines: readonly string[]): Token[][] {
  const out: Token[][] = lines.map(() => []);
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  let row = 0;
  highlightTree(parser.parse(lines.join("\n")), KINDS, (from, to, kind) => {
    while (row + 1 < lines.length && starts[row + 1] <= from) row++;
    // A token may run over several lines (a block comment): each line gets its part.
    for (let r = row; r < lines.length && starts[r] < to; r++) {
      const a = Math.max(from, starts[r]) - starts[r];
      const b = Math.min(to, starts[r] + lines[r].length) - starts[r];
      // Nested styles arrive as several classes; the innermost is last.
      if (b > a) out[r].push({ from: a, to: b, kind: kind.slice(kind.lastIndexOf(" ") + 1) });
    }
  });
  return out;
}

/**
 * Tokens for each line of a hunk, by line index. Each side is parsed as the text it was — the old side from
 * context and deletions, the new side from context and additions — so a fragment that starts mid-construct
 * may colour a little off, as any diff view's does.
 */
export function highlightHunk(parser: Parser, hunk: ChangeHunk): Map<number, Token[]> {
  const tokens = new Map<number, Token[]>();
  if (hunk.lines.length > LINES_MAX) return tokens;
  const side = (skip: "add" | "del", keep: (kind: string) => boolean) => {
    const index: number[] = [];
    hunk.lines.forEach((line, i) => line.kind !== skip && index.push(i));
    try {
      highlightLines(parser, index.map((i) => hunk.lines[i].text)).forEach((found, k) => {
        if (found.length && keep(hunk.lines[index[k]].kind)) tokens.set(index[k], found);
      });
    } catch {
      // a parser that gives up leaves the side plain
    }
  };
  side("del", () => true);
  side("add", (kind) => kind === "del");
  return tokens;
}

/** A stretch of a line as it is drawn: its token kind, and whether the pair's other line differs here. */
export interface Segment {
  text: string;
  kind: string | null;
  changed: boolean;
}

/** One line cut wherever a token or a changed span starts or ends. */
export function segments(text: string, tokens: readonly Token[] = [], spans: readonly (readonly [number, number])[] = []): Segment[] {
  if (!tokens.length && !spans.length) return text ? [{ text, kind: null, changed: false }] : [];
  const cuts = new Set<number>([0, text.length]);
  for (const token of tokens) cuts.add(token.from).add(token.to);
  for (const [from, to] of spans) cuts.add(from).add(to);
  const edges = [...cuts].filter((cut) => cut >= 0 && cut <= text.length).sort((a, b) => a - b);
  const out: Segment[] = [];
  let tokenAt = 0;
  for (let i = 0; i + 1 < edges.length; i++) {
    const from = edges[i];
    const to = edges[i + 1];
    while (tokenAt < tokens.length && tokens[tokenAt].to <= from) tokenAt++;
    const token = tokens[tokenAt];
    const kind = token && token.from <= from && token.to >= to ? token.kind : null;
    const changed = spans.some(([a, b]) => a <= from && b >= to);
    const last = out.at(-1);
    if (last && last.kind === kind && last.changed === changed) last.text += text.slice(from, to);
    else out.push({ text: text.slice(from, to), kind, changed });
  }
  return out;
}
