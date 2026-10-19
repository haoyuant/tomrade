import fs from "node:fs";
import path from "node:path";
import type { SurfaceBounds } from "@tomradex/desktop-surface";

/** Where each window surface was last left, by surface id, in one file of the app's own. */
export class SurfaceBoundsStore {
  constructor(private readonly file: string) {}

  private read(): Record<string, SurfaceBounds> {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, SurfaceBounds>;
    } catch {
      return {};
    }
  }

  get(id: string): SurfaceBounds | null {
    const b = this.read()[id];
    return b && [b.x, b.y, b.width, b.height].every(Number.isFinite) ? b : null;
  }

  set(id: string, bounds: SurfaceBounds): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ ...this.read(), [id]: bounds }));
    } catch {
      // Remembering where it was is a nicety; the window opens centred next time.
    }
  }
}

/** How much of a window must still be on some screen for its old place to be used again. */
const VISIBLE = 64;

/**
 * Where a window opens: where it was last left, no smaller than it may be, while enough of it is
 * on a screen still attached; otherwise the asked size centred on the primary work area.
 */
export function placeWindow(saved: SurfaceBounds | null, size: { width: number; height: number; minWidth?: number; minHeight?: number }, areas: SurfaceBounds[]): SurfaceBounds {
  const primary = areas[0] ?? { x: 0, y: 0, width: size.width, height: size.height };
  if (saved) {
    const width = Math.max(saved.width, size.minWidth ?? 0);
    const height = Math.max(saved.height, size.minHeight ?? 0);
    const seen = areas.some((a) => Math.min(saved.x + width, a.x + a.width) - Math.max(saved.x, a.x) >= VISIBLE && Math.min(saved.y + height, a.y + a.height) - Math.max(saved.y, a.y) >= VISIBLE);
    if (seen) return { x: saved.x, y: saved.y, width, height };
  }
  const width = Math.min(size.width, primary.width);
  const height = Math.min(size.height, primary.height);
  return { x: Math.round(primary.x + (primary.width - width) / 2), y: Math.round(primary.y + (primary.height - height) / 2), width, height };
}
