import { useState } from "react";
import { Icon, type IconId } from "~/components/icons";
import { Menu, MenuHead, MenuRadioItem } from "~/components/ui/menu";
import { BOARD_GLYPHS } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { cn } from "~/lib/utils";

/**
 * A glyph chooser that shows the glyphs. A native <select> can only print
 * their names, so this is a menu of icon + name rows behind a trigger that
 * wears the current one.
 */
export function IconPicker({
  value,
  onChange,
  ariaLabel,
  id,
  compact,
  options = BOARD_GLYPHS
}: {
  value: IconId;
  onChange: (next: IconId) => void;
  ariaLabel: string;
  id?: string;
  /** Icon only on the trigger; the menu still names every glyph. */
  compact?: boolean;
  options?: readonly (readonly [IconId, string])[];
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const current = options.find(([icon]) => icon === value);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label={ariaLabel}
      trigger={
        <button type="button" id={id} className={cn("icon-pick", compact && "compact")} aria-label={ariaLabel} title={current?.[1] ?? value}>
          <Icon className="ico" name={value} size={14} />
          {!compact && <span className="icon-pick-name">{current?.[1] ?? value}</span>}
          <Icon className="chev" name="i-chevdown" size={11} />
        </button>
      }
    >
      <MenuHead title={t("common.iconMenuTitle")} />
      {options.map(([icon, label]) => (
        <MenuRadioItem key={icon} checked={icon === value} mark={<Icon name={icon} size={14} />} name={label} onSelect={() => onChange(icon)} />
      ))}
    </Menu>
  );
}
