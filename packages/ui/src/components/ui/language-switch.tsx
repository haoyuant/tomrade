import type { LanguagePreference } from "@tomradex/domain";
import { useI18n } from "~/lib/i18n";

/**
 * Each language names itself in its own script regardless of the active
 * locale — the names are literals, never routed through `t()`. Only
 * "System" follows the current language, the same as the theme switcher.
 * Eight languages and any a pack adds are too many for segments, so this is a select.
 */
export function LanguageSwitch() {
  const { preference, setPreference, languages, t } = useI18n();
  // A language whose pack has since gone stays listed while it is chosen, by its tag; it reads English.
  const options = preference === "system" || languages.some((l) => l.tag === preference) ? languages : [...languages, { tag: preference, name: preference }];
  return (
    <select
      className="select"
      style={{ width: "auto" }}
      aria-label={t("language.ariaLabel")}
      value={preference}
      onChange={(e) => setPreference(e.target.value as LanguagePreference)}
    >
      <option value="system">{t("common.system")}</option>
      {options.map((opt) => (
        <option key={opt.tag} value={opt.tag}>
          {opt.name}
        </option>
      ))}
    </select>
  );
}
