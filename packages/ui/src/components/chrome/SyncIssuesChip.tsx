import { useEffect } from "react";
import { useSyncAttention } from "~/lib/queries";
import { useI18n } from "~/lib/i18n";

/** What this window already opened the dialog for, so a refetch of the same list never reopens it. */
const announced = new Set<string>();

/**
 * The status bar's note that a sync left delivery records to settle. It opens
 * the dialog by itself the first time a given conflict shows up, then stays
 * as a quiet item until it is settled.
 */
export function SyncIssuesChip({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const { t } = useI18n();
  const rows = useSyncAttention(projectId).data ?? [];
  const fresh = rows.some((r) => !announced.has(`${projectId}:${r.itemId}:${r.code}`));
  // only when something new turns up, not on every refetch or render
  useEffect(() => {
    if (!fresh) return;
    for (const r of rows) announced.add(`${projectId}:${r.itemId}:${r.code}`);
    onOpen();
  }, [fresh]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows.length) return null;
  return (
    <button type="button" className="status-item status-link status-needs" data-testid="sync-issues-chip" title={t("syncIssues.chipTitle")} onClick={onOpen}>
      <span className="needs-dot" aria-hidden /> {t("syncIssues.chip", { n: rows.length })}
    </button>
  );
}
