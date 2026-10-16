import type { ImMarkdownDialect } from "./im.js";

/**
 * The common layer writes Markdown; each platform reads its own dialect.
 * Conversion covers what Agent replies use (emphasis, code, links, headings,
 * lists, quotes) and never touches the inside of code.
 */

type Inline =
  | { t: "text"; v: string; raw: string }
  | { t: "code"; v: string }
  | { t: "link"; label: Inline[]; url: string }
  | { t: "b" | "i" | "s"; c: Inline[] };

const ESCAPABLE = /[\\`*_~[\]()#>+\-.!|{}]/;

function inline(src: string): Inline[] {
  const out: Inline[] = [];
  let v = "", raw = "", i = 0;
  const flush = () => { if (raw) out.push({ t: "text", v, raw }); v = raw = ""; };
  const span = (open: string, close = open): number => {
    if (!src.startsWith(open, i) || /\s/.test(src[i + open.length] ?? " ")) return -1;
    if (open === "_" && /[\p{L}\p{N}]/u.test(src[i - 1] ?? "")) return -1;
    for (let j = src.indexOf(close, i + open.length + 1); j > 0; j = src.indexOf(close, j + 1)) {
      if (/\s/.test(src[j - 1])) continue;
      // A single delimiter must not be half of a double one.
      if (close.length === 1 && (src[j + 1] === close || src[j - 1] === close)) continue;
      if (close === "_" && /[\p{L}\p{N}]/u.test(src[j + 1] ?? "")) continue;
      return j;
    }
    return -1;
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && ESCAPABLE.test(src[i + 1] ?? "")) { v += src[i + 1]; raw += src.slice(i, i + 2); i += 2; continue; }
    if (ch === "`") {
      const run = /^`+/.exec(src.slice(i))![0];
      const end = src.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        out.push({ t: "code", v: src.slice(i + run.length, end).replace(/^ ([\s\S]*) $/, "$1") });
        i = end + run.length; continue;
      }
      v += run; raw += run; i += run.length; continue;
    }
    if (ch === "[") {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (m) { flush(); out.push({ t: "link", label: inline(m[1]), url: m[2] }); i += m[0].length; continue; }
    }
    if (ch === "<") {
      const m = /^<(https?:\/\/[^>\s]+)>/.exec(src.slice(i));
      if (m) { flush(); out.push({ t: "link", label: [{ t: "text", v: m[1], raw: m[1] }], url: m[1] }); i += m[0].length; continue; }
    }
    let matched = false;
    for (const [d, t] of [["**", "b"], ["__", "b"], ["~~", "s"], ["*", "i"], ["_", "i"]] as const) {
      const j = span(d);
      if (j < 0) continue;
      flush();
      out.push({ t, c: inline(src.slice(i + d.length, j)) });
      i = j + d.length; matched = true; break;
    }
    if (matched) continue;
    v += ch; raw += ch; i++;
  }
  flush();
  return out;
}

interface Writer {
  text(t: { v: string; raw: string }): string;
  code(v: string): string;
  pre(lang: string, body: string): string;
  link(label: string, url: string, plainLabel: string): string;
  b(s: string): string;
  i(s: string): string;
  s(s: string): string;
  heading(level: number, s: string): string;
  bullet(indent: string, s: string): string;
  ordered(indent: string, n: string, s: string): string;
  quote(s: string): string;
  hr: string;
  /** Joins rendered lines; Telegram merges adjacent quotes here. */
  finish?(out: string): string;
}

const tick = (v: string) => { const fence = v.includes("`") ? "``" : "`"; return `${fence}${fence.length > 1 ? " " : ""}${v}${fence.length > 1 ? " " : ""}${fence}`; };
const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;
const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plainText = (nodes: Inline[]): string => nodes.map(n => n.t === "text" || n.t === "code" ? n.v : n.t === "link" ? plainText(n.label) : plainText(n.c)).join("");

/** Markdown-family platforms; each drops what it does not render. */
const markdownish = (o: { headings: number; italic: boolean; strike: boolean; hr: string }): Writer => ({
  text: t => t.raw, code: tick, pre: fence, link: (l, u) => `[${l}](${u})`,
  b: s => `**${s}**`, i: s => o.italic ? `*${s}*` : s, s: s => o.strike ? `~~${s}~~` : s,
  heading: (n, s) => n <= o.headings ? `${"#".repeat(n)} ${s}` : `**${s}**`,
  bullet: (ind, s) => `${ind}- ${s}`, ordered: (ind, n, s) => `${ind}${n}. ${s}`, quote: s => `> ${s}`, hr: o.hr
});

const WRITERS: Record<Exclude<ImMarkdownDialect, "markdown">, Writer> = {
  plain: {
    text: t => t.v, code: v => v, pre: (_l, b) => b, link: (l, u) => l === u ? u : `${l} (${u})`,
    b: s => s, i: s => s, s: s => s, heading: (_n, s) => s,
    bullet: (ind, s) => `${ind}• ${s}`, ordered: (ind, n, s) => `${ind}${n}. ${s}`, quote: s => `> ${s}`, hr: "———"
  },
  slack: {
    text: t => html(t.v), code: v => tick(html(v)), pre: (_l, b) => fence("", html(b)),
    link: (_l, u, plain) => `<${u.replace(/[|>]/g, encodeURIComponent)}|${html(plain).replace(/\|/g, "¦")}>`,
    b: s => `*${s}*`, i: s => `_${s}_`, s: s => `~${s}~`, heading: (_n, s) => `*${s}*`,
    bullet: (ind, s) => `${ind}• ${s}`, ordered: (ind, n, s) => `${ind}${n}. ${s}`, quote: s => `> ${s}`, hr: "———"
  },
  "telegram-html": {
    text: t => html(t.v), code: v => `<code>${html(v)}</code>`,
    pre: (l, b) => l ? `<pre><code class="language-${html(l)}">${html(b)}</code></pre>` : `<pre>${html(b)}</pre>`,
    link: (l, u) => `<a href="${html(u).replace(/"/g, "&quot;")}">${l}</a>`,
    b: s => `<b>${s}</b>`, i: s => `<i>${s}</i>`, s: s => `<s>${s}</s>`, heading: (_n, s) => `<b>${s}</b>`,
    bullet: (ind, s) => `${ind}• ${s}`, ordered: (ind, n, s) => `${ind}${n}. ${s}`, quote: s => `<blockquote>${s}</blockquote>`, hr: "———",
    finish: out => out.replace(/<\/blockquote>\n<blockquote>/g, "\n")
  },
  discord: markdownish({ headings: 3, italic: true, strike: true, hr: "———" }),
  lark: markdownish({ headings: 0, italic: true, strike: true, hr: "---" }),
  dingtalk: markdownish({ headings: 6, italic: true, strike: false, hr: "---" }),
  wecom: markdownish({ headings: 6, italic: false, strike: false, hr: "———" })
};

function renderInline(nodes: Inline[], w: Writer): string {
  return nodes.map(n => {
    switch (n.t) {
      case "text": return w.text(n);
      case "code": return w.code(n.v);
      case "link": return w.link(renderInline(n.label, w), n.url, plainText(n.label));
      default: return w[n.t](renderInline(n.c, w));
    }
  }).join("");
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;

type Unit = { t: "code"; lang: string; lines: string[] } | { t: "line"; v: string };

function units(md: string): Unit[] {
  const out: Unit[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]);
    if (!open) { out.push({ t: "line", v: lines[i] }); continue; }
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[j]);
      if (close && close[1][0] === open[1][0] && close[1].length >= open[1].length) break;
      body.push(lines[j]);
    }
    out.push({ t: "code", lang: open[2], lines: body });
    i = j;
  }
  return out;
}

function renderLine(line: string, w: Writer): string {
  let m: RegExpExecArray | null;
  if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) return w.heading(m[1].length, renderInline(inline(m[2]), w));
  if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) return w.hr;
  if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) return w.bullet(m[1], renderInline(inline(m[2]), w));
  if ((m = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line))) return w.ordered(m[1], m[2], renderInline(inline(m[3]), w));
  if ((m = /^ {0,3}>\s?(.*)$/.exec(line))) return w.quote(renderLine(m[1], w));
  return renderInline(inline(line), w);
}

/** Converts the common layer's Markdown into an adapter's dialect. */
export function toImDialect(markdown: string, dialect: ImMarkdownDialect): string {
  if (dialect === "markdown") return markdown;
  const w = WRITERS[dialect];
  const out = units(markdown).map(u => u.t === "code" ? w.pre(u.lang, u.lines.join("\n")) : renderLine(u.v, w)).join("\n");
  return w.finish ? w.finish(out) : out;
}

/** The longest prefix that still fits, never cutting a surrogate pair, preferring a space. */
function hardSplit(s: string, fits: (piece: string) => boolean): string[] {
  const pieces: string[] = [];
  let rest = s;
  while (rest && !fits(rest)) {
    let lo = 1, hi = rest.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(rest.slice(0, mid))) lo = mid; else hi = mid - 1;
    }
    let n = lo;
    if (/[\uD800-\uDBFF]/.test(rest[n - 1]) && n > 1) n--;
    const space = rest.lastIndexOf(" ", n - 1);
    if (space > n / 2) n = space + 1;
    pieces.push(rest.slice(0, n));
    rest = rest.slice(n);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Splits Markdown into messages that each fit `max` once converted, breaking
 * between lines. A code block stays whole when it fits a message; a longer one
 * is closed and reopened with its language rather than cut mid-fence.
 */
export function splitImText(markdown: string, max: number, dialect: ImMarkdownDialect = "markdown"): string[] {
  const render = (s: string) => toImDialect(s, dialect);
  const fits = (s: string) => render(s).length <= max;
  if (fits(markdown)) return [render(markdown)];
  const pieces: string[] = [];
  for (const u of units(markdown)) {
    if (u.t === "line") { pieces.push(...hardSplit(u.v, fits)); continue; }
    const whole = fence(u.lang, u.lines.join("\n"));
    if (fits(whole)) { pieces.push(whole); continue; }
    let group: string[] = [];
    const wrapped = (lines: string[]) => fence(u.lang, lines.join("\n"));
    for (const line of u.lines) {
      if (fits(wrapped([...group, line]))) { group.push(line); continue; }
      if (group.length) pieces.push(wrapped(group));
      group = [];
      for (const part of hardSplit(line, p => fits(wrapped([p])))) {
        if (fits(wrapped([...group, part]))) group.push(part);
        else { pieces.push(wrapped(group)); group = [part]; }
      }
    }
    if (group.length) pieces.push(wrapped(group));
  }
  const chunks: string[] = [];
  let current: string[] = [];
  for (const piece of pieces) {
    if (current.length && !fits([...current, piece].join("\n"))) { chunks.push(current.join("\n")); current = []; }
    current.push(piece);
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks.map(c => c.replace(/^\n+|\n+$/g, "")).filter(Boolean).map(render);
}
