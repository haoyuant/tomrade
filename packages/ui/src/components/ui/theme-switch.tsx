import { Icon } from "~/components/icons";
import type { ReactNode } from "react";
import { useI18n } from "~/lib/i18n";
import { BUILT_IN_THEME_OPTIONS, useTheme } from "~/lib/theme";

/**
 * The switcher reports the *preference*, so System stays selectable rather
 * than collapsing into whichever theme it resolved to.
 */
export function ThemeSwitch({ compact = false, selectedEditor }: { compact?: boolean; selectedEditor?: ReactNode }) {
  const { preference, customThemes, setPreference } = useTheme();
  const { t } = useI18n();
  return (
    <div className="theme-switch" role="group" aria-label={t("theme.ariaLabel")}>
      {BUILT_IN_THEME_OPTIONS.map((opt) => {
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
      {customThemes.map(theme => <span className="theme-option" key={theme.id}>
        <button type="button" className="theme-seg" aria-pressed={preference === theme.id}
          aria-label={theme.name} title={theme.name} onClick={() => setPreference(theme.id)}>
          <Icon name={theme.icon ?? "i-sliders"} size={13} />
          {!compact && theme.name}
        </button>
        {preference === theme.id && selectedEditor}
      </span>)}
    </div>
  );
}
