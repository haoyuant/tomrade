import { useState } from "react";
import type { EnginePick } from "@tomradex/agent";
import { pickChoiceName } from "~/lib/engines";
import { useI18n } from "~/lib/i18n";

/** The select's own entry for a value typed by hand. */
const CUSTOM = "\u0000custom";

/**
 * One engine quick-pick knob (model, effort, edition), drawn as a select so it
 * looks and scrolls the same everywhere. A native `<input list>` datalist was
 * tried before: its popup follows the OS, flips upward and does not scroll a
 * long model list, and it filters the suggestions to those matching the
 * current text, which hid the other presets once one was chosen. A free-text
 * pick instead gets a "Custom…" entry that reveals a plain text input, keeping
 * every preset reachable while any value the CLI knows still works.
 */
export function PickSelect({ id, pick, value, onChange, defaultLabel, disabled, placeholder, className = "select" }: {
  id: string;
  pick: EnginePick;
  /** "" is the default: no choice of ours. */
  value: string;
  onChange: (value: string) => void;
  /** What the first entry reads: what "default" means for this knob here. */
  defaultLabel: string;
  disabled?: boolean;
  /** Shown in the custom input while it is empty. */
  placeholder?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const isPreset = (v: string) => v === "" || pick.choices.some((c) => c.value === v);
  // Chosen "Custom…" but typed nothing yet: the input stays, even though "" is a preset.
  const [customChosen, setCustomChosen] = useState(false);
  const custom = pick.freeText && (customChosen || !isPreset(value));
  const onSelect = (v: string) => {
    if (v === CUSTOM) {
      setCustomChosen(true);
      return;
    }
    setCustomChosen(false);
    onChange(v);
  };
  return (
    <>
      <select id={id} className={className} value={custom ? CUSTOM : value} disabled={disabled} onChange={(e) => onSelect(e.target.value)}>
        <option value="">{defaultLabel}</option>
        {pick.choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.searchesWeb ? t("settingsDialog.pickSearchesWeb", { label: pickChoiceName(t, pick, c) }) : pickChoiceName(t, pick, c)}
          </option>
        ))}
        {pick.freeText && <option value={CUSTOM}>{t("settingsDialog.pickCustomOption")}</option>}
        {!pick.freeText && value && !isPreset(value) && <option value={value}>{value}</option>}
      </select>
      {custom && <input id={`${id}-custom`} className="input num" value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />}
    </>
  );
}
