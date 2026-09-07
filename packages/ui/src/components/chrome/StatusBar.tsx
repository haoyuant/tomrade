import type { Item, OplogEntry } from "@tomrade/domain";
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

export function StatusBar({ projectId, onUndo, children }: { projectId?: string; onUndo?: () => void; children?: React.ReactNode }) {
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
        <button type="button" className="btn btn-ghost" style={{ padding: "2px 7px", fontSize: "var(--text-xs)" }} onClick={onUndo} title={t("statusBar.undoTitle")}>
          <Icon name="i-undo" size={13} /> {t("toast.undo")}
        </button>
      )}
      <Spacer />
      {children}
    </footer>
  );
}
