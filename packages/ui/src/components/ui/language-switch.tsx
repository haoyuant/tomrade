import type { LanguagePreference } from "@tomradex/domain";
import { LANGUAGE_OPTIONS, useI18n } from "~/lib/i18n";

/**
 * Each language names itself in its own script regardless of the active
 * locale — the names are literals, never routed through `t()`. Only
 * "System" follows the current language, the same as the theme switcher.
 * Seven languages are too many for segments, so this is a select.
 */
export function LanguageSwitch() {
  const { preference, setPreference, t } = useI18n();
  return (
    <select
      className="select"
      style={{ width: "auto" }}
      aria-label={t("language.ariaLabel")}
      value={preference}
      onChange={(e) => setPreference(e.target.value as LanguagePreference)}
    >
      {LANGUAGE_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.literal ?? t(opt.labelKey!)}
        </option>
      ))}
    </select>
  );
}
