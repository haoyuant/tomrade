import { useEffect, useState } from "react";
import type { Item, OplogEntry } from "@tomradex/domain";
import { ICON_IDS, Icon, type IconId } from "~/components/icons";
import { LiveDot, Num, Spacer } from "~/components/ui/atoms";
import { Menu, MenuActionItem, MenuHead, MenuStackItem } from "~/components/ui/menu";
import { useAttention, useOpenAttention } from "~/lib/attention";
import { agoLabel, authorLabel, timeAgo } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useMcpUrl, useOplog, useProjects, useRunCommand, useStatusItems } from "~/lib/queries";
import { useErrorToast, useToast } from "~/lib/toast";
import { useOptionalAgentDock } from "./ProjectShell";
import { openSettingsPane } from "~/lib/settingsHost";

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
    <span className="status-item status-ribbon">
      {entry.by.startsWith("ai:") && !sync && <span className="ribbon-tick" />}
      <span className="status-clip">{tx("statusBar.ribbon", { author: sync ? t("statusBar.authorSync") : authorLabel(entry.by), verb: t(verbKey), key: after?.key ?? entry.entity, time: agoLabel(entry.at) })}</span>
    </span>
  );
}

/** Counts down to a plugin's `until` locally — no polling — and asks for a fresh read once it arrives. */
function useCountdown(until: number | undefined, onDue: () => void): string | null {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (until === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [until]);
  const left = until === undefined ? null : Math.max(0, Math.ceil((until - now) / 1000));
  useEffect(() => {
    if (left === 0) onDue();
  }, [left === 0]); // eslint-disable-line react-hooks/exhaustive-deps
  return left === null ? null : `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
}

/** A plugin item's words and its countdown as one run of text, so the two can never sit on different lines. */
function StatusLabel({ text, until, onDue }: { text: string; until?: number; onDue: () => void }) {
  const left = useCountdown(until, onDue);
  return <span className="status-label">{left ? `${text} ${left}` : text}</span>;
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
  const runCommand = useRunCommand(projectId);
  const dock = useOptionalAgentDock();
  const openIn = useOpenAttention();
  const toast = useToast();
  const reportError = useErrorToast();
  // An item that names a command runs it here; a conversation it opens shows in its own project, from home too.
  const run = (id: string) =>
    runCommand.mutate({ id, scope: projectId ? { projectId } : {} }, {
      onSuccess: (r) => {
        if (r.toast) toast({ body: r.toast });
        if (r.settingsPane) openSettingsPane(r.settingsPane);
        if (!r.showThread) return;
        if (dock && (!r.projectId || r.projectId === projectId)) dock.showThread(r.showThread);
        else if (r.projectId) openIn({ projectId: r.projectId, threadId: r.showThread, itemId: null });
      },
      onError: reportError
    });

  const iconOf = (icon: string | undefined): IconId | null => (icon && (ICON_IDS as readonly string[]).includes(icon) ? (icon as IconId) : null);
  const itemOf = (s: NonNullable<typeof plugins.data>[number]) => {
    const icon = iconOf(s.icon);
    const label = <StatusLabel text={s.text} until={s.until} onDue={() => void plugins.refetch()} />;
    if (s.menu)
      return (
        <Menu
          key={s.id}
          label={s.title ?? s.text}
          align={s.align === "end" ? "end" : "start"}
          trigger={
            <button type="button" className="status-item status-link" aria-label={s.title ?? s.text} disabled={runCommand.isPending}>
              {icon && <Icon name={icon} size={13} />}
              {label}
            </button>
          }
        >
          {s.title && <MenuHead title={s.title} />}
          {s.menu.map((entry) => {
            const mark = iconOf(entry.icon);
            return <MenuActionItem key={entry.command} icon={mark && <Icon name={mark} size={14} />} name={entry.title} onSelect={() => run(entry.command)} />;
          })}
        </Menu>
      );
    return (
      <button
        type="button"
        className="status-item status-link"
        key={s.id}
        title={s.title}
        aria-label={s.title ?? s.text}
        disabled={!!s.command && runCommand.isPending}
        onClick={() => (s.command ? run(s.command) : s.opens && onOpen?.(s.opens))}
      >
        {icon && <Icon name={icon} size={13} />}
        {label}
      </button>
    );
  };
  const endItems = plugins.data?.filter((s) => s.align === "end") ?? [];
  const plainItem = (s: NonNullable<typeof plugins.data>[number]) => {
    const icon = iconOf(s.icon);
    return (
      <span className="status-item" key={s.id}>
        {icon && <Icon name={icon} size={13} />}
        <StatusLabel text={s.text} until={s.until} onDue={() => void plugins.refetch()} />
      </span>
    );
  };

  return (
    <footer className="statusbar">
      <span className="status-item">
        <LiveDot /> {t("statusBar.mcpLabel")} <Num>{host(mcp.data ?? null) ?? t("statusBar.offline")}</Num>
      </span>
      <NeedsYou projectId={projectId} />
      {latest && <Ribbon entry={latest} />}
      {plugins.data?.filter((s) => s.align !== "end").map((s) => (s.command || s.menu || (s.opens && onOpen) ? itemOf(s) : plainItem(s)))}
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
          <Icon name="i-history" size={13} /> {t("statusBar.history")}
        </button>
      )}
      <Spacer />
      {endItems.map((s) => (s.command || s.menu || (s.opens && onOpen) ? itemOf(s) : plainItem(s)))}
      {children}
    </footer>
  );
}
