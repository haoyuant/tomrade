/** What a cell's terminal offers its menu: whether there is a selection to copy, copying it and pasting into it. */
export interface CellClipboard {
  canCopy(): boolean;
  copy(): void;
  paste(): void;
}

const byCell = new Map<string, CellClipboard>();

/** A terminal attached in this cell offers its clipboard until it detaches. */
export function offerClipboard(cell: string, clipboard: CellClipboard): () => void {
  byCell.set(cell, clipboard);
  return () => {
    if (byCell.get(cell) === clipboard) byCell.delete(cell);
  };
}

/** The clipboard of the terminal in this cell, or null when no terminal is attached there. */
export const clipboardOf = (cell: string): CellClipboard | null => byCell.get(cell) ?? null;
