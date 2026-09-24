import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Icon } from "~/components/icons";
import { SectionHead } from "~/components/ui/atoms";
import { useI18n } from "~/lib/i18n";
import { useRevoked, useStoreUpdate, useUpdates } from "~/lib/plugins";
import { useToast } from "~/lib/toast";
import { TrustTags, messageOf } from "./parts";

export function UpdatesTab() {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const updates = useUpdates();
  const revoked = useRevoked();
  const update = useStoreUpdate();
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  return (
    <>
      <SectionHead
        title={t("plugins.tabUpdates")}
        aside={
          <button type="button" className="btn btn-ghost" onClick={() => void qc.invalidateQueries({ queryKey: ["community"] })}>
            <Icon name="i-sync" size={13} /> {t("plugins.checkNow")}
          </button>
        }
      >
        {t("plugins.updatesLede")}
      </SectionHead>
      {updates.error && <p className="meta-txt" style={{ color: "var(--danger)" }}>{t("plugins.storeUnavailable", { message: messageOf(updates.error) })}</p>}
      {updates.data && !updates.data.length && <p className="meta-txt">{t("plugins.upToDate")}</p>}
      <div className="stack-2" data-testid="updates">
        {updates.data?.map((plan) => (
          <div key={plan.id} className="cfg-row" data-id={plan.id}>
            <Icon name="i-sync" size={15} style={{ color: "var(--accent)" }} />
            <div className="cfg-name">
              <span className="mono">{plan.id}</span> <span className="meta-txt mono">{plan.from} → {plan.to.version}</span>
              <div className="row plug-tags" style={{ gap: 6, marginTop: 3 }}>
                <TrustTags tier={plan.to.tier} risk={plan.to.risk} reviewedAs={plan.to.reviewed_as} />
              </div>
              {!plan.automatic && <div className="meta-txt dense">{t("plugins.updateReasons", { reasons: plan.reasons.join("; ") })}</div>}
              {!!plan.expands.length && <div className="meta-txt dense" style={{ color: "var(--danger)" }}>{t("plugins.updateWider", { list: plan.expands.join(", ") })}</div>}
              {error?.id === plan.id && <div className="meta-txt dense" style={{ color: "var(--danger)" }}>{error.message}</div>}
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={update.isPending}
              onClick={() =>
                update.mutate(plan.id, {
                  onSuccess: () => toast({ body: t("plugins.updated", { title: plan.id, version: plan.to.version }) }),
                  onError: (e) => setError({ id: plan.id, message: messageOf(e) })
                })
              }
            >
              {t("plugins.update")}
            </button>
          </div>
        ))}
      </div>
      {!!revoked.data?.length && (
        <>
          <hr className="rule" />
          <SectionHead title={t("plugins.revokedTitle")} />
          <ul className="dash">
            {revoked.data.map((r) => (
              <li key={r.id} style={{ color: "var(--danger)" }}>
                {t("plugins.revokedLine", { id: r.id, reason: r.reason })}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
