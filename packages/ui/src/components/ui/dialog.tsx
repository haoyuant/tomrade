import * as RadixDialog from "@radix-ui/react-dialog";
import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "~/components/icons";
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
  children
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  className?: string;
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
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function DialogHead({ title, aside, children }: { title: string; aside?: ReactNode; children?: ReactNode }) {
  return (
    <div className="dlg-head">
      <h2 className="dlg-title">{title}</h2>
      {aside}
      <div className="spacer" />
      {children}
      <RadixDialog.Close asChild>
        <button type="button" className="btn btn-icon" aria-label={`Close ${title.toLowerCase()}`}>
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
