import { useEffect, useState } from "react";
import type { AnalyticsState } from "@tomradex/analytics";
import { invoke, logQuietly } from "~/lib/api";
import { agoLabel } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useToast } from "~/lib/toast";

/**
 * The identifier under the usage switch: what the cloud sees, so a person can
 * ask for its data to be deleted, and the button that starts over.
 */
export function AnalyticsIdentity() {
  const { t, tx } = useI18n();
  const toast = useToast();
  const [state, setState] = useState<AnalyticsState | null>(null);

  useEffect(() => {
    let live = true;
    void invoke("analytics.state")
      .then((next) => live && setState(next))
      .catch(logQuietly("analytics.state"));
    return () => {
      live = false;
    };
  }, []);

  if (!state) return null;
  if (!state.enabled) return <p className="hint">{t("analytics.off")}</p>;

  const reset = () => {
    void invoke("analytics.resetId")
      .then((next) => {
        setState(next);
        toast({ body: t("analytics.resetNote") });
      })
      .catch((error) => toast({ body: String(error) }));
  };

  return (
    <div className="stack-2" style={{ marginTop: "var(--space-3)" }}>
      <span className="eyebrow">{t("analytics.identifier")}</span>
      <code className="mono" style={{ userSelect: "all" }}>{state.anonId}</code>
      <p className="hint">{t("analytics.identifierNote")}</p>
      <p className="hint">
        {state.queued ? tx("analytics.queued", { n: state.queued }) : state.lastSentAt ? tx("analytics.sent", { when: agoLabel(state.lastSentAt) }) : t("analytics.neverSent")}
      </p>
      <button type="button" className="btn btn-secondary" onClick={reset}>{t("analytics.reset")}</button>
    </div>
  );
}
