import { useEffect, useRef, type ReactNode } from "react";
import { isCancelKey } from "~/lib/keys";
import { cn } from "~/lib/utils";

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * A floating surface that holds inputs. Radix's dropdown menu owns typeahead
 * on every character key, which fights a text field, so anything typed into
 * lives here instead: the design's own `.menu` box, closed by an outside
 * pointer or Escape (captured, so the workspace's Escape stack never sees it).
 */
export function Popover({
  open,
  onOpenChange,
  trigger,
  label,
  align = "start",
  className,
  children
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  label: string;
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  // Focus goes into the surface when it opens and back to what opened it when
  // it closes — unless the person has already moved on to something else.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const wrap = ref.current;
    requestAnimationFrame(() => {
      const box = surface.current;
      if (box && !box.contains(document.activeElement)) box.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || wrap?.contains(active)) opener?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!isCancelKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      onOpenChange(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onOpenChange]);

  return (
    <div className="menu-wrap" ref={ref}>
      {trigger}
      {open && (
        <div ref={surface} className={cn("menu pop", align === "end" && "right", className)} role="dialog" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}
