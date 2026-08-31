import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import { THEME_OPTIONS, useTheme } from "~/lib/theme";

/**
 * The switcher reports the *preference*, so System stays selectable rather
 * than collapsing into whichever theme it resolved to.
 */
export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const { preference, setPreference } = useTheme();
  const { t } = useI18n();
  return (
    <div className="theme-switch" role="group" aria-label={t("theme.ariaLabel")}>
      {THEME_OPTIONS.map((opt) => {
        const label = t(opt.labelKey);
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
            <Icon name={opt.icon} size={13} />
            {!compact && label}
          </button>
        );
      })}
    </div>
  );
}
