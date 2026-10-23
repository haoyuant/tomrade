import type { ILink, Terminal } from "@xterm/xterm";

/** Local file URLs and absolute paths, including quoted paths with spaces. */
export function fileLinks(terminal: Terminal, activate: (event: MouseEvent, target: string) => void) {
  return terminal.registerLinkProvider({
    provideLinks(y, callback) {
      const buffer = terminal.buffer.active;
      let first = y - 1;
      while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
      let last = y - 1;
      while (buffer.getLine(last + 1)?.isWrapped) last++;
      let text = "";
      const cells: { x: number; y: number }[] = [];
      for (let row = first; row <= last; row++) {
        const line = buffer.getLine(row);
        for (let col = 0; col < terminal.cols; col++) {
          const cell = line?.getCell(col);
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || " ";
          for (let i = 0; i < chars.length; i++) cells.push({ x: col + 1, y: row + 1 });
          text += chars;
        }
      }
      const links: ILink[] = [];
      // A boundary prevents detecting the path inside an https:// URL as a local file.
      const pattern = /(?<=^|[\s(["'])((?:"(?:\/|~\/|[A-Za-z]:[\\/])[^"\r\n]+"|'(?:\/|~\/|[A-Za-z]:[\\/])[^'\r\n]+')|(?:file:\/\/|\/|~\/|[A-Za-z]:[\\/])[^\s<>"'`\])}]+)/g;
      for (const match of text.matchAll(pattern)) {
        const quoted = /^["']/.test(match[0]);
        const target = quoted ? match[0].slice(1, -1) : match[0].replace(/[.,;!?]+$/, "");
        if (!target || target === "/") continue;
        const start = match.index + (quoted ? 1 : 0);
        const end = start + target.length - 1;
        const from = cells[start];
        const to = cells[end];
        if (!from || !to) continue;
        links.push({ text: target, range: { start: from, end: to }, activate });
      }
      callback(links);
    }
  });
}
