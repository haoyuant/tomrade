import type { ILink, Terminal } from "@xterm/xterm";

type Cell = { x: number; y: number };
type Line = { first: number; last: number; text: string; cells: Cell[] };

/** How near the right edge a path must end for the next row to be read as the rest of it. */
const EDGE = 4;
/** A program that lays its own text out breaks a long path at the edge; no path runs over more rows than this. */
const ROWS = 4;
// A boundary prevents detecting the path inside an https:// URL as a local file. Chinese text puts no space after its marks.
const PATHS = /(?<=^|[\s(["'：，。；、（【「『《“‘])((?:"(?:\/|~\/|[A-Za-z]:[\\/])[^"\r\n]+"|'(?:\/|~\/|[A-Za-z]:[\\/])[^'\r\n]+')|(?:file:\/\/|\/|~\/|[A-Za-z]:[\\/])[^\s<>"'`\])}]+)/g;
const MORE = /^\s*([^\s<>"'`\])}]+)/;
const bare = (path: string) => path.replace(/[.,;!?。，；！？、：]+$/, "");

/**
 * Local file URLs and absolute paths, including quoted paths with spaces. A path that ends at the right edge goes on
 * in the next row after its indent: `or` is then the first row's part, for when the two are not one path after all.
 */
export function fileLinks(terminal: Terminal, activate: (event: MouseEvent, target: string, or?: string) => void) {
  /** The line a row belongs to as xterm wrapped it: its text, and the cell of each character. */
  const lineAt = (row: number): Line | null => {
    const buffer = terminal.buffer.active;
    if (row < 0 || !buffer.getLine(row)) return null;
    let first = row;
    while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
    let last = row;
    while (buffer.getLine(last + 1)?.isWrapped) last++;
    let text = "";
    const cells: Cell[] = [];
    for (let at = first; at <= last; at++) {
      const line = buffer.getLine(at);
      for (let col = 0; col < terminal.cols; col++) {
        const cell = line?.getCell(col);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars() || " ";
        for (let i = 0; i < chars.length; i++) cells.push({ x: col + 1, y: at + 1 });
        text += chars;
      }
    }
    return { first, last, text, cells };
  };
  const atEdge = (cell: Cell | undefined) => !!cell && cell.x >= terminal.cols - EDGE;
  const linksOf = (line: Line): ILink[] => {
    const links: ILink[] = [];
    const length = line.text.trimEnd().length;
    for (const match of line.text.matchAll(PATHS)) {
      const quoted = /^["']/.test(match[0]);
      const start = match.index + (quoted ? 1 : 0);
      let whole = quoted ? match[0].slice(1, -1) : match[0];
      const span = line.cells.slice(start, start + whole.length);
      let or: string | undefined;
      let tail = line;
      for (let rows = 1; !quoted && rows < ROWS && match.index + match[0].length === length && atEdge(span.at(-1)); rows++) {
        const next = lineAt(tail.last + 1);
        const more = next && MORE.exec(next.text);
        if (!next || !more) break;
        or ??= bare(whole);
        whole += more[1];
        span.push(...next.cells.slice(more[0].length - more[1]!.length, more[0].length));
        if (more[0].length !== next.text.trimEnd().length) break;
        tail = next;
      }
      const target = quoted ? whole : bare(whole);
      const from = span[0];
      const to = span[target.length - 1];
      if (!target || target === "/" || !from || !to) continue;
      links.push({ text: target, range: { start: from, end: to }, activate: (event) => activate(event, target, or) });
    }
    return links;
  };
  return terminal.registerLinkProvider({
    provideLinks(y, callback) {
      const line = lineAt(y - 1);
      const links = line ? linksOf(line) : [];
      // This row may be the rest of a path that began above it.
      for (let above = line && lineAt(line.first - 1), rows = 1; above && rows < ROWS; above = lineAt(above.first - 1), rows++) {
        links.unshift(...linksOf(above).filter((link) => link.range.end.y >= y));
      }
      callback(links);
    }
  });
}
