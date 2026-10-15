import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Item, Patch } from "@tomradex/domain";
import { Dialog, DialogBody, DialogHead } from "~/components/ui/dialog";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { overriddenSubmission } from "~/lib/overridden";
import { invalidateWorkspace } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";

/** go: write the patch as asked. accepted: the delivery was accepted instead, which finished the ticket. */
export type DoneVerdict = "go" | "cancel" | "accepted";
type Guard = (item: Item, patch: Patch) => Promise<DoneVerdict>;

const GuardContext = createContext<Guard>(async () => "go");
export const useDoneGuard = (): Guard => useContext(GuardContext);

/** Finishing a ticket over a delivery nobody accepted asks first — it never refuses. */
export function DoneGuardProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [ask, setAsk] = useState<{ item: Item; submissionId: string; sentBack: boolean } | null>(null);
  const settle = useRef<((v: DoneVerdict) => void) | null>(null);

  const guard = useCallback<Guard>((item, patch) => {
    const hit = overriddenSubmission(item, patch);
    if (!hit) return Promise.resolve("go");
    return new Promise<DoneVerdict>((resolve) => {
      settle.current = resolve;
      setAsk({ item, submissionId: hit.submission.id, sentBack: hit.sentBack });
    });
  }, []);

  const close = (verdict: DoneVerdict) => {
    settle.current?.(verdict);
    settle.current = null;
    setAsk(null);
  };
  const accept = () => {
    if (!ask) return;
    invoke("items.reviewDelivery", ask.item.projectId, ask.item.id, { submissionId: ask.submissionId, decision: "accepted" }, ask.item.version).then(
      () => {
        invalidateWorkspace(qc, ask.item.projectId);
        close("accepted");
      },
      (err) => {
        toast(errorSpec(err));
        close("cancel");
      }
    );
  };

  return (
    <GuardContext.Provider value={guard}>
      {children}
      <Dialog open={!!ask} onOpenChange={(open) => !open && close("cancel")} label={t("doneGuard.title")}>
        <DialogHead title={t("doneGuard.title")} />
        <DialogBody>
          <p>{ask && t(ask.sentBack ? "doneGuard.sentBack" : "doneGuard.unreviewed", { key: ask.item.key })}</p>
          <p className="meta-txt">{t("doneGuard.note")}</p>
          <div className="row" style={{ marginTop: "var(--space-3)" }}>
            <button type="button" className="btn btn-primary" data-testid="done-guard-accept" onClick={accept}>{t("doneGuard.accept")}</button>
            <button type="button" className="btn btn-secondary" data-testid="done-guard-anyway" onClick={() => close("go")}>{t("doneGuard.anyway")}</button>
            <button type="button" className="btn btn-ghost" data-testid="done-guard-cancel" onClick={() => close("cancel")}>{t("doneGuard.cancel")}</button>
          </div>
        </DialogBody>
      </Dialog>
    </GuardContext.Provider>
  );
}
