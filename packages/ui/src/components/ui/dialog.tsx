import * as RadixDialog from "@radix-ui/react-dialog";
import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
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
  children
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  className?: string;
  /** A storage key: the sheet gets a corner grip and remembers its size. Limits are the sheet's CSS min/max. */
  resizable?: string;
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
        <RadixDialog.Content className={cn("palette modal", className)} aria-label={label}>
          <RadixDialog.Title className="sr-only">{label}</RadixDialog.Title>
          {children}
          {resizable && <ResizeGrip storageKey={resizable} />}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
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

export function DialogHead({ title, aside, children }: { title: string; aside?: ReactNode; children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="dlg-head">
      <h2 className="dlg-title">{title}</h2>
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
