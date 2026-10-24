/**
 * The wheel over an open select's list scrolls that list. A modal sheet's
 * scroll lock (Radix's, on the document) lets a wheel through only when it
 * finds an element under the pointer that can scroll; the list a
 * `base-select` draws scrolls in its `::picker`, which is no element, so the
 * lock cancelled every wheel there and only the scrollbar moved it. Stopped
 * at the window, first, the wheel never reaches the lock and the browser
 * scrolls the list itself.
 */
export function letOpenSelectsScroll(): void {
  window.addEventListener(
    "wheel",
    (event) => {
      const select = event.target instanceof Element ? event.target.closest("select") : null;
      if (select && isOpen(select)) event.stopPropagation();
    },
    { capture: true, passive: true }
  );
}

function isOpen(select: HTMLSelectElement): boolean {
  try {
    return select.matches(":open");
  } catch {
    // An engine without `:open` draws the OS list, which no page lock reaches.
    return false;
  }
}
