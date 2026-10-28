import { useEffect, useState } from "react";
import type { renderMarkdown } from "./markdown";

type Render = typeof renderMarkdown;

let loaded: Render | null = null;
let loading: Promise<Render> | null = null;

/** The Markdown renderer (marked and DOMPurify), brought the first time a reply needs it. */
export function loadMarkdown(): Promise<Render> {
  loading ??= import("./markdown").then((m) => (loaded = m.renderMarkdown));
  // A failed load is tried again by the next reply that asks.
  loading.catch(() => (loading = null));
  return loading;
}

/** `renderMarkdown` once it has arrived; null until then, while the caller shows the text as it is. */
export function useRenderMarkdown(): Render | null {
  const [render, setRender] = useState<Render | null>(() => loaded);
  useEffect(() => {
    if (render) return;
    let live = true;
    loadMarkdown().then(
      (r) => live && setRender(() => r),
      () => {}
    );
    return () => {
      live = false;
    };
  }, [render]);
  return render;
}
