import type { Item } from "@tomradex/domain";

export const KEY_RE = /([A-Z][A-Z0-9]{1,9}-\d+)/g;

// A markdown link, a path quoted in backticks, a web or file URL, or a bare absolute path — in that order of preference.
export const LINK_RE = /\[([^\]\n]+)\]\(((?:https?|file):\/\/[^\s)]+|~?\/[^\s)]+|[A-Za-z]:\\[^\s)]+)\)|`((?:~\/|\/|[A-Za-z]:\\)[^`\n]+)`|((?:https?|file):\/\/[^\s<>"'`\u3000-\u303f\uff01-\uff0f\uff1a-\uff20]+)|((?<![\w/:.~-])(?:~\/|\/)[\w.@%+-]+(?:\/[\w.@%+-]+)+\/?|(?<![\w])[A-Za-z]:\\[^\s<>"'`\u3000-\u303f\uff01-\uff0f\uff1a-\uff20]+)/g;
// A bare slash path counts only where it looks like a file on disk, not a route such as /api/v1.
export const ON_DISK = /^(?:~\/|\/(?:Users|home|Volumes|tmp|private|opt|var|mnt)\/|[A-Za-z]:\\)|\.\w{1,8}\/?$/;

/** Sentence punctuation after a bare link belongs to the sentence; a closing bracket only when the link never opened one. */
export function trimTrailing(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1];
    if (".,;:!?'\"。，；：！？、》」』".includes(ch)) end--;
    else if (ch === ")" && raw.slice(0, end).split("(").length <= raw.slice(0, end).split(")").length - 1) end--;
    else if ((ch === "]" || ch === "）") && !raw.slice(0, end - 1).includes(ch === "]" ? "[" : "（")) end--;
    else break;
  }
  return raw.slice(0, end);
}

/** A local path from a `file://` URL, or the path as written. */
export function localPath(target: string): string {
  if (!/^file:\/\//i.test(target)) return target;
  try {
    const pathname = decodeURIComponent(new URL(target).pathname);
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return target;
  }
}

const BARE_LINK_RE = /((?:https?|file):\/\/[^\s<>"'`\u3000-\u303f\uff01-\uff0f\uff1a-\uff20]+)|((?<![\w/:.~-])(?:~\/|\/)[\w.@%+-]+(?:\/[\w.@%+-]+)+\/?|(?<![\w])[A-Za-z]:\\[^\s<>"'`\u3000-\u303f\uff01-\uff0f\uff1a-\uff20]+)/g;
const LOCAL_TARGET = /^(?:file:\/\/|~\/|\/|[A-Za-z]:\\)/i;

/** Keys, URLs and paths in a text node of the rendered tree, as the same chips and links plain text gets; null when it has none. */
function decorateText(doc: Document, text: string, byKey: Map<string, Item>, inCode: boolean): DocumentFragment | null {
  const frag = doc.createDocumentFragment();
  let changed = false;
  const keys = (part: string) => {
    part.split(KEY_RE).forEach((piece, i) => {
      if (i % 2 === 0) { if (piece) frag.append(piece); return; }
      changed = true;
      const item = byKey.get(piece);
      const el = doc.createElement(item ? "button" : "span");
      el.className = item ? "kref num" : "kref dead num";
      el.textContent = piece;
      if (item) {
        el.setAttribute("type", "button");
        el.dataset.itemId = item.id;
        el.title = `${item.title} · ${item.status}`;
      }
      frag.append(el);
    });
  };
  // inline code is a path quoted in backticks, or code; only the first becomes a link
  if (inCode) {
    if (!LOCAL_TARGET.test(text) || text.includes("\n")) return null;
    const a = doc.createElement("a");
    a.className = "tlink";
    a.dataset.path = localPath(text);
    a.textContent = text;
    frag.append(a);
    return frag;
  }
  let last = 0;
  for (const m of text.matchAll(BARE_LINK_RE)) {
    const [, url, bare] = m;
    const raw = trimTrailing(url ?? bare!);
    if (bare !== undefined && !ON_DISK.test(raw)) continue;
    keys(text.slice(last, m.index));
    const a = doc.createElement("a");
    a.className = "tlink";
    if (/^https?:/i.test(raw)) a.dataset.url = raw;
    else a.dataset.path = localPath(raw);
    a.textContent = raw;
    frag.append(a);
    changed = true;
    last = m.index + raw.length;
  }
  keys(text.slice(last));
  return changed ? frag : null;
}

const safeDecode = (href: string): string => {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
};

/** `[label](file:///…)` as a plain path link, since the sanitizer drops file: URLs; a drive path keeps its leading slash for the same reason. */
export const withoutFileUrls = (text: string): string =>
  text.replace(/\]\((file:\/\/[^\s)]+)\)/gi, (whole, url: string) => {
    try {
      return `](${new URL(url).pathname})`;
    } catch {
      return whole;
    }
  });

/** The sanitized HTML with keys, links and paths made live; links written in Markdown keep their label and open the same way. */
export function decorate(html: string, byKey: Map<string, Item>): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const doc = tpl.ownerDocument;
  for (const a of tpl.content.querySelectorAll("a[href]")) {
    let href = a.getAttribute("href")!;
    // GFM autolinks run on through CJK punctuation and the words after it; cut them where plain text would
    const label = a.textContent ?? "";
    if (a.childNodes.length === 1 && /^(?:https?:\/\/|www\.)/i.test(label)) {
      const url = trimTrailing(/^[^\s<>"'`\u3000-\u303f\uff01-\uff0f\uff1a-\uff20]+/.exec(label)?.[0] ?? label);
      if (url.length < label.length) {
        a.textContent = url;
        a.after(label.slice(url.length));
        href = /^www\./i.test(url) ? `http://${url}` : url;
        a.setAttribute("href", href);
      }
    }
    a.classList.add("tlink");
    if (/^https?:/i.test(href)) a.setAttribute("data-url", href);
    else if (LOCAL_TARGET.test(href)) a.setAttribute("data-path", safeDecode(href).replace(/^\/(?=[A-Za-z]:\/)/, ""));
  }
  const walker = doc.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent || parent.closest("a, pre")) continue;
    const inCode = parent.tagName === "CODE";
    const frag = decorateText(doc, node.data, byKey, inCode);
    if (!frag) continue;
    node.replaceWith(frag);
  }
  return tpl.innerHTML;
}
