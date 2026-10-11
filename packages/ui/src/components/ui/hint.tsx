import type { ReactNode } from "react";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import { useSeen } from "~/lib/onboarding";

/** A one-time line beside the thing it explains; "Got it" puts it away for good, on every machine. */
export function Hint({ id, children }: { id: string; children: ReactNode }) {
  const { t } = useI18n();
  const { seen, markSeen } = useSeen();
  if (seen(id)) return null;
  return (
    <div className="hint" role="note" data-hint={id}>
      <Icon name="i-info" size={13} />
      <span className="hint-text">{children}</span>
      <button type="button" className="btn btn-ghost hint-ok" onClick={() => markSeen(id)}>
        {t("onboarding.gotIt")}
      </button>
    </div>
  );
}
