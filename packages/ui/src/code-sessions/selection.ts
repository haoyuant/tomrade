import type { Terminal } from "@xterm/xterm";

/** Only the public xterm surface used by the selection follower. */
type SelectionTerminal = Pick<Terminal, "rows" | "cols" | "buffer" | "onSelectionChange" | "onWriteParsed" | "getSelectionPosition" | "select" | "clearSelection">;
type Point = [col: number, line: number];

/**
 * Frames contain repainted cells, not the application's scroll operations. In particular a TUI can
 * scroll its body while herdr's scrollback offset stays at zero. Anchor to the selected cells after
 * xterm parses each frame, rather than to that offset or the rows on the screen.
 */
export function followSelection(terminal: SelectionTerminal, el: HTMLElement) {
  let top = 0;
  let picked: { start: Point; end: Point } | null = null;
  let shown: { start: Point; end: Point; cutStart: boolean; cutEnd: boolean } | null = null;
  let lines = new Map<number, string>();
  let quiet = false;
  let held = false;
  const same = (a: Point, x: number, y: number) => a[0] === x && a[1] === y;
  const hide = () => {
    quiet = true;
    terminal.clearSelection();
    quiet = false;
    shown = null;
  };
  const show = (firstLine: number, lastLine: number) => {
    if (!picked) return;
    const cutStart = firstLine !== picked.start[1];
    const cutEnd = lastLine !== picked.end[1];
    const start: Point = [cutStart ? 0 : picked.start[0], firstLine - top];
    const end: Point = [cutEnd ? terminal.cols : picked.end[0], lastLine - top];
    quiet = true;
    terminal.select(start[0], start[1], (end[1] - start[1]) * terminal.cols + end[0] - start[0]);
    quiet = false;
    shown = { start, end, cutStart, cutEnd };
  };
  const changed = terminal.onSelectionChange(() => {
    if (quiet) return;
    const at = terminal.getSelectionPosition();
    if (!at) {
      picked = null;
      shown = null;
      lines.clear();
      return;
    }
    const start: Point = picked && shown?.cutStart && same(shown.start, at.start.x, at.start.y) ? picked.start : [at.start.x, at.start.y + top];
    const end: Point = picked && shown?.cutEnd && same(shown.end, at.end.x, at.end.y) ? picked.end : [at.end.x, at.end.y + top];
    picked = { start, end };
    shown = null;
    const kept = new Map([...lines].filter(([line]) => line >= start[1] && line <= end[1]));
    for (let y = Math.max(0, start[1] - top); y <= Math.min(terminal.rows - 1, end[1] - top); y++) {
      const line = top + y;
      kept.set(line, terminal.buffer.active.getLine(y)?.translateToString(true, line === start[1] ? start[0] : 0, line === end[1] ? end[0] : undefined) ?? "");
    }
    lines = kept;
  });
  const parsed = terminal.onWriteParsed(() => {
    if (!picked || held) return;
    // A candidate is a translation of the whole selection, clipped to the viewport. Blank rows
    // cannot identify text. Prefer the largest matching part; an ambiguous match hides the highlight
    // rather than selecting unrelated text. Keep the snapshot so scrolling back can find it again.
    let best: { top: number; first: number; last: number } | null = null;
    let score = 0;
    let tied = false;
    for (let candidate = picked.start[1] - terminal.rows + 1; candidate <= picked.end[1]; candidate++) {
      let matched = 0;
      let first = 0;
      for (const [line, text] of lines) {
        const y = line - candidate;
        if (y < 0 || y >= terminal.rows) continue;
        const actual = terminal.buffer.active.getLine(y)?.translateToString(true, line === picked.start[1] ? picked.start[0] : 0, line === picked.end[1] ? picked.end[0] : undefined) ?? "";
        // Fixed TUI headers and footers can occlude either end inside the viewport. Only draw
        // the contiguous matching run, never over those controls or newly inserted text.
        if (actual !== text) { matched = 0; first = line + 1; continue; }
        if (!matched) first = line;
        if (!text.trim()) continue;
        matched++;
        if (matched < score) continue;
        if (matched === score) tied = true;
        else { best = { top: candidate, first, last: line }; score = matched; tied = false; }
      }
    }
    if (best === null || tied) hide();
    else { top = best.top; show(best.first, best.last); }
  });
  // Always copy the snapshot, including between the arrival and parsing of a repaint, and while
  // the selection is outside the viewport. Never copy whatever replaced it at the old screen rows.
  const copy = (e: ClipboardEvent) => {
    if (!picked || !e.clipboardData) return;
    const text: string[] = [];
    for (let line = picked.start[1]; line <= picked.end[1]; line++) text.push((lines.get(line) ?? "").replace(/ /g, " "));
    e.clipboardData.setData("text/plain", text.join("\n"));
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const press = (e: MouseEvent) => {
    if (e.button !== 0) return;
    held = true;
    if (!e.shiftKey) { picked = null; shown = null; lines.clear(); }
  };
  const release = () => { held = false; };
  el.addEventListener("copy", copy, true);
  el.addEventListener("mousedown", press, true);
  window.addEventListener("mouseup", release);
  return {
    dispose() {
      changed.dispose();
      parsed.dispose();
      el.removeEventListener("copy", copy, true);
      el.removeEventListener("mousedown", press, true);
      window.removeEventListener("mouseup", release);
    },
  };
}
