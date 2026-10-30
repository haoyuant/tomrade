import { SectionHead } from "~/components/ui/atoms";
import { useAppIconStatus, useSetAppIcon, type AppIcon } from "~/lib/app-icon";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { ScopeTag } from "./ScopeTag";

const CHOICES: { icon: AppIcon; label: MessageKey; note: MessageKey; image: string }[] = [
  {
    icon: "transparent",
    label: "settingsDialog.appIconLogo",
    note: "settingsDialog.appIconLogoNote",
    image: `${import.meta.env.BASE_URL}logo.png`
  },
  {
    icon: "sun",
    label: "settingsDialog.appIconSun",
    note: "settingsDialog.appIconSunNote",
    image: `${import.meta.env.BASE_URL}app-icon.png`
  }
];

/** The icon the Dock wears; only where a desktop shell can draw it. */
export function AppIconSection() {
  const { t } = useI18n();
  const status = useAppIconStatus();
  const set = useSetAppIcon();
  const current = status.data;
  if (!current || current.platform !== "darwin") return null;

  return (
    <>
      <SectionHead title={t("settingsDialog.appIconTitle")} aside={<ScopeTag scope="machine" />}>
        {t("settingsDialog.appIconLede")}
      </SectionHead>
      <div className="app-icon-grid" role="radiogroup" aria-label={t("settingsDialog.appIconTitle")}>
        {CHOICES.map((choice) => (
          <button
            key={choice.icon}
            type="button"
            role="radio"
            aria-checked={current.icon === choice.icon}
            className="app-icon-choice"
            data-icon={choice.icon}
            disabled={set.isPending}
            onClick={() => set.mutate(choice.icon)}
          >
            <span className="app-icon-frame">
              <img src={choice.image} alt="" draggable={false} />
            </span>
            <span className="app-icon-name">{t(choice.label)}</span>
            <span className="app-icon-note">{t(choice.note)}</span>
          </button>
        ))}
      </div>
      <hr className="rule" />
    </>
  );
}
