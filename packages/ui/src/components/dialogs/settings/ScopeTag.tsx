import { Tag } from "~/components/ui/atoms";
import { useI18n } from "~/lib/i18n";

/** Whether a section stays on this machine or follows the Hub folder — said on every card, so nobody has to guess. */
export function ScopeTag({ scope }: { scope: "machine" | "user" | undefined }) {
  const { t } = useI18n();
  if (!scope) return null;
  return (
    <Tag tone="faint" title={scope === "user" ? t("settingsDialog.scopeUser") : t("settingsDialog.scopeMachine")}>
      <span className="scope-tag" data-scope={scope}>
        {scope === "user" ? t("settingsDialog.scopeUser") : t("settingsDialog.scopeMachine")}
      </span>
    </Tag>
  );
}
