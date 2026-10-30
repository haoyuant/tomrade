import { useDeferredValue, useMemo, type MutableRefObject, type ReactNode } from "react";
import { Command } from "cmdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EngineView, ThreadSummary } from "@tomradex/agent";
import type { RecentSession, ReviewRow, SessionView, StartDefaultsView } from "@tomradex/code-link";
import type { Item } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { Kbd } from "~/components/ui/atoms";
import { StatusMark } from "~/components/workspace/agent-panel/SessionBar";
import { invoke } from "~/lib/api";
import { ATTENTION_KEY, type AttentionEntry } from "~/lib/attention";
import { findEngine } from "~/lib/agent";
import { useI18n } from "~/lib/i18n";
import { keyLabel, formatChord } from "~/lib/keybindings";
import { askPanel, usePanelSession } from "~/lib/panelRequests";
import { keys } from "~/lib/queries";
import { LOOK_BACK } from "~/lib/paletteFilter";
import { outcomeLine } from "~/lib/review";
import { paletteSessionGroups, sessionBarRows, type BarRow } from "~/lib/sessionBar";
import { beginStarting, startWays } from "~/lib/startWays";
import { askText, doingText } from "~/lib/terminalSession";
import { useOpenTerminalWindow } from "~/lib/terminalWindow";
import { errorSpec, useToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { useOptionalAgentDock } from "~/components/chrome/ProjectShell";

/**
 * What the window already holds, read without asking for it again: opening ⌘K costs the main process nothing. A session
 * list the panel never fetched (it was never opened) is simply not here; the threads and what waits always are.
 */
function useHeld<T>(queryKey: readonly unknown[], queryFn: () => Promise<T>): T | undefined {
  return useQuery({ queryKey, queryFn, enabled: false }).data;
}

/** How a session starts on the words typed: the built-in assistant here (↵), a terminal agent in a background pane (⌥↵), or in a new Terminal window cell (⇧↵). */
export type LooseWay = "builtin" | "pane" | "cell";

const looseKey = (projectId: string) => `tomrade.startWay.${projectId}`;
/** The way this project started a session last: what ⌘K recommends. */
function lastLooseWay(projectId: string): LooseWay {
  try {
    const saved = localStorage.getItem(looseKey(projectId));
    return saved === "pane" || saved === "cell" ? saved : "builtin";
  } catch {
    return "builtin";
  }
}

/**
 * Starting a session with no ticket, from the words typed. The terminal agent is the one Start would use, read from
 * what the window already holds: opening ⌘K asks the main process nothing.
 */
export function useLooseStart(projectId: string) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const dock = useOptionalAgentDock();
  const engines = useHeld<EngineView[]>(keys.agent.engines, () => invoke("agent.engines"));
  const defaults = useHeld<StartDefaultsView | null>(keys.codeLink.startDefaults, () => invoke("codeLink.startDefaults"));
  const cli = startWays({ engines, capability: "code", primary: defaults?.engine ?? null, panes: true }).find((way) => way.kind === "pane") ?? null;
  const cliName = cli ? (findEngine(engines, cli.engine)?.title ?? cli.engine) : null;
  const go = (way: LooseWay, words: string) => {
    try {
      localStorage.setItem(looseKey(projectId), way);
    } catch {
      // only a recommendation
    }
    if (way === "builtin" || !cli || !cliName) {
      dock?.setAiOpen(true);
      return askPanel(words ? { kind: "startWith", text: words } : { kind: "newThread" });
    }
    if (!words) return;
    const done = beginStarting({ projectId, itemId: null, ticket: "", title: words, agent: cliName });
    void invoke("codeLink.startLoose", projectId, { engine: cli.engine, prompt: words })
      .then(async (result) => {
        if (!result.ok) return toast({ body: t("commandPalette.looseFailed", { agent: cliName, reason: result.message }) });
        const inWindow = way === "cell" && !!result.pane && (await invoke("codeLink.showSession", projectId, result.sessionId).catch(() => false));
        dock?.setAiOpen(true);
        // read afresh: the list the window holds was read before this session was
        await qc.fetchQuery({ queryKey: keys.codeLink.recentSessions(projectId), queryFn: () => invoke("codeLink.recentSessions", projectId), staleTime: 0 }).catch(() => undefined);
        askPanel({ kind: "openSession", sessionId: result.sessionId });
        toast({ body: t(inWindow ? "commandPalette.looseInWindow" : "commandPalette.looseStarted", { agent: cliName }) });
      }, (error: unknown) => toast(errorSpec(error)))
      .finally(done);
  };
  return { cliName, go, recommended: lastLooseWay(projectId) };
}

/** The ways to start a session, under ⌘K: on the words typed when nothing matched them, or as all ⌘K shows when opened to start. */
export function PaletteStart({ start, words, fresh, run }: {
  start: ReturnType<typeof useLooseStart>;
  words: string;
  /** Opened to start (the session bar's +), not because nothing matched. */
  fresh: boolean;
  run: (fn: () => void) => void;
}) {
  const { t } = useI18n();
  const { cliName, go, recommended } = start;
  const rows: { way: LooseWay; title: string; sub: string; key: string }[] = [
    { way: "builtin", title: t("commandPalette.startBuiltin"), sub: t("commandPalette.startBuiltinSub"), key: formatChord("Enter") },
    ...(cliName
      ? [
          { way: "pane" as const, title: t("commandPalette.startPane", { agent: cliName }), sub: t("commandPalette.startPaneSub"), key: formatChord("Alt+Enter") },
          { way: "cell" as const, title: t("commandPalette.startCell", { agent: cliName }), sub: t("commandPalette.startCellSub"), key: formatChord("Shift+Enter") }
        ]
      : [])
  ];
  return (
    <div className="palette-start" data-testid="palette-start" role="group" aria-label={t(fresh ? "commandPalette.startGroupNew" : "commandPalette.startGroup")}>
      <p className="eyebrow palette-start-head">{t(fresh ? "commandPalette.startGroupNew" : "commandPalette.startGroup")}</p>
      {rows.map((row) => (
        <button
          key={row.way}
          type="button"
          className={cn("palette-start-row", row.way === recommended && "is-recommended")}
          data-testid={row.way === "builtin" ? "palette-start-with" : `palette-start-${row.way}`}
          data-way={row.way}
          disabled={row.way !== "builtin" && !words}
          onClick={() => run(() => go(row.way, words))}
        >
          <span className="palette-start-text">
            <span>
              {row.title}
              {row.way === recommended && <span className="tag neutral palette-start-chip">{t("commandPalette.startRecommended")}</span>}
            </span>
            <span className="meta-txt">{row.way !== "builtin" && !words ? t("commandPalette.startNeedsWords", { pane: formatChord("Alt+Enter"), cell: formatChord("Shift+Enter") }) : row.sub}</span>
          </span>
          <Kbd>{row.key}</Kbd>
        </button>
      ))}
      {cliName && <p className="meta-txt palette-start-foot">{t("commandPalette.startFoot", { agent: cliName })}</p>}
    </div>
  );
}

/**
 * ⌘K's sessions and the things to do with them: waiting on you, in progress, ended. ↵ opens one here; ⇧↵ in a
 * Terminal window cell, where a terminal session has one. What ended comes after `children`, the tickets among them.
 */
export function PaletteSessions({ projectId, items, search, run, shift, onStart, children }: {
  projectId: string;
  items: Item[];
  /** What is typed in the palette: past two characters, the look back is searched for older ended sessions too. */
  search: string;
  /** Closes the palette and runs the choice. */
  run: (fn: () => void) => void;
  /** Whether the choice was made with ⇧↵. */
  shift: MutableRefObject<boolean>;
  /** ⌘K turns to its ways to start a session, the words typed kept. */
  onStart: () => void;
  /** The groups listed between what is to do and what ended. */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const dock = useOptionalAgentDock();
  const openTerminal = useOpenTerminalWindow(projectId);
  const panelSession = usePanelSession(projectId);
  const threads = useHeld<ThreadSummary[]>(keys.agent.threads(projectId), () => invoke("agent.threads", projectId));
  const sessions = useHeld<RecentSession[]>(keys.codeLink.recentSessions(projectId), () => invoke("codeLink.recentSessions", projectId));
  const attention = useHeld<AttentionEntry[]>(keys.attention, () => invoke("attention.list").catch(() => []));
  const engines = useHeld<EngineView[]>(keys.agent.engines, () => invoke("agent.engines"));
  const groups = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    const rows = sessionBarRows({
      threads: threads ?? [], sessions: sessions ?? [], attention: (attention ?? []).filter((e) => e.projectId === projectId), openThreadId: null, idleLimit: 50,
      itemTitle: (id) => byId.get(id)?.title ?? null, itemKey: (id) => byId.get(id)?.key ?? null,
      itemDone: (id) => byId.get(id)?.status === "done", now: Date.now()
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
    queryKey: keys.codeLink.review(projectId, typed, 8),
    queryFn: () => invoke("codeLink.reviewList", projectId, { query: typed, limit: 8 }),
    enabled: typed.length >= 2,
    staleTime: 30_000
  });
  const known = new Set([...groups.waiting, ...groups.active, ...groups.history].map((r) => r.sessionId ?? r.threadId));
  const older = (found.data?.rows ?? []).filter((r) => !known.has(r.id));
  // an idle conversation past the few the window holds opens as itself; what ended or was put away is looked back on
  const olderIdle = older.filter((r) => r.kind === "idle");
  const olderEnded = older.filter((r) => r.kind !== "idle");
  const outcomeOf = (r: ReviewRow) => outcomeLine(r, (key, vars) => t(`review.${key}`, vars));
  const openOlder = (r: ReviewRow) => {
    if (r.kind === "idle") return dock?.showThread(r.id);
    openPanel();
    askPanel(r.kind === "thread" ? { kind: "review", threadId: r.id } : { kind: "review", sessionId: r.id });
  };
  const olderRow = (r: ReviewRow, ended = false) => (
    <Command.Item key={`review:${r.id}`} value={`${r.tickets[0]?.key ?? ""} ${r.title} ${findEngine(engines, r.agent)?.title ?? r.agent} ${outcomeOf(r) ?? ""} review:${r.id}`} keywords={ended ? [LOOK_BACK, ...r.tickets.map((x) => x.key), r.title] : undefined} className="palette-row" data-session={`review:${r.id}`} onSelect={() => run(() => openOlder(r))}>
      <span className="palette-mark"><StatusMark status={r.kind === "idle" ? "idle" : "done"} size={12} /></span>
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
  const said = (r: BarRow) => (r.wait ? (r.ask ? askText(r.ask, t) : r.wait.text || t(ATTENTION_KEY[r.wait.kind])) : r.status === "done" ? (r.outcome ? outcomeLine(r.outcome, (key, vars) => t(`review.${key}`, vars)) : null) : doingText(r, t));
  const agentName = (r: BarRow) => (r.agent ? (findEngine(engines, r.agent)?.title ?? r.agent) : null);
  const row = (r: BarRow) => (
    <Command.Item key={r.key} value={`${name(r)} ${r.title} ${agentName(r) ?? ""} ${said(r) ?? ""} ${r.key}`} keywords={r.status === "done" ? [LOOK_BACK, r.ticket ?? "", r.title] : undefined} className="palette-row" data-session={r.key} data-depth={r.depth || undefined} onSelect={() => pick(r)}>
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
    { id: "new", label: t("commandPalette.startSession"), kb: undefined, run: onStart, stay: true },
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
      {(groups.active.length > 0 || olderIdle.length > 0) && (
        <Command.Group heading={t("commandPalette.activeGroup")} className="eyebrow palette-group" data-testid="palette-active">
          {groups.active.map(row)}
          {olderIdle.map((r) => olderRow(r))}
        </Command.Group>
      )}
      <Command.Group heading={t("commandPalette.doGroup")} className="eyebrow palette-group" data-testid="palette-do">
        {doRows.map((a) => (
          <Command.Item key={a.id} value={a.label} className="palette-row" data-do={a.id} onSelect={() => ("stay" in a ? a.run() : run(a.run))}>
            <Icon name="i-chev" size={14} style={{ color: "var(--meta)" }} />
            <span className="p-label">{a.label}</span>
            {a.kb && <Kbd>{a.kb}</Kbd>}
          </Command.Item>
        ))}
      </Command.Group>
      {children}
      {(groups.history.length > 0 || olderEnded.length > 0) && (
        <Command.Group heading={t("commandPalette.historyGroup")} className="eyebrow palette-group" data-testid="palette-history">
          {groups.history.map(row)}
          {olderEnded.map((r) => olderRow(r, true))}
        </Command.Group>
      )}
    </>
  );
}
