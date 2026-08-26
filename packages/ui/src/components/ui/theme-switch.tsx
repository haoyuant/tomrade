import { Icon } from "~/components/icons";
import { THEME_OPTIONS, useTheme } from "~/lib/theme";

/**
 * The switcher reports the *preference*, so System stays selectable rather
 * than collapsing into whichever theme it resolved to.
 */
export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const { preference, setPreference } = useTheme();
  return (
    <div className="theme-switch" role="group" aria-label="Theme preference">
      {THEME_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className="theme-seg"
          aria-pressed={preference === opt.value}
          aria-label={opt.label}
          title={opt.label}
          onClick={() => setPreference(opt.value)}
        >
          <Icon name={opt.icon} size={13} />
          {!compact && opt.label}
        </button>
      ))}
    </div>
  );
}
