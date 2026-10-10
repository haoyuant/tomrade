import type { Item, OplogEntry } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { LiveDot, Num, Spacer } from "~/components/ui/atoms";
import { agoLabel } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useMcpUrl, useOplog, useStatusItems } from "~/lib/queries";

const host = (url: string | null) => (url ? url.replace(/^https?:\/\//, "").replace(/\/mcp(\/[^/]+)?$/, "") : null);

/** The most recent write, with its author — the agent collaboration at rest. */
function Ribbon({ entry }: { entry: OplogEntry }) {
  const { t, tx } = useI18n();
  const after = (entry.after ?? entry.before) as Item | null;
  const verbKey =
    entry.op === "create"
      ? "statusBar.verbCreated"
      : entry.op === "delete"
        ? "statusBar.verbDeleted"
        : entry.op === "purge"
          ? "statusBar.verbPurged"
          : entry.op === "rank"
            ? "statusBar.verbReordered"
            : entry.op === "merge"
              ? "statusBar.verbSynced"
              : "statusBar.verbUpdated";
  const sync = entry.by === "ai:sync";
  return (
    <span className="status-item">
      {entry.by.startsWith("ai:") && !sync && <span className="ribbon-tick" />}
      {tx("statusBar.ribbon", { author: <Num>{sync ? t("statusBar.authorSync") : entry.by}</Num>, verb: t(verbKey), key: after?.key ?? entry.entity, time: agoLabel(entry.at) })}
    </span>
  );
}

export function StatusBar({
  projectId,
  onUndo,
  onRedo,
  onHistory,
  busy = null,
  children
}: {
  projectId?: string;
  onUndo?: () => void;
  onRedo?: () => void;
  onHistory?: () => void;
  /** Which step is running; both controls wait for it, and the running one says so. */
  busy?: "undo" | "redo" | null;
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const mcp = useMcpUrl(projectId);
  // Per project: on the home screen nothing is "recent" across projects.
  const oplog = useOplog(projectId, 1);
  const plugins = useStatusItems(projectId);
  const latest = oplog.data?.[0];

  return (
    <footer className="statusbar">
      <span className="status-item">
        <LiveDot /> {t("statusBar.mcpLabel")} <Num>{host(mcp.data ?? null) ?? t("statusBar.offline")}</Num>
      </span>
      {latest && <Ribbon entry={latest} />}
      {plugins.data?.map((s) => (
        <span className="status-item" key={s.id}>
          {s.text}
        </span>
      ))}
      {onUndo && (
        <button type="button" className="btn btn-ghost status-undo" style={{ padding: "2px 7px", fontSize: "var(--text-xs)" }} onClick={onUndo} disabled={busy !== null} aria-busy={busy === "undo"} title={t("statusBar.undoTitle")}>
          <Icon name={busy === "undo" ? "i-sync" : "i-undo"} size={13} className={busy === "undo" ? "is-spinning" : undefined} /> {busy === "undo" ? t("workspace.undoing") : t("toast.undo")}
        </button>
      )}
      {onRedo && (
        <button type="button" className="btn btn-ghost status-redo" style={{ padding: "2px 7px", fontSize: "var(--text-xs)" }} onClick={onRedo} disabled={busy !== null} aria-busy={busy === "redo"} title={t("statusBar.redoTitle")}>
          <Icon name={busy === "redo" ? "i-sync" : "i-redo"} size={13} className={busy === "redo" ? "is-spinning" : undefined} /> {busy === "redo" ? t("workspace.redoing") : t("toast.redo")}
        </button>
      )}
      {onHistory && (
        <button type="button" className="btn btn-ghost status-history" style={{ padding: "2px 7px", fontSize: "var(--text-xs)" }} onClick={onHistory} title={t("statusBar.historyTitle")}>
          <Icon name="i-clock" size={13} /> {t("statusBar.history")}
        </button>
      )}
      <Spacer />
      {children}
    </footer>
  );
}
