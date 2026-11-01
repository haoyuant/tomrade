import { useState } from "react";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import { useItems } from "~/lib/queries";
import { useTakeoverOffer } from "~/lib/takeover";

/** An empty backlog may sit over a repository full of unfinished work: the first thing it offers is to read it. */
export function TakeoverBanner({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const { t } = useI18n();
  const items = useItems(projectId);
  const empty = items.data?.length === 0;
  const offer = useTakeoverOffer(projectId, empty);
  const [dismissed, setDismissed] = useState(false);
  if (!empty || !offer.data || dismissed) return null;
  return (
    <div className="banner" role="status" data-testid="takeover-banner">
      <Icon className="b-mark" name="i-branch" size={15} />
      <span>{t("takeover.bannerText")}</span>
      <button type="button" className="btn btn-secondary" style={{ marginLeft: "auto", padding: "3px 8px", flexShrink: 0 }} data-testid="takeover-open" onClick={onOpen}>
        {t("takeover.bannerAction")}
      </button>
      <button type="button" className="btn btn-ghost" style={{ padding: "3px 8px", flexShrink: 0 }} onClick={() => setDismissed(true)}>
        {t("workspace.dismiss")}
      </button>
    </div>
  );
}
