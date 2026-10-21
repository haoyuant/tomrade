import * as RadixDialog from "@radix-ui/react-dialog";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import { isComposing } from "~/lib/keys";
import { cn } from "~/lib/utils";

/**
 * Radix supplies the focus trap, the restore and the inert background; the
 * design supplies every pixel. `.scrim` is the overlay, `.palette.modal` the
 * sheet — centred on the workspace row, height capped to the same row.
 */
export function Dialog({
  open,
  onOpenChange,
  label,
  className,
  resizable,
  movable,
  children
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  className?: string;
  /** A storage key: the sheet gets a corner grip and remembers its size. Limits are the sheet's CSS min/max. */
  resizable?: string;
  /** The sheet moves when its header is dragged, back to the centre on a double-click. It opens centred each time. */
  movable?: boolean;
  children: ReactNode;
}) {
  // These dialogs open from `open` state rather than a Radix Trigger, so Radix
  // has nothing to hand focus back to — remember it here.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      opener.current = document.activeElement as HTMLElement | null;
      return;
    }
    const node = opener.current;
    opener.current = null;
    if (node && document.contains(node)) node.focus();
  }, [open]);

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="scrim" />
        {/* `.modal` is not the caller's to opt into — it is what centres the
            sheet on the workspace row and caps its height. Forgetting it left
            dialogs sitting at the command palette's 96px top anchor. A
            `className` here only ever picks a width. */}
        <RadixDialog.Content
          className={cn("palette modal", movable && "is-movable", className)}
          aria-label={label}
          // that Escape dismisses an IME candidate list, not the sheet
          onEscapeKeyDown={(e) => { if (isComposing(e)) e.preventDefault(); }}
        >
          <RadixDialog.Title className="sr-only">{label}</RadixDialog.Title>
          <Movable.Provider value={!!movable}>{children}</Movable.Provider>
          {resizable && <ResizeGrip storageKey={resizable} />}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/**
 * A key that moves on each opening — `open` turning true, or a new non-empty
 * subject — so a dialog keyed by it starts every opening from fresh state. It
 * holds still on close: the closing dialog keeps its instance, and with it the
 * focus it hands back.
 */
export function useOpeningKey(opening: unknown): number {
  const [seen, setSeen] = useState({ opening, count: 0 });
  if (!Object.is(seen.opening, opening)) setSeen({ opening, count: opening ? seen.count + 1 : seen.count });
  return seen.count;
}

const Movable = createContext(false);

/** How much of a moved sheet stays on the window sideways: enough to take hold of it again. */
const KEEP = 96;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const offsetOf = (el: HTMLElement) => ({ x: parseFloat(el.style.getPropertyValue("--dlg-x")) || 0, y: parseFloat(el.style.getPropertyValue("--dlg-y")) || 0 });

/**
 * Shifts a movable sheet off its centred place. Its header stays below the title
 * bar — that is a drag region, and would take the pointer from it — and above the
 * window's bottom, with at least KEEP px of the sheet on the window to either side.
 */
function moveSheet(el: HTMLElement, to: { x: number; y: number }) {
  const at = offsetOf(el);
  const r = el.getBoundingClientRect();
  const [left, top] = [r.left - at.x, r.top - at.y];
  const head = el.querySelector(".dlg-head")?.getBoundingClientRect().height ?? 0;
  const below = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--titlebar-h")) || 0;
  el.style.setProperty("--dlg-x", `${Math.round(clamp(to.x, KEEP - r.width - left, window.innerWidth - KEEP - left))}px`);
  el.style.setProperty("--dlg-y", `${Math.round(clamp(to.y, below - top, window.innerHeight - head - top))}px`);
}

const SIZE_PREFIX = "tomrade.dialogSize.";

function readSize(key: string): { w: number; h: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(SIZE_PREFIX + key) ?? "null") as { w?: unknown; h?: unknown } | null;
    return v && typeof v.w === "number" && typeof v.h === "number" ? { w: v.w, h: v.h } : null;
  } catch {
    return null;
  }
}

function writeSize(key: string, size: { w: number; h: number } | null) {
  try {
    if (size) localStorage.setItem(SIZE_PREFIX + key, JSON.stringify(size));
    else localStorage.removeItem(SIZE_PREFIX + key);
  } catch {
    // the size is a convenience; without storage it is simply not kept
  }
}

/**
 * The sheet stays centred, so its corner moves twice as far as one edge would —
 * doubling the delta keeps it under the pointer. CSS min/max clamp whatever is
 * asked, and the size actually rendered is the one kept.
 */
function ResizeGrip({ storageKey }: { storageKey: string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const sheet = () => ref.current?.parentElement ?? null;
  const apply = (size: { w: number; h: number } | null) => {
    const el = sheet();
    if (!el) return;
    el.style.width = size ? `${size.w}px` : "";
    el.style.height = size ? `${size.h}px` : "";
    // a moved sheet grows about its centre too, which can carry its header under the title bar
    if (el.classList.contains("is-movable")) moveSheet(el, offsetOf(el));
  };
  useLayoutEffect(() => apply(readSize(storageKey)), [storageKey]);
  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = sheet();
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const from = el.getBoundingClientRect();
    const [x0, y0] = [e.clientX, e.clientY];
    const move = (ev: PointerEvent) => apply({ w: from.width + 2 * (ev.clientX - x0), h: from.height + 2 * (ev.clientY - y0) });
    const end = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      const r = el.getBoundingClientRect();
      writeSize(storageKey, { w: Math.round(r.width), h: Math.round(r.height) });
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  };
  const reset = () => {
    apply(null);
    writeSize(storageKey, null);
  };
  return <div ref={ref} className="dlg-grip" aria-hidden="true" title={t("common.resizeGrip")} onPointerDown={start} onDoubleClick={reset} />;
}

// the header's own controls keep their clicks
const HEAD_CONTROLS = "button, a, input, select, textarea, label, [role='button']";

export function DialogHead({ title, aside, children }: { title: string; aside?: ReactNode; children?: ReactNode }) {
  const { t } = useI18n();
  const movable = useContext(Movable);
  const ref = useRef<HTMLDivElement>(null);
  const sheet = () => ref.current?.closest<HTMLElement>(".palette") ?? null;
  // a window made smaller must not leave the sheet out of reach
  useEffect(() => {
    if (!movable) return;
    const keep = () => {
      const el = sheet();
      if (el) moveSheet(el, offsetOf(el));
    };
    window.addEventListener("resize", keep);
    return () => window.removeEventListener("resize", keep);
  }, [movable]);
  const onHead = (e: ReactPointerEvent | ReactMouseEvent) => !(e.target as HTMLElement).closest(HEAD_CONTROLS);
  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = sheet();
    if (!el || e.button !== 0 || !onHead(e)) return;
    e.preventDefault();
    const head = e.currentTarget;
    head.setPointerCapture(e.pointerId);
    const from = offsetOf(el);
    const [x0, y0] = [e.clientX, e.clientY];
    const move = (ev: PointerEvent) => moveSheet(el, { x: from.x + ev.clientX - x0, y: from.y + ev.clientY - y0 });
    const end = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", end);
      head.removeEventListener("pointercancel", end);
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
  };
  const centre = (e: ReactMouseEvent<HTMLDivElement>) => {
    const el = sheet();
    if (!el || !onHead(e)) return;
    el.style.removeProperty("--dlg-x");
    el.style.removeProperty("--dlg-y");
  };
  return (
    <div
      ref={ref}
      className="dlg-head"
      onPointerDown={movable ? start : undefined}
      onDoubleClick={movable ? centre : undefined}
    >
      <h2 className="dlg-title" title={movable ? t("common.moveSheet") : undefined}>
        {title}
      </h2>
      {aside}
      <div className="spacer" />
      {children}
      <RadixDialog.Close asChild>
        <button type="button" className="btn btn-icon" aria-label={t("common.closeTitled", { title: title.toLowerCase() })}>
          <Icon name="i-close" size={15} />
        </button>
      </RadixDialog.Close>
    </div>
  );
}

export const DialogBody = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div className={cn("dlg-body", className)}>{children}</div>
);

export const DialogFoot = ({ children }: { children: ReactNode }) => <div className="dlg-foot">{children}</div>;

export const DialogClose = RadixDialog.Close;
