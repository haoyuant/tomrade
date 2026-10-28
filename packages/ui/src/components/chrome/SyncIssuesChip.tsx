import { useState } from "react";
import { useSyncAttention } from "~/lib/queries";
import { useI18n } from "~/lib/i18n";

/** The conflicts this window has shown the person, so only a new one lights the chip up again. */
const seen = new Set<string>();

/**
 * The status bar's note that a sync left delivery records to settle. A conflict it has not shown yet makes it
 * light up; it never opens the dialog by itself, which would take the keyboard from whatever the person types.
 */
export function SyncIssuesChip({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const { t } = useI18n();
  const rows = useSyncAttention(projectId).data ?? [];
  const [, look] = useState(0);
  const fresh = rows.some((r) => !seen.has(`${projectId}:${r.itemId}:${r.code}`));
  if (!rows.length) return null;
  const open = () => {
    for (const r of rows) seen.add(`${projectId}:${r.itemId}:${r.code}`);
    look((n) => n + 1);
    onOpen();
  };
  return (
    <button type="button" className="status-item status-link status-needs" data-testid="sync-issues-chip" data-fresh={fresh || undefined} title={t("syncIssues.chipTitle")} onClick={open}>
      <span className="needs-dot" aria-hidden /> {t("syncIssues.chip", { n: rows.length })}
    </button>
  );
}
