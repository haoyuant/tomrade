import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AttentionView } from "@tomradex/storage";
import { Dialog, DialogBody, DialogHead } from "~/components/ui/dialog";
import { invoke } from "~/lib/api";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { invalidateWorkspace, keys, useAllItems, useStorageStatus, useSyncAttention } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";

// Notes are read back from the project's folder, which a newer Tomrade may have written: an unknown code shows as itself.
const CODE_KEY: Record<AttentionView["code"], MessageKey> = {
  "done-unaccepted": "syncIssues.code_done-unaccepted",
  "orphan-review": "syncIssues.code_orphan-review",
  "duplicate-review": "syncIssues.code_duplicate-review",
  "orphan-artifact": "syncIssues.code_orphan-artifact",
  "delivery-state": "syncIssues.code_delivery-state"
};

/**
 * What a sync merged but left disagreeing with itself, one row per ticket with
 * the actions that settle it. Syncing never waits on any of this.
 */
export function SyncIssuesDialog({ projectId, open, onOpenChange, onOpenIssue }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void; onOpenIssue: (id: string) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const attention = useSyncAttention(projectId);
  // A ticket with a sync issue may be an old done one.
  const items = useAllItems(projectId, open);
  const status = useStorageStatus(projectId);
  const byId = new Map((items.data ?? []).map((i) => [i.id, i]));
  const rows = attention.data ?? [];
  const settled = () => {
    invalidateWorkspace(qc, projectId);
    void qc.invalidateQueries({ queryKey: keys.storageStatus(projectId) });
  };
  const settle = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "accept" | "tidy" | "reopen" }) => {
      const item = byId.get(id);
      if (!item) throw new Error(t("syncIssues.ticketNotFound"));
      return action === "reopen" ? invoke("items.update", projectId, id, { status: "doing" }, item.version) : invoke("items.settleEvidence", projectId, id, action, item.version);
    },
    onSuccess: settled,
    onError: (e) => toast(errorSpec(e))
  });
  const sync = useMutation({ mutationFn: () => invoke("storage.sync", projectId), onSettled: settled, onError: (e) => toast(errorSpec(e)) });
  // The tickets load when the dialog opens; until then a row's actions have nothing to act on.
  const ready = !!items.data;
  const act = (id: string, action: "accept" | "tidy" | "reopen") => settle.mutate({ id, action });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("syncIssues.title")}>
      <DialogHead title={t("syncIssues.title")} />
      <DialogBody>
        <p className="meta-txt">{t("syncIssues.lede")}</p>
        {rows.length === 0 && <p className="meta-txt">{t("syncIssues.allSettled")}</p>}
        <div className="inbox-list">
          {rows.map((r) => (
            <div className="inbox-row" key={`${r.itemId}:${r.code}`} data-testid="sync-issue">
              <div className="inbox-main">
                <button type="button" className="link-btn num" onClick={() => { onOpenIssue(r.itemId); onOpenChange(false); }}>{r.key}</button>
                <span className="inbox-title">{r.title}</span>
                <span className="meta-txt">{r.code in CODE_KEY ? t(CODE_KEY[r.code]) : r.code}</span>
              </div>
              <div className="inbox-actions">
                {r.code === "done-unaccepted" ? (
                  <>
                    <button type="button" className="btn btn-primary" disabled={!ready || settle.isPending} onClick={() => act(r.itemId, "accept")}>{t("syncIssues.accept")}</button>
                    <button type="button" className="btn btn-secondary" disabled={!ready || settle.isPending} onClick={() => act(r.itemId, "reopen")}>{t("syncIssues.reopen")}</button>
                  </>
                ) : r.code === "delivery-state" ? null : (
                  <button type="button" className="btn btn-primary" disabled={!ready || settle.isPending} onClick={() => act(r.itemId, "tidy")}>{t("syncIssues.tidy")}</button>
                )}
              </div>
            </div>
          ))}
        </div>
        {status.data?.detail && <p className="meta-txt" style={{ marginTop: "var(--space-4)" }}>{t("syncIssues.syncStatus", { detail: status.data.detail })}</p>}
        <div className="row" style={{ marginTop: "var(--space-3)" }}>
          <button type="button" className="btn btn-ghost" disabled={sync.isPending} onClick={() => sync.mutate()}>{sync.isPending ? t("syncIssues.syncing") : t("syncIssues.syncNow")}</button>
          <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>{t("syncIssues.close")}</button>
        </div>
      </DialogBody>
    </Dialog>
  );
}
