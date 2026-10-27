import { CLOSED_STATUSES, DEFAULT_CLOSED_WINDOW, type ClosedStatus, type ClosedWindow, type Item } from "@tomradex/domain";

/** The `closedWindow` settings section: one window per project id. */
export const CLOSED_WINDOW_SECTION = "closedWindow";

/** A project's window as its settings say, the default where they say nothing. */
export function closedWindowOf(settings: Record<string, unknown> | undefined, projectId: string): ClosedWindow {
  const all = settings?.[CLOSED_WINDOW_SECTION] as Record<string, Partial<ClosedWindow>> | undefined;
  const own = all?.[projectId];
  if (!own) return DEFAULT_CLOSED_WINDOW;
  return { limit: own.limit === undefined ? DEFAULT_CLOSED_WINDOW.limit : own.limit, days: own.days === undefined ? DEFAULT_CLOSED_WINDOW.days : own.days };
}

/** The settings with this project's window replaced; the default is stored as nothing. */
export function withClosedWindow(settings: Record<string, unknown>, projectId: string, window: ClosedWindow): Record<string, unknown> {
  const all = { ...((settings[CLOSED_WINDOW_SECTION] as Record<string, ClosedWindow> | undefined) ?? {}) };
  if (window.limit === DEFAULT_CLOSED_WINDOW.limit && window.days === DEFAULT_CLOSED_WINDOW.days) delete all[projectId];
  else all[projectId] = window;
  return { ...settings, [CLOSED_WINDOW_SECTION]: all };
}

/** How many more a "load more" asks for: a window's worth, or the default's when the window has no count. */
export const pageSize = (window: ClosedWindow | null): number => window?.limit ?? DEFAULT_CLOSED_WINDOW.limit ?? 50;

export const isClosed = (status: string): status is ClosedStatus => (CLOSED_STATUSES as readonly string[]).includes(status);

/** One list from several, each item once; the first list's copy wins, so the window's fresh rows stand. */
export function mergeById(lists: (Item[] | undefined)[]): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

/** Of a closed column's true size, how many tickets the board does not hold yet. */
export const hiddenCount = (total: number | undefined, shown: number): number => (total === undefined ? 0 : Math.max(0, total - shown));

/** A positive whole number typed in a field, or null for an empty or unusable one. */
export function wholeOrNull(text: string): number | null {
  const n = Math.floor(Number(text));
  return text.trim() && Number.isFinite(n) && n >= 1 ? n : null;
}
