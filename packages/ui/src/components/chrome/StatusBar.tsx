import type { Item, OplogEntry } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { LiveDot, Num, Spacer } from "~/components/ui/atoms";
import { Menu, MenuHead, MenuStackItem } from "~/components/ui/menu";
import { useAttention, useOpenAttention } from "~/lib/attention";
import { agoLabel, authorLabel, timeAgo } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useMcpUrl, useOplog, useProjects, useStatusItems } from "~/lib/queries";

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
      {tx("statusBar.ribbon", { author: sync ? t("statusBar.authorSync") : authorLabel(entry.by), verb: t(verbKey), key: after?.key ?? entry.entity, time: agoLabel(entry.at) })}
    </span>
  );
}

/** Everything agents wait on the person for, in every open project — longest wait first, each a way back to it. */
function NeedsYou({ projectId }: { projectId?: string }) {
  const { t } = useI18n();
  const entries = useAttention();
  const projects = useProjects();
  const open = useOpenAttention();
  if (!entries.length) return null;
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? null;
  const waited = (since: number) => {
    const span = timeAgo(since);
    return span === "now" || span === "刚刚" ? null : t("statusBar.waitedFor", { time: span });
  };
  return (
    <Menu
      label={t("statusBar.needsYouTitle")}
      wide
      trigger={
        <button type="button" className="status-item status-link status-needs" data-testid="needs-you">
          <span className="needs-dot" aria-hidden /> {t("statusBar.needsYou", { n: entries.length })}
        </button>
      }
    >
      <MenuHead title={t("statusBar.needsYouTitle")} />
      {[...entries]
        .sort((a, b) => a.since - b.since)
        .map((e) => (
          <MenuStackItem
            key={e.key}
            name={[e.itemKey, e.who ?? t("agentPanel.assistantLabel"), t(`agentPanel.attention_${e.kind}` as MessageKey)].filter(Boolean).join(" · ")}
            sub={[e.projectId !== projectId ? projectName(e.projectId) : null, e.text, waited(e.since)].filter(Boolean).join(" · ")}
            onSelect={() => open(e)}
          />
        ))}
    </Menu>
  );
}

export function StatusBar({
  projectId,
  onUndo,
  onRedo,
  onHistory,
  busy = null,
  onOpen,
  children
}: {
  projectId?: string;
  onUndo?: () => void;
  onRedo?: () => void;
  onHistory?: () => void;
  /** Which step is running; both controls wait for it, and the running one says so. */
  busy?: "undo" | "redo" | null;
  /** Opens a surface a plugin's status item names ("code-inbox"); without it the items read as plain text. */
  onOpen?: (surface: string) => void;
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
      <NeedsYou projectId={projectId} />
      {latest && <Ribbon entry={latest} />}
      {plugins.data?.map((s) =>
        s.opens && onOpen ? (
          <button type="button" className="status-item status-link" key={s.id} onClick={() => onOpen(s.opens!)}>
            {s.text}
          </button>
        ) : (
          <span className="status-item" key={s.id}>
            {s.text}
          </span>
        )
      )}
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
