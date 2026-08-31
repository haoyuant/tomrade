import { LANGUAGE_OPTIONS, useI18n } from "~/lib/i18n";

/**
 * Each language names itself in its own script regardless of the active
 * locale — English and 中文 are literals, never routed through `t()`. Only
 * "System" follows the current language, the same as the theme switcher.
 * There is no icon to fall back on, so unlike `ThemeSwitch` this has no
 * compact mode — the label is always shown.
 */
export function LanguageSwitch() {
  const { preference, setPreference, t } = useI18n();
  return (
    <div className="theme-switch" role="group" aria-label={t("language.ariaLabel")}>
      {LANGUAGE_OPTIONS.map((opt) => {
        const label = opt.literal ?? t(opt.labelKey!);
        return (
          <button
            key={opt.value}
            type="button"
            className="theme-seg"
            aria-pressed={preference === opt.value}
            aria-label={label}
            title={label}
            onClick={() => setPreference(opt.value)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
