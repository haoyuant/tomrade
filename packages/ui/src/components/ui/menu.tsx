import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { Icon } from "~/components/icons";
import { cn } from "~/lib/utils";

/** Radix positions the wrapper; `.is-floating` stops the design CSS doing it too. */
export function Menu({
  trigger,
  label,
  open,
  onOpenChange,
  align = "start",
  wide,
  modal = false,
  children
}: {
  trigger: ReactNode;
  label: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "end";
  wide?: boolean;
  /** Inside a modal sheet the sheet's scroll lock swallows the wheel over a portaled menu; a modal menu brings its own. */
  modal?: boolean;
  children: ReactNode;
}) {
  return (
    <RadixMenu.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content className={cn("menu is-floating", wide && "wide")} align={align} sideOffset={6} aria-label={label}>
          {children}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

export const MenuHead = ({ title, aside }: { title: string; aside?: ReactNode }) => (
  <div className="menu-head">
    <p className="eyebrow" style={{ flex: 1 }}>
      {title}
    </p>
    {aside && <span className="meta-txt">{aside}</span>}
  </div>
);

export const MenuFoot = ({ children }: { children: ReactNode }) => <div className="menu-foot">{children}</div>;

export const MenuEmpty = ({ children }: { children: ReactNode }) => <p className="menu-empty">{children}</p>;

const Check = () => (
  <span className="chk">
    <Icon name="i-check" size={10} />
  </span>
);

/** Multi-select is the point, so a checkbox row never closes the menu. */
export function MenuCheckItem({
  checked,
  onToggle,
  mark,
  name,
  count
}: {
  checked: boolean;
  onToggle: () => void;
  mark?: ReactNode;
  name: string;
  count?: number;
}) {
  return (
    <RadixMenu.CheckboxItem
      className="menu-row"
      checked={checked}
      onSelect={(e) => e.preventDefault()}
      onCheckedChange={onToggle}
    >
      <Check />
      <span className="m-mark">{mark}</span>
      <span className="m-name">{name}</span>
      {count !== undefined && <span className="m-count">{count}</span>}
    </RadixMenu.CheckboxItem>
  );
}

export function MenuRadioItem({
  checked,
  onSelect,
  mark,
  name,
  sub,
  count
}: {
  checked: boolean;
  onSelect: () => void;
  mark?: ReactNode;
  name: string;
  sub?: string;
  count?: number;
}) {
  return (
    <RadixMenu.Item className="menu-row is-radio" role="menuitemradio" aria-checked={checked} onSelect={onSelect}>
      <Check />
      {mark && <span className="m-mark">{mark}</span>}
      {sub ? (
        <span className="m-stack">
          <span className="m-name">{name}</span>
          <span className="m-sub">{sub}</span>
        </span>
      ) : (
        <span className="m-name">{name}</span>
      )}
      {count !== undefined && <span className="m-count">{count}</span>}
    </RadixMenu.Item>
  );
}

/** A footer row that opens something *over* this screen: no arrow, because
 *  nothing is being left behind. */
export function MenuActionItem({ icon, name, onSelect, keepOpen }: { icon: ReactNode; name: string; onSelect: () => void; /** For a row that opens a second stage inside the same menu. */ keepOpen?: boolean }) {
  return (
    <RadixMenu.Item
      className="menu-row m-link"
      onSelect={(e) => {
        if (keepOpen) e.preventDefault();
        onSelect();
      }}
    >
      <span className="m-mark">{icon}</span>
      <span className="m-name">{name}</span>
    </RadixMenu.Item>
  );
}

/** A row that leaves this screen rather than changing it — the arrow says so. */
export function MenuLinkItem({ icon, name, onSelect }: { icon: ReactNode; name: string; onSelect: () => void }) {
  return (
    <RadixMenu.Item className="menu-row m-link" onSelect={onSelect}>
      <span className="m-mark">{icon}</span>
      <span className="m-name">{name}</span>
      <span className="m-go">→</span>
    </RadixMenu.Item>
  );
}
