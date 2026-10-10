import DOMPurify from "dompurify";
import { Marked, type TokenizerAndRendererExtension, type Tokens } from "marked";

/** Which file a link means; null when nothing answers to it yet. */
export type LinkResolver = (target: string, kind: "wiki" | "markdown") => string | null;

const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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

/**
 * Markdown as the viewer shows it: wiki links and tags drawn as the app's own
 * links, a dangling link marked as one, and the whole tree through the same
 * sanitizer that keeps inline HTML from doing anything.
 */
export function renderMarkdown(text: string, resolve?: LinkResolver): string {
  const marked = new Marked({ extensions: extensions(resolve), async: false });
  const html = marked.parse(text, { async: false }) as string;
  // A relative markdown link is a note of this store; mark the ones that lead nowhere.
  const linked = resolve
    ? html.replace(/<a href="([^"#:][^":]*?)(#[^"]*)?"/g, (whole, href: string) => {
        let target = href;
        try {
          target = decodeURI(href);
        } catch {
          // as written
        }
        return resolve(target, "markdown") ? whole : `${whole} class="is-unresolved"`;
      })
    : html;
  return DOMPurify.sanitize(linked, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input", "button"] });
}
