import { BrowserWindow, screen } from "electron";
import type { Context } from "cordis";
import type { SurfaceBounds } from "@tomradex/desktop-surface";
import type {} from "@tomradex/ipc";
import { SurfaceBoundsStore } from "./surface-bounds.js";
import { createWindow, sayChrome, type WindowOptions, type WindowPlace } from "./window.js";

/** A tab on its way into a window of its own. */
export interface TabTarget {
  /** The route the window opens on, as the renderer's hash holds it. */
  route: string;
  /** Dragged out and let go: the window opens under the pointer. */
  dropped?: boolean;
}

declare module "@tomradex/ipc" {
  interface Channels {
    "windows.openTab": (tab: TabTarget) => void;
  }
}

type Point = { x: number; y: number };

const DEFAULT_SIZE = { width: 1200, height: 820 };
/** How far a window steps down and right off one already standing in its place. */
const STEP = 28;
/** How much of a remembered place must still be on some screen for it to be used again. */
const VISIBLE = 64;
const PLACE_KEY = "tab-window";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const centre = (b: SurfaceBounds): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const sameRect = (a: SurfaceBounds, b: SurfaceBounds) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * Where a window a tab moved into opens. Dropped: under the pointer, at the size last used. Otherwise
 * where the last one was left, stepped clear of any standing there; the first time, filling another
 * screen than the one the tab came from, or beside that window when there is only one screen.
 */
export function placeTabWindow(opts: {
  saved: WindowPlace | null;
  at?: Point;
  /** The window the tab came from. */
  from?: SurfaceBounds;
  /** Every screen's work area, the primary first. */
  areas: SurfaceBounds[];
  /** The unmaximized bounds of the windows tabs moved into that are open now. */
  taken: SurfaceBounds[];
}): WindowPlace {
  const { saved, at, from, areas, taken } = opts;
  const primary = areas[0] ?? { x: 0, y: 0, ...DEFAULT_SIZE };
  const areaAt = (p: Point) => areas.find((a) => p.x >= a.x && p.x < a.x + a.width && p.y >= a.y && p.y < a.y + a.height) ?? primary;
  const fit = (b: SurfaceBounds, area: SurfaceBounds): SurfaceBounds => {
    const width = Math.min(b.width, area.width);
    const height = Math.min(b.height, area.height);
    return { x: clamp(Math.round(b.x), area.x, area.x + area.width - width), y: clamp(Math.round(b.y), area.y, area.y + area.height - height), width, height };
  };
  const size = saved ? { width: saved.width, height: saved.height } : DEFAULT_SIZE;

  // The pointer lands on the new window's header, a little in from its left edge.
  if (at) return fit({ x: at.x - 120, y: at.y - 16, ...size }, areaAt(at));

  const seen = (b: SurfaceBounds) =>
    areas.some((a) => Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x) >= VISIBLE && Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y) >= VISIBLE);
  if (saved && seen(saved)) {
    const occupied = (b: SurfaceBounds) => taken.some((t) => Math.abs(t.x - b.x) < STEP / 2 && Math.abs(t.y - b.y) < STEP / 2);
    if (!occupied(saved)) return saved;
    // Never filling the screen over the one already there.
    const area = areaAt(centre(saved));
    let next = fit(saved, area);
    for (let i = 0; i < 24 && occupied(next); i++) next = fit({ ...next, x: next.x + STEP, y: next.y + STEP }, area);
    return next;
  }

  const home = from ? areaAt(centre(from)) : primary;
  const other = areas.find((a) => !sameRect(a, home));
  if (other) return { ...fit({ x: other.x + (other.width - size.width) / 2, y: other.y + (other.height - size.height) / 2, ...size }, other), maximized: true };
  const beside = from ?? home;
  return fit({ x: beside.x + STEP * 2, y: beside.y + STEP, ...size }, home);
}

/**
 * Tomrade's own windows: the one it opens with, and any a tab moved into. The oldest one open
 * leads — the shell brings it forward, and app-wide prompts land in it alone; when it closes,
 * the next oldest takes over.
 */
export class TomradeWindows {
  private readonly windows = new Set<BrowserWindow>();
  private readonly detached = new Set<BrowserWindow>();
  private readonly places: SurfaceBoundsStore;

  constructor(
    private readonly ctx: Context,
    private readonly base: Omit<WindowOptions, "detached" | "lead">,
    placesFile: string
  ) {
    this.places = new SurfaceBoundsStore(placesFile);
  }

  lead(): BrowserWindow | undefined {
    return [...this.windows].find((w) => !w.isDestroyed());
  }

  all(): BrowserWindow[] {
    return [...this.windows].filter((w) => !w.isDestroyed());
  }

  /** A Tomrade window; given a tab, one that tab moved into. */
  open(tab?: TabTarget): BrowserWindow {
    if (tab && !tab.route.startsWith("/")) throw new Error(`a tab's route starts with "/": ${tab.route}`);
    const detached = tab ? { route: tab.route, place: this.placeFor(tab) } : undefined;
    const win = createWindow(this.ctx, { ...this.base, ...(detached ? { detached } : {}), lead: (w) => w === this.lead() });
    this.windows.add(win);
    win.on("closed", () => {
      this.windows.delete(win);
      this.detached.delete(win);
      for (const other of this.all()) sayChrome(other, other === this.lead());
    });
    if (detached) {
      this.detached.add(win);
      this.remember(win, detached.place);
    }
    return win;
  }

  private placeFor(tab: TabTarget): WindowPlace {
    const primary = screen.getPrimaryDisplay().workArea;
    const areas = [primary, ...screen.getAllDisplays().map((d) => d.workArea).filter((a) => !sameRect(a, primary))];
    // The click that asked for it came from the focused window.
    const focused = BrowserWindow.getFocusedWindow();
    const from = focused && this.windows.has(focused) ? focused : this.lead();
    return placeTabWindow({
      saved: this.places.get(PLACE_KEY) as WindowPlace | null,
      // The release was a moment ago; the pointer has not gone far, and needs no page zoom undone.
      ...(tab.dropped ? { at: screen.getCursorScreenPoint() } : {}),
      ...(from ? { from: from.getBounds() } : {}),
      areas,
      taken: [...this.detached].filter((w) => !w.isDestroyed()).map((w) => w.getNormalBounds())
    });
  }

  /** The last window a tab moved into is where the next one goes. */
  private remember(win: BrowserWindow, first: WindowPlace): void {
    this.places.set(PLACE_KEY, first);
    let saving: NodeJS.Timeout | null = null;
    const save = () => {
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
      this.places.set(PLACE_KEY, { ...win.getNormalBounds(), ...(win.isMaximized() ? { maximized: true } : {}) } satisfies WindowPlace);
    };
    const later = () => {
      if (saving) clearTimeout(saving);
      saving = setTimeout(save, 300);
    };
    win.on("move", later);
    win.on("resize", later);
    win.on("maximize", later);
    win.on("unmaximize", later);
    win.on("close", () => {
      if (saving) clearTimeout(saving);
      save();
    });
  }
}
