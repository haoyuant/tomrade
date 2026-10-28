import DOMPurify from "dompurify";
import { Marked, type TokenizerAndRendererExtension, type Tokens } from "marked";
import { decodeHref } from "@tomradex/notes/syntax";

/** Which file a link means; null when nothing answers to it yet. */
export type LinkResolver = (target: string, kind: "wiki" | "markdown") => string | null;

const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

interface WikiToken extends Tokens.Generic {
  type: "wikiLink";
  embed: boolean;
  target: string;
  anchor: string;
  alias: string;
}

interface TagToken extends Tokens.Generic {
  type: "hashTag";
  tag: string;
}

// Mirrors @tomradex/notes/syntax, which the index reads with.
const WIKI = /^(!?)\[\[([^[\]\n|#]*)(?:#([^[\]\n|]*))?(?:\|([^[\]\n]*))?\]\]/;
const TAG = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u;
const TAG_START = /(^|[\s(,;])#[\p{L}\p{N}_\-/]*[\p{L}_\-/]/u;

function extensions(resolve: LinkResolver | undefined): TokenizerAndRendererExtension[] {
  const wikiLink: TokenizerAndRendererExtension = {
    name: "wikiLink",
    level: "inline",
    start: (src) => {
      const at = src.search(/!?\[\[/);
      return at < 0 ? undefined : at;
    },
    tokenizer(src) {
      const m = WIKI.exec(src);
      if (!m) return undefined;
      return { type: "wikiLink", raw: m[0], embed: m[1] === "!", target: m[2]!.trim(), anchor: m[3]?.trim() ?? "", alias: m[4]?.trim() ?? "" } satisfies WikiToken;
    },
    renderer(token) {
      const t = token as WikiToken;
      const resolved = t.target ? (resolve?.(t.target, "wiki") ?? null) : "self";
      // A picture embedded from the store is drawn; its bytes are filled in by the viewer.
      if (t.embed && resolved && IMAGE.test(resolved)) return `<img class="note-image" data-file="${escape(resolved)}" alt="${escape(t.alias || t.target)}">`;
      const label = t.alias || (t.anchor ? `${t.target || ""}${t.target ? " › " : ""}${t.anchor}` : t.target);
      const cls = `wikilink${resolved ? "" : " is-unresolved"}${t.embed ? " is-embed" : ""}`;
      return `<a href="#" class="${cls}" data-target="${escape(t.target)}" data-anchor="${escape(t.anchor)}">${escape(label)}</a>`;
    }
  };
  const hashTag: TokenizerAndRendererExtension = {
    name: "hashTag",
    level: "inline",
    start: (src) => {
      const m = TAG_START.exec(src);
      return m ? m.index + m[1]!.length : undefined;
    },
    tokenizer(src) {
      const m = TAG.exec(src);
      if (!m) return undefined;
      return { type: "hashTag", raw: m[0], tag: m[1]!.replace(/\/+$/, "") } satisfies TagToken;
    },
    renderer(token) {
      const tag = (token as TagToken).tag;
      return `<a href="#" class="hashtag" data-tag="${escape(tag.toLowerCase())}">#${escape(tag)}</a>`;
    }
  };
  return [wikiLink, hashTag];
}

/** Each top-level block tagged with the source line it starts on, so a preview can keep pace with the editor beside it. */
function withLines(marked: Marked, text: string): string {
  const tokens = marked.lexer(text);
  let line = 1;
  let html = "";
  for (const token of tokens) {
    // Reference links were resolved while lexing, so a block renders the same alone.
    const part = marked.parser([token]);
    html += part.replace(/^(\s*<[a-z][a-z0-9-]*)/i, `$1 data-line="${line}"`);
    line += token.raw.split("\n").length - 1;
  }
  return html;
}

/** A task item's box as a drawing: the sanitizer takes inputs out, and a box nobody can tick should not look tickable. */
const checkbox = ({ checked }: Tokens.Checkbox): string => `<span class="md-task" role="checkbox" aria-checked="${checked}" aria-disabled="true"></span> `;

/** Files of the store linked by id, and files an editor holds until it saves; the sanitizer would drop either scheme. */
const APP_LINK = /^tomrade-(file|draft):\/\/([\w-]+)$/;

const appLink = (href: string): string | null => {
  const m = APP_LINK.exec(href);
  return m ? `data-${m[1]}-id="${escape(m[2]!.toLowerCase())}"` : null;
};

const renderer = {
  checkbox,
  image({ href, text }: Tokens.Image): string | false {
    const data = appLink(href);
    return data ? `<img class="md-file" ${data} alt="${escape(text)}">` : false;
  },
  link(this: { parser: { parseInline: (tokens: Tokens.Generic[]) => string } }, { href, tokens }: Tokens.Link): string | false {
    const data = appLink(href);
    return data ? `<a href="#" class="md-attachment" ${data}>${this.parser.parseInline(tokens)}</a>` : false;
  }
};

// A parser per resolver and line-break rule, built once: a streamed or re-rendered reply parses without building one each time.
const NO_RESOLVER = {};
const parsers = new WeakMap<object, Map<boolean, Marked>>();
function markedFor(resolve: LinkResolver | typeof NO_RESOLVER | null, breaks: boolean): Marked {
  const key = resolve ?? parsers;
  let byBreaks = parsers.get(key);
  if (!byBreaks) parsers.set(key, (byBreaks = new Map()));
  let marked = byBreaks.get(breaks);
  if (!marked) {
    marked = new Marked({ extensions: resolve === null ? [] : extensions(resolve === NO_RESOLVER ? undefined : (resolve as LinkResolver)), renderer, breaks, async: false });
    byBreaks.set(breaks, marked);
  }
  return marked;
}

/**
 * Markdown as the viewer shows it: wiki links and tags drawn as the app's own
 * links, a dangling link marked as one, and the whole tree through the same
 * sanitizer that keeps inline HTML from doing anything. `notes: false` is
 * plain GFM, for text that is not a note of the store; `breaks` keeps a single
 * newline as a line break, as a GitHub issue does.
 */
export function renderMarkdown(text: string, resolve?: LinkResolver, opts: { lines?: boolean; notes?: boolean; breaks?: boolean } = {}): string {
  const marked = markedFor(opts.notes === false ? null : resolve ?? NO_RESOLVER, !!opts.breaks);
  const html = opts.lines ? withLines(marked, text) : (marked.parse(text, { async: false }) as string);
  // A relative markdown link is a note of this store; mark the ones that lead nowhere.
  const decode = decodeHref;
  const linked = resolve
    ? html
        .replace(/<a href="([^"#:][^":]*?)(#[^"]*)?"/g, (whole, href: string) => (resolve(decode(href), "markdown") ? whole : `${whole} class="is-unresolved"`))
        .replace(/<img src="([^":]+?)"/g, (whole, src: string) => {
          const file = resolve(decode(src), "markdown");
          return file ? `<img class="note-image" data-file="${escape(file)}"` : whole;
        })
    : html;
  return DOMPurify.sanitize(linked, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input", "button"] });
}
