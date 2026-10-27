import { useDeferredValue, useMemo, type MutableRefObject } from "react";
import { Command } from "cmdk";
import { useQuery } from "@tanstack/react-query";
import type { EngineView, ThreadSummary } from "@tomradex/agent";
import type { ReviewRow, SessionView } from "@tomradex/code-link";
import type { Item } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { Kbd } from "~/components/ui/atoms";
import { StatusMark } from "~/components/workspace/agent-panel/SessionBar";
import { invoke } from "~/lib/api";
import { ATTENTION_KEY, type AttentionEntry } from "~/lib/attention";
import { findEngine } from "~/lib/agent";
import { useI18n } from "~/lib/i18n";
import { keyLabel } from "~/lib/keybindings";
import { askPanel, usePanelSession } from "~/lib/panelRequests";
import { keys } from "~/lib/queries";
import { outcomeLine } from "~/lib/review";
import { paletteSessionGroups, sessionBarRows, type BarRow } from "~/lib/sessionBar";
import { useOpenTerminalWindow } from "~/lib/terminalWindow";
import { errorSpec, useToast } from "~/lib/toast";
import { useOptionalAgentDock } from "~/components/chrome/ProjectShell";

/**
 * What the window already holds, read without asking for it again: opening ⌘K costs the main process nothing. A session
 * list the panel never fetched (it was never opened) is simply not here; the threads and what waits always are.
 */
function useHeld<T>(queryKey: readonly unknown[], queryFn: () => Promise<T>): T | undefined {
  return useQuery({ queryKey, queryFn, enabled: false }).data;
}

/**
 * ⌘K's sessions and the things to do with them: waiting on you, in progress, ended. ↵ opens one here; ⇧↵ in a
 * Terminal window cell, where a terminal session has one.
 */
export function PaletteSessions({ projectId, items, search, run, shift }: {
  projectId: string;
  items: Item[];
  /** What is typed in the palette: past two characters, the look back is searched for older ended sessions too. */
  search: string;
  /** Closes the palette and runs the choice. */
  run: (fn: () => void) => void;
  /** Whether the choice was made with ⇧↵. */
  shift: MutableRefObject<boolean>;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const dock = useOptionalAgentDock();
  const openTerminal = useOpenTerminalWindow(projectId);
  const panelSession = usePanelSession(projectId);
  const threads = useHeld<ThreadSummary[]>(keys.agent.threads(projectId), () => invoke("agent.threads", projectId));
  const sessions = useHeld<SessionView[]>(keys.codeLink.recentSessions(projectId), () => invoke("codeLink.recentSessions", projectId));
  const attention = useHeld<AttentionEntry[]>(keys.attention, () => invoke("attention.list").catch(() => []));
  const engines = useHeld<EngineView[]>(keys.agent.engines, () => invoke("agent.engines"));
  const groups = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    const rows = sessionBarRows({
      threads: threads ?? [], sessions: sessions ?? [], attention: (attention ?? []).filter((e) => e.projectId === projectId), openThreadId: null, idleLimit: 50,
      itemTitle: (id) => byId.get(id)?.title ?? null, itemKey: (id) => byId.get(id)?.key ?? null
    });
    return paletteSessionGroups(rows);
  }, [threads, sessions, attention, items, projectId]);

  const openPanel = () => dock?.setAiOpen(true);
  const here = (r: BarRow) => {
    // What ended is looked back on: the conversation read-only, by ticket, with what came of it on top.
    if (r.status === "done" && r.sessionId) {
      openPanel();
      return askPanel({ kind: "review", sessionId: r.sessionId });
    }
    if (r.threadId) return dock?.showThread(r.threadId);
    if (!r.sessionId) return;
    openPanel();
    askPanel({ kind: "openSession", sessionId: r.sessionId });
  };
  // Typed, ⌘K reaches past the few ended sessions the window holds: the look back's search, a moment after the typing stops.
  const typed = useDeferredValue(search.trim());
  const found = useQuery({
    queryKey: keys.codeLink.review(projectId, typed),
    queryFn: () => invoke("codeLink.reviewList", projectId, { query: typed, limit: 8 }),
    enabled: typed.length >= 2,
    staleTime: 30_000
  });
  const known = new Set([...groups.waiting, ...groups.active, ...groups.history].map((r) => r.sessionId ?? r.threadId));
  const older = (found.data?.rows ?? []).filter((r) => !known.has(r.id));
  const outcomeOf = (r: ReviewRow) => outcomeLine(r, (key, vars) => t(`review.${key}`, vars));
  const olderRow = (r: ReviewRow) => (
    <Command.Item key={`review:${r.id}`} value={`${r.tickets[0]?.key ?? ""} ${r.title} ${findEngine(engines, r.agent)?.title ?? r.agent} ${outcomeOf(r) ?? ""} review:${r.id}`} className="palette-row" data-session={`review:${r.id}`} onSelect={() => run(() => { openPanel(); askPanel(r.kind === "thread" ? { kind: "review", threadId: r.id } : { kind: "review", sessionId: r.id }); })}>
      <span className="palette-mark"><StatusMark status="done" size={12} /></span>
      <span className="p-label">
        {r.tickets[0]?.key ?? r.title}
        {r.tickets[0] && r.title && <span className="meta-txt"> · {r.title}</span>}
        {outcomeOf(r) && <span className="meta-txt palette-said"> · {outcomeOf(r)}</span>}
      </span>
      <span className="card-id">{findEngine(engines, r.agent)?.title ?? r.agent}</span>
    </Command.Item>
  );
  // A terminal session's cell; anything else has none, and opens here instead.
  const inCell = (r: BarRow) => {
    if (!r.sessionId) return here(r);
    void invoke("codeLink.showSession", projectId, r.sessionId).then((shown) => {
      if (shown) return;
      toast({ body: r.terminalApp ? t("sessionBar.elsewhere", { app: r.terminalApp.replace(/\.app$/, "") }) : t("sessionBar.notShown") });
      here(r);
    }, (error) => toast(errorSpec(error)));
  };
  const pick = (r: BarRow) => run(() => (shift.current ? inCell(r) : here(r)));

  const name = (r: BarRow) => r.ticket ?? (r.title || t("agentPanel.newThread"));
  const said = (r: BarRow) => (r.wait ? r.wait.text || t(ATTENTION_KEY[r.wait.kind]) : r.status === "done" ? r.outcome : r.activity);
  const agentName = (r: BarRow) => (r.agent ? (findEngine(engines, r.agent)?.title ?? r.agent) : null);
  const row = (r: BarRow) => (
    <Command.Item key={r.key} value={`${name(r)} ${r.title} ${agentName(r) ?? ""} ${said(r) ?? ""} ${r.key}`} className="palette-row" data-session={r.key} onSelect={() => pick(r)}>
      <span className="palette-mark"><StatusMark status={r.status} size={12} /></span>
      <span className="p-label">
        {name(r)}
        {r.ticket && r.title && <span className="meta-txt"> · {r.title}</span>}
        {said(r) && <span className="meta-txt palette-said"> · {said(r)}</span>}
      </span>
      <span className="card-id">{agentName(r)}</span>
    </Command.Item>
  );

  const doRows = [
    { id: "new", label: t("commandPalette.startSession"), kb: undefined, run: () => { openPanel(); askPanel({ kind: "newThread" }); } },
    ...(openTerminal ? [{ id: "terminal", label: t("commandPalette.openTerminalWindow"), kb: keyLabel("terminalWindow"), run: openTerminal }] : []),
    ...(panelSession ? [{ id: "to-cell", label: t("commandPalette.sessionToCell"), kb: undefined, run: () => { const r = [...groups.waiting, ...groups.active, ...groups.history].find((x) => x.sessionId === panelSession); if (r) inCell(r); } }] : []),
    { id: "bar", label: t("commandPalette.toggleSessionBar"), kb: keyLabel("sessionBar"), run: () => { openPanel(); askPanel({ kind: "toggleBar" }); } },
    ...(groups.waiting.length ? [{ id: "next", label: t("commandPalette.nextWaiting"), kb: keyLabel("nextWaiting"), run: () => { openPanel(); askPanel({ kind: "nextWaiting" }); } }] : [])
  ];

  return (
    <>
      {groups.waiting.length > 0 && (
        <Command.Group heading={t("commandPalette.waitingGroup")} className="eyebrow palette-group" data-testid="palette-waiting">
          {groups.waiting.map(row)}
        </Command.Group>
      )}
      {groups.active.length > 0 && (
        <Command.Group heading={t("commandPalette.activeGroup")} className="eyebrow palette-group" data-testid="palette-active">
          {groups.active.map(row)}
        </Command.Group>
      )}
      <Command.Group heading={t("commandPalette.doGroup")} className="eyebrow palette-group" data-testid="palette-do">
        {doRows.map((a) => (
          <Command.Item key={a.id} value={a.label} className="palette-row" data-do={a.id} onSelect={() => run(a.run)}>
            <Icon name="i-chev" size={14} style={{ color: "var(--meta)" }} />
            <span className="p-label">{a.label}</span>
            {a.kb && <Kbd>{a.kb}</Kbd>}
          </Command.Item>
        ))}
      </Command.Group>
      {(groups.history.length > 0 || older.length > 0) && (
        <Command.Group heading={t("commandPalette.historyGroup")} className="eyebrow palette-group" data-testid="palette-history">
          {groups.history.map(row)}
          {older.map(olderRow)}
        </Command.Group>
      )}
    </>
  );
}
