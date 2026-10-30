/** What a scrolled view shows, as far as staying at its end goes. */
export interface EndBox {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly children: ArrayLike<Element>;
}

/** How near its end a view counts as at it: the person who scrolled back down follows again. */
export const END_SLACK = 48;

export const atEnd = (el: EndBox, slack = END_SLACK): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < slack;

/**
 * Keeps a view at its end while `following` says so. What it holds can grow after it was placed — lines laid out
 * only once seen, Markdown, a read that came in late — so any change of size, or lines coming and going, places it again.
 */
export function followEnd(el: EndBox, following: { current: boolean }) {
  /** Where the view last placed itself: a scroll event that finds it still there was the view's, not the person's. */
  let placed: number | null = null;
  const place = () => {
    if (!following.current) return;
    el.scrollTop = el.scrollHeight;
    placed = el.scrollTop;
  };
  const grow = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
  const watch = () => {
    if (!grow) return;
    grow.observe(el as unknown as Element);
    Array.from(el.children).forEach((kid) => grow.observe(kid));
  };
  const kids = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
    watch();
    place();
  });
  watch();
  kids?.observe(el as unknown as Node, { childList: true });
  return {
    place,
    /** The view scrolled: it follows while at its end, or while it sits where it placed itself and only grew under it. */
    scrolled() {
      if (placed !== null && el.scrollTop === placed) return;
      placed = null;
      following.current = atEnd(el);
    },
    stop() {
      grow?.disconnect();
      kids?.disconnect();
    }
  };
}
