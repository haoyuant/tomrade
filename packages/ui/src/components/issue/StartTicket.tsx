import type { AgentSettings, EnginePick, PlaybookRecommendation } from "@tomradex/agent";
import type { StartOptions, StartResult } from "@tomradex/code-link";
import type { Item } from "@tomradex/domain";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { findEngine, methodWords, ticketMethods, useAgentThread, useAgentThreads, useEngines, usePlaybooks } from "~/lib/agent";
import { invoke, logQuietly } from "~/lib/api";
import { defaultStartMode, onStartRequest, useHerdrStatus, useCodeDeliveries, useCodeSessions, useStartDefaults, useStartTicket, useTerminalWindow } from "~/lib/codeLink";
import { askPanel } from "~/lib/panelRequests";
import { doingText } from "~/lib/terminalSession";
import { beginStarting, opensWindow, startWays, useStartingFor, wayKey, wayOf, type StartWay, type WayKind } from "~/lib/startWays";
import { StartGateFix, useGateWords, type StartFailure } from "./StartGateFix";
import { StartProgressNote } from "./StartProgress";
import { RunOn } from "./RunOn";
import { asksElsewhere, labelMiss, runOnState, targetOf, takers, useDevices } from "~/lib/devices";
import { useI18n } from "~/lib/i18n";
import { useRoleMode, useRoles } from "~/lib/roles";
import { pickFallbackName } from "~/lib/engines";
import { engineStateLabel } from "~/lib/localCli";
import { useHintToast } from "~/lib/onboarding";
import { STATUS } from "~/lib/domain";
import { invalidateWorkspace, keys, useHubInfo, useItems, useSettings } from "~/lib/queries";
import { readableError, useToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { Icon } from "~/components/icons";
import { useAgentDock } from "~/components/chrome/ProjectShell";
import { useHerdrHint } from "~/components/setup/HerdrRecommend";
import { Dialog, DialogBody, DialogClose, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Menu, MenuActionItem, MenuHead, MenuStackItem } from "~/components/ui/menu";
import { PickSelect } from "~/components/ui/pick-select";
import { isFullAccess, permissionHint, permissionLabel } from "~/lib/codeLink";
import type { MessageKey } from "~/lib/i18n";

const WAY_NAME: Record<WayKind, MessageKey> = { pane: "codeLink.wayPane", window: "codeLink.wayWindow", terminal: "codeLink.wayTerminal", here: "codeLink.wayHere", builtin: "codeLink.wayBuiltin" };
const WAY_NOTE: Record<WayKind, MessageKey> = { pane: "codeLink.wayPaneNote", window: "codeLink.wayWindowNote", terminal: "codeLink.wayTerminalNote", here: "codeLink.wayHereNote", builtin: "codeLink.wayBuiltinNote" };

interface StartTicketProps {
  projectId: string;
  item: Item;
  /** Where a "Open TOM-1" action lands — the bootstrap ticket, by key or id. */
  onOpenIssue?: (idOrKey: string) => void;
  /** Where "Repositories…" lands when the workstream has no repository or this machine no checkout. */
  onOpenRepositories?: () => void;
  className?: string;
}

/**
 * One Start button for every ticket, coding or General. It opens the dialog
 * where the run is settled: here or in a terminal, which agent, which model
 * and effort, and — for General work — which method, with the assistant's
 * recommendation already in place. Shared by the issue sheet and the docked
 * detail pane, so the button reads the same in both.
 */
export function StartTicket(props: StartTicketProps) {
  const { t } = useI18n();
  const { projectId, item, className } = props;
  const [open, setOpen] = useState(false);
  // asked to open from elsewhere: in that mode, starting at once so what stopped it shows with its fix
  const [requested, setRequested] = useState<"run" | "terminal" | null>(null);
  // a start with last time's choices, or a way from ▾: no dialog unless something stops it or needs the person
  const [quick, setQuick] = useState(false);
  const [way, setWay] = useState<StartWay | null>(null);
  // "Start another" beside a session at work: in a folder and on a branch of its own
  const [apart, setApart] = useState(false);
  const [task, setTask] = useState<string | undefined>(undefined);
  const { showThread, setAiOpen } = useAgentDock();
  const defaults = useStartDefaults();
  useEffect(
    () =>
      onStartRequest(item.id, (mode, offered, beside) => {
        setRequested(mode);
        setTask(offered);
        setApart(!!beside);
        setOpen(true);
      }),
    [item.id]
  );
  const sessions = useCodeSessions(projectId, item.id);
  const deliveries = useCodeDeliveries(projectId, item.id);
  const engines = useEngines();
  const settings = useSettings();
  const terminalWindow = useTerminalWindow(projectId).data === true;
  const starting = useStartingFor(item.id);
  const hub = useHubInfo();
  const devices = useDevices();
  const startable = item.kind === "ticket" && item.status !== "done" && item.status !== "cancelled";
  // Pointed out the first time it could actually run: a local agent is ready to take the ticket.
  useHintToast("hint.start", startable && !!engines.data?.some((e) => e.ok && e.capabilities.some((c) => c === "code" || c === "general")), "onboarding.startHint");
  if (!startable) return null;
  const active = deliveries.data?.find((delivery) => delivery.state === "active");
  const ofDelivery = (sessions.data ?? []).filter((session) => !!active && session.delivery === active.sequence);
  const hasSession = ofDelivery.length > 0;
  // A session still at work on it: Start first asks whether to look at it, talk to it, or start another beside it.
  const live = ofDelivery.filter((session) => session.state !== "ended" && session.state !== "lost").sort((a, b) => b.startedAt - a.startedAt)[0];
  // One click goes the way this ticket — else this machine — last started; a first start chooses in the dialog.
  const latestSession = ofDelivery.sort((a, b) => b.startedAt - a.startedAt)[0];
  const lastAgent = latestSession?.agent ?? defaults.data?.engine ?? null;
  const quickEngine = lastAgent ? findEngine(engines.data, lastAgent) : undefined;
  const general = item.workType === "general";
  // The one-click Start opens no dialog, so the way to another computer is said here too, wherever the dialog would say it.
  const elsewhereOffered = !general && runOnState(hub.data?.cloudEnabled, devices.data, projectId).kind !== "hidden";
  const quickWay = quickEngine
    ? wayOf({
        mode: defaultStartMode({ latest: latestSession?.mode ?? null, remembered: defaults.data?.mode ?? null, terminalWindow, coding: !general, agentInTerminal: quickEngine.terminal !== false }),
        engine: quickEngine.id,
        panes: terminalWindow,
        window: opensWindow(settings.data?.sessions)
      })
    : null;
  const ways = quickEngine ? startWays({ engines: engines.data, capability: general ? "general" : "code", primary: quickEngine.id, panes: terminalWindow, quick: quickWay }) : [];
  const wayName = (w: StartWay) => t(WAY_NAME[w.kind], { agent: findEngine(engines.data, w.engine)?.title ?? w.engine });
  const wayNote = (w: StartWay) => (quickWay && wayKey(w) === wayKey(quickWay) ? t("codeLink.wayDefault", { note: t(WAY_NOTE[w.kind]) }) : t(WAY_NOTE[w.kind]));
  const openDialog = (asQuick: boolean, chosen: StartWay | null = null, beside = false) => {
    setQuick(asQuick);
    setWay(chosen);
    setApart(beside);
    setOpen(true);
  };
  // The session at work, in the assistant panel: a terminal one as its session view (its input taking the keyboard, to say something), one run here as its conversation.
  const inPanel = (say: boolean) => {
    if (!live) return;
    if (live.mode === "terminal") {
      setAiOpen(true);
      askPanel({ kind: "openSession", sessionId: live.id, say });
    } else if (live.threadId) showThread(live.threadId);
  };
  const liveWho = live ? (findEngine(engines.data, live.agent)?.title ?? live.agent) : "";
  return (
    <>
      <span className={cn("split-btn", className)}>
        {starting ? (
          <span className="start-starting" role="status" data-testid="start-starting">
            <span className="start-starting-mark" aria-hidden="true" />
            {t("codeLink.startingLine", { agent: starting.agent })}
          </span>
        ) : live ? (
          <>
            <Menu
              label={t("codeLink.liveTitle", { agent: liveWho })}
              trigger={
                <button type="button" className="btn btn-primary" data-testid="start-quick">
                  {t("codeLink.continueWith", { agent: liveWho })}
                  <Icon name="i-chevdown" size={11} />
                </button>
              }
            >
              <MenuHead title={t("codeLink.liveTitle", { agent: liveWho })} />
              {(live.summary || doingText(live, t)) && <p className="meta-txt dense menu-note" data-testid="start-live-said">{doingText(live, t) ?? live.summary}</p>}
              <MenuStackItem mark={<Icon name="i-eye" size={13} />} name={t("codeLink.liveLook")} sub={t("codeLink.liveLookNote")} onSelect={() => inPanel(false)} />
              {(live.mode === "terminal" || live.threadId) && <MenuStackItem mark={<Icon name="i-send" size={13} />} name={t("codeLink.liveSay")} sub={t("codeLink.liveSayNote")} onSelect={() => inPanel(true)} />}
              <MenuStackItem mark={<Icon name="i-plus" size={13} />} name={t("codeLink.liveAnother")} sub={t("codeLink.liveAnotherNote")} onSelect={() => openDialog(false, null, true)} />
            </Menu>
            <button type="button" className="btn btn-primary split-more" data-testid="start-ticket" title={t("codeLink.chooseHow")} aria-label={t("codeLink.chooseHow")} onClick={() => openDialog(false)}>
              <Icon name="i-sliders" size={13} />
            </button>
          </>
        ) : quickEngine ? (
          <>
            <button type="button" className="btn btn-primary" data-testid="start-quick" title={t("codeLink.quickHint")} onClick={() => openDialog(true)}>
              {t(hasSession ? "codeLink.continueWith" : "codeLink.startWith", { agent: quickEngine.title })}
            </button>
            <Menu
              label={t("codeLink.waysLabel")}
              wide
              trigger={
                <button type="button" className="btn btn-primary split-more" data-testid="start-ways" title={t("codeLink.waysLabel")} aria-label={t("codeLink.waysLabel")}>
                  <Icon name="i-chevdown" size={11} />
                </button>
              }
            >
              <MenuHead title={t("codeLink.waysLabel")} />
              {ways.map((w) => <MenuStackItem key={wayKey(w)} name={wayName(w)} sub={wayNote(w)} onSelect={() => openDialog(true, w)} />)}
              {elsewhereOffered && <MenuActionItem icon={<Icon name="i-monitor" size={13} />} name={t("devices.runElsewhere")} onSelect={() => openDialog(false)} />}
              <MenuActionItem icon={<Icon name="i-sliders" size={13} />} name={t("codeLink.fullSettings")} onSelect={() => openDialog(false)} />
            </Menu>
          </>
        ) : (
          <button type="button" className="btn btn-primary" data-testid="start-ticket" onClick={() => openDialog(false)}>
            {t(hasSession ? "codeLink.continue" : "codeLink.start")}
          </button>
        )}
      </span>
      {open && (
        <StartTicketDialog
          {...props}
          requested={requested}
          quick={quick}
          way={way}
          apart={apart}
          task={task}
          onClose={() => {
            setOpen(false);
            setQuick(false);
            setWay(null);
            setApart(false);
            setRequested(null);
            setTask(undefined);
          }}
        />
      )}
    </>
  );
}

function StartTicketDialog({
  projectId,
  item,
  onOpenIssue,
  onOpenRepositories,
  onClose,
  requested,
  quick,
  way,
  apart,
  task
}: StartTicketProps & { onClose: () => void; requested?: "run" | "terminal" | null; quick?: boolean; way?: StartWay | null; apart?: boolean; task?: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const { showThread, openSettings, setAiOpen } = useAgentDock();
  // A quick start says nothing until something stops it or needs the person: then the dialog shows, with the fix.
  const [shown, setShown] = useState(!quick);
  const reveal = () => setShown(true);
  const general = item.workType === "general";
  // Where it runs: here unless the person picks another computer, or the ticket's labels name one that can take it.
  const devices = useDevices();
  const [chosenTarget, setChosenTarget] = useState<string | null>(null);
  const engines = useEngines();
  const settings = useSettings();
  const playbooks = usePlaybooks(projectId);
  const sessions = useCodeSessions(projectId, item.id);
  const deliveries = useCodeDeliveries(projectId, item.id);
  const threads = useAgentThreads(projectId);
  const items = useItems(projectId);
  const start = useStartTicket(projectId);
  // Dependencies inform the start rather than forbid it: the dialog names them, and starting past them is an explicit choice.
  const waitsOn = useMemo(
    () => item.blockedBy.flatMap((id) => items.data?.find((other) => other.id === id && other.status !== "done" && other.status !== "cancelled") ?? []),
    [item.blockedBy, items.data]
  );

  // What an earlier start on this delivery settled: its thread carries the engine, the knobs and the method.
  const active = deliveries.data?.find((delivery) => delivery.state === "active");
  const latest = useMemo(
    () => (sessions.data ?? []).filter((session) => !active || session.delivery === active.sequence).sort((a, b) => b.startedAt - a.startedAt)[0] ?? null,
    [sessions.data, active]
  );
  const threadId = latest?.threadId ?? (threads.data ?? []).find((thread) => thread.itemId === item.id && !thread.archived)?.id ?? null;
  const threadDetail = useAgentThread(projectId, threadId).data;
  const thread = threadDetail?.thread ?? null;
  // The agent asked something and waits: answering it is the way on, not another Start.
  const asked = threadDetail?.pending && threadDetail.pending.kind !== "permission" ? threadDetail.pending.question.text : null;

  const agentSettings = settings.data?.agent as AgentSettings | undefined;
  const otherCommand = ((settings.data?.codeLink as { otherCommand?: string } | undefined)?.otherCommand ?? "").trim();
  // How Start was last left on this machine, before this ticket's own thread says anything.
  const defaults = useStartDefaults();
  const rememberedStart = defaults.data ?? null;
  const [chosenMode, setChosenMode] = useState<StartOptions["mode"] | null>(requested ?? way?.mode ?? null);
  // Coding work goes to Tomrade's own Terminal window when it can show it, unless the agent picked last has no terminal.
  const terminalWindowQuery = useTerminalWindow(projectId);
  const terminalWindow = terminalWindowQuery.data === true;
  const agentInTerminal = useMemo(() => {
    const code = (engines.data ?? []).filter((engine) => engine.capabilities.includes("code"));
    const last = findEngine(code, latest?.agent ?? thread?.engine ?? rememberedStart?.engine ?? null);
    return last ? last.terminal !== false : code.some((engine) => engine.terminal !== false);
  }, [engines.data, latest?.agent, thread?.engine, rememberedStart?.engine]);
  const mode: StartOptions["mode"] =
    chosenMode ?? defaultStartMode({ latest: latest?.mode ?? null, remembered: rememberedStart?.mode ?? null, terminalWindow, coding: !general, agentInTerminal });
  const herdrStatus = useHerdrStatus(mode === "terminal");
  // A start in a pane is watched in the panel, unless this start or Settings › Sessions brings up the Terminal window too.
  const [chosenWindow, setChosenWindow] = useState<boolean | null>(way ? way.window : null);
  const alsoWindow = chosenWindow ?? opensWindow(settings.data?.sessions);
  // Coding work in a terminal lands in Tomrade's Terminal window: the choices say so.
  const inTomrade = terminalWindow && !general;
  const herdrHint = useHerdrHint();
  const capability = general ? "general" : "code";
  // An agent Tomrade drives over ACP has no terminal session to open.
  const candidates = useMemo(
    () => (engines.data ?? []).filter((engine) => engine.capabilities.includes(capability) && (mode !== "terminal" || engine.terminal !== false) && (mode === "terminal" || !engine.terminalOnly)),
    [engines.data, capability, mode]
  );
  const otherAllowed = mode === "terminal" && !!otherCommand;
  // The project's role the ticket is worked as: the one picked here, else the one its last session went by, else the implementer.
  const roles = useRoles(projectId, !general);
  const workRoles = useMemo(() => (roles.data ?? []).filter((r) => r.stage === "implement"), [roles.data]);
  const [chosenRole, setChosenRole] = useState<string | null>(null);
  const role = general ? null : (workRoles.find((r) => r.id === (chosenRole ?? latest?.role)) ?? workRoles.find((r) => r.builtin) ?? null);
  // A role that names its agents chooses among them for a ticket nobody has started; a conversation under way keeps its own.
  const roleEngines = role?.engines.length && !latest && !thread ? role.engines.flatMap((id) => findEngine(candidates, id) ?? []) : [];
  const roleEngine = (roleEngines.find((candidate) => candidate.ok) ?? roleEngines[0])?.id ?? null;
  const [chosenEngine, setChosenEngine] = useState<string | null>(way?.engine ?? null);
  const lastAgent = latest?.agent ?? thread?.engine ?? rememberedStart?.engine ?? null;
  const remembered = findEngine(candidates, lastAgent)?.id ?? lastAgent;
  const engineId =
    chosenEngine && (candidates.some((engine) => engine.id === chosenEngine) || (chosenEngine === "other" && otherAllowed))
      ? chosenEngine
      : roleEngine
        ? roleEngine
      : remembered && (candidates.some((engine) => engine.id === remembered) || (remembered === "other" && otherAllowed))
        ? remembered
        : (candidates.find((engine) => engine.ok) ?? candidates[0])?.id ?? (otherAllowed ? "other" : "");
  const engine = candidates.find((candidate) => candidate.id === engineId);
  // Machine-wide knobs (the CodeBuddy edition) are already in settings; a start takes them from there.
  const picks = engineId === "other" ? [] : (engine?.picks ?? []).filter((pick) => !pick.global);
  const globalOptions = (agentSettings?.engines?.[engineId] ?? {}) as Record<string, unknown>;
  const globalValue = (key: string) => (typeof globalOptions[key] === "string" && globalOptions[key] ? (globalOptions[key] as string) : "");

  // Knobs: the thread's own overrides when it runs on this engine, then what the last start here used, then what the user changes now.
  const [chosenPicks, setChosenPicks] = useState<Record<string, string> | null>(null);
  const threadPicks = useMemo(() => {
    const out: Record<string, string> = {};
    if (thread && thread.engine === engineId) for (const [key, value] of Object.entries(thread.options ?? {})) if (typeof value === "string") out[key] = value;
    else if (rememberedStart && findEngine(candidates, rememberedStart.engine)?.id === engineId) for (const [key, value] of Object.entries(rememberedStart.options ?? {})) if (typeof value === "string") out[key] = value;
    return out;
  }, [thread, engineId, rememberedStart, candidates]);
  const pickValues = chosenPicks ?? threadPicks;
  const setPick = (key: string, value: string) => setChosenPicks({ ...pickValues, [key]: value });
  const pickTitle = (pick: EnginePick) => (pick.key === "model" || pick.key === "profile" ? t("agentPanel.modelHead") : pick.key === "effort" ? t("agentPanel.effortHead") : pick.title);

  const permissionModes = !general && mode === "run" ? engine?.permissionModes : undefined;
  const [chosenPermission, setChosenPermission] = useState<string | null>(null);
  // The conversation's own mode first, then what the role allows, then how Start was last left on this machine.
  const threadPermission = thread?.engine === engineId ? thread?.permissionMode : null;
  const rememberedPermission = rememberedStart?.engine === engineId ? rememberedStart.permissionMode : null;
  const roleMode = useRoleMode(projectId, role, engineId, !!permissionModes).data ?? null;
  const permissionMode = permissionModes ? (chosenPermission ?? threadPermission ?? roleMode ?? rememberedPermission ?? permissionModes.default) : undefined;
  // A role's limit is the role's to apply: only a mode the person picked, or the conversation already has, is sent in its place.
  const byRoleLimit = !!role?.permission && !chosenPermission && !threadPermission;
  const sentPermission = byRoleLimit ? undefined : permissionMode;
  // The built-in implementer nobody changed says nothing: a Start by it is a Start as it always was.
  const roleArg = role && (!role.builtin || role.changed) ? role.id : undefined;
  // What the role asks of a computer, or a label that asks for another one, chooses it; one no computer can answer now leaves the ticket here, where Start says why.
  const labelled = asksElsewhere(item, projectId, devices.data, role);
  const target = chosenTarget ?? (labelled && !labelMiss(item, projectId, devices.data, role) ? targetOf(item, takers(devices.data?.devices, projectId, role), role) : null) ?? "here";
  const elsewhere = target !== "here";
  // Sending to another computer is the dialog's main action then: its button sits where Start does.
  const [sendSlot, setSendSlot] = useState<HTMLElement | null>(null);

  // General work: the method, recommended by the assistant unless the delivery already has one; the user's pick always wins.
  const methods = useMemo(() => ticketMethods(playbooks.data, "general"), [playbooks.data]);
  const [chosenPlaybook, setChosenPlaybook] = useState<string | null>(null);
  const [recommendation, setRecommendation] = useState<PlaybookRecommendation | null>(null);
  const [recommending, setRecommending] = useState(general);
  useEffect(() => {
    if (!general) return;
    let cancelled = false;
    void invoke("agent.recommendPlaybook", projectId, { title: item.title, body: item.body, workType: "general" })
      .then((result) => { if (!cancelled) setRecommendation(result); })
      .catch(logQuietly("agent.recommendPlaybook"))
      .finally(() => { if (!cancelled) setRecommending(false); });
    return () => { cancelled = true; };
  }, [general, projectId, item.title, item.body]);
  // A method the delivery already runs, or the ticket already names, stays; then the last start here; the recommendation is one click away.
  const playbook = chosenPlaybook ?? thread?.execution?.playbook.id ?? item.playbookId ?? rememberedStart?.playbook ?? recommendation?.playbookId ?? "task.assist";
  const recommended = recommendation?.playbookId ?? null;
  const method = (id: string) => methodWords(t, id, methods.find((entry) => entry.id === id));
  const recommendedTitle = recommended ? method(recommended).title : null;

  const [error, setError] = useState<{ message: string; failure?: StartFailure } | null>(null);
  const gateWords = useGateWords();
  const takeover = useMutation({
    mutationFn: () => invoke("agent.takeoverGeneral", projectId, item.id),
    onSuccess: (result) => toast({ body: t(result.stopped > 0 ? "fields.takeoverReady" : "fields.takeoverNoRun") }),
    onError: (err) => setError({ message: readableError(err) }),
    onSettled: () => invalidateWorkspace(qc, projectId)
  });

  const continuing = !!latest || !!thread?.execution;
  const title = t(continuing ? "codeLink.continueTitle" : "codeLink.dialogTitle", { key: item.key });
  const ready = engineId === "other" ? true : !!engine?.ok;
  const busy = start.isPending || takeover.isPending;

  // A session in a background pane: the panel opens on it once the list it is read from has it.
  const watchInPanel = async (sessionId: string) => {
    setAiOpen(true);
    await qc.fetchQuery({ queryKey: keys.codeLink.recentSessions(projectId), queryFn: () => invoke("codeLink.recentSessions", projectId), staleTime: 0 }).catch(logQuietly("codeLink.recentSessions"));
    askPanel({ kind: "openSession", sessionId });
  };

  // `first`: another ticket (a bootstrap) is started with these choices instead, and this one follows it once it lands.
  const submit = (allowBlocked = waitsOn.length > 0, releaseBranch = false, first?: { itemId: string; key: string }) => {
    setError(null);
    const options: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(pickValues)) if (value) options[key] = value;
    const target = first ? (items.data?.find((other) => other.id === first.itemId) ?? item) : item;
    // Shown on the ticket and atop the session bar until its session is there to show.
    const done = beginStarting({ projectId, itemId: target.id, ticket: target.key, title: target.title, agent: engineId === "other" ? t("codeLink.otherAgent") : (engine?.title ?? engineId) });
    const failed = (failure: { message: string; failure?: StartFailure }) => {
      setError(failure);
      reveal();
    };
    const launched = async (result: Extract<StartResult, { ok: true }>) => {
      onClose();
      if (first) {
        toast({ body: t("codeLink.bootstrapFirstToast", { bootstrap: first.key, key: item.key }) });
        if (result.mode === "run" && result.threadId) showThread(result.threadId);
        return;
      }
      const vars = { key: item.key, branch: result.branch };
      const warning = result.warnings?.join("\n");
      const say = (body: string) => toast({ body: warning ? `${body}\n${warning}` : body });
      if (result.mode === "run") {
        say(result.waitingOn ? t("codeLink.waitingToast", { question: result.waitingOn }) : t(result.continued ? "codeLink.continuedToast" : "codeLink.startedToast", vars));
        if (result.threadId) showThread(result.threadId);
      } else if (result.launched && result.pane && !alsoWindow) {
        herdrHint(result, herdrStatus.data);
        await watchInPanel(result.sessionId);
        say(t("codeLink.paneToast", vars));
      } else if (result.launched) {
        herdrHint(result, herdrStatus.data);
        // In herdr: brought up in Tomrade's Terminal window when that is on, else where herdr shows it.
        const inWindow = result.pane ? await invoke("codeLink.showSession", projectId, result.sessionId).catch(() => false) : false;
        say(t(inWindow ? "codeLink.terminalWindowToast" : "codeLink.terminalToast", vars));
      } else {
        const command = result.command ?? "";
        toast({ body: warning ? `${command}\n${warning}` : command, actions: [{ label: t("codeLink.copyCommand"), run: () => void navigator.clipboard?.writeText(command).then(() => toast({ body: t("codeLink.commandCopied") })) }] });
      }
      // the bar has the new session before the line saying it starts goes
      await qc.refetchQueries({ queryKey: keys.codeLink.recentSessions(projectId), type: "active" }, { cancelRefetch: false });
    };
    // Awaited rather than mutate's callbacks: what follows a start still happens when this ticket's page was left meanwhile.
    void start
      .mutateAsync(
        first
          ? { itemId: first.itemId, mode, engine: engineId, options, ...(permissionMode ? { permissionMode } : {}), then: item.id }
          : { itemId: item.id, mode, engine: engineId, options, ...(general ? { playbook } : {}), ...(sentPermission ? { permissionMode: sentPermission } : {}), ...(roleArg ? { role: roleArg } : {}), ...(allowBlocked ? { allowBlocked } : {}), ...(releaseBranch ? { releaseBranch } : {}), ...(task ? { message: task } : {}), ...(apart ? { apart } : {}) }
      )
      .then((result) => (result.ok ? launched(result) : failed({ message: result.message, failure: result })))
      .catch((err: unknown) => failed({ message: readableError(err) }))
      .finally(done);
  };

  // One click: once everything the choices rest on is known, start with them — unless something needs the person first.
  const quickTried = useRef(false);
  const known = !!engines.data && !!settings.data && defaults.isSuccess && sessions.isSuccess && deliveries.isSuccess && threads.isSuccess && terminalWindowQuery.isSuccess && (!threadId || !!threadDetail) && !recommending && !devices.isLoading;
  useEffect(() => {
    if (!quick || quickTried.current || !known) return;
    quickTried.current = true;
    // a way from ▾ whose agent cannot take it here is not started with another one behind the person's back
    // nor is a ticket whose label asks for another computer started here unasked
    if (ready && !waitsOn.length && !asked && !labelled && (!way || engineId === way.engine)) submit();
    else reveal();
  });

  // opened because a start elsewhere stopped: try once more here, once the agents are known, so the problem shows with its fix
  const retried = useRef(false);
  useEffect(() => {
    if (!requested || retried.current || !engines.data) return;
    retried.current = true;
    submit();
  });

  // "As [role], on [computer]": the two choices that hold wherever the ticket runs, one row each.
  const roleRow = !general && workRoles.length > 0 && (
    <>
      <label className="run-on-row">
        <span className="run-on-name">{t("roles.startRole")}</span>
        <select id="stRole" className="input" data-testid="start-role" title={t("roles.startRoleHint")} value={role?.id ?? ""} disabled={busy} onChange={(event) => { setChosenRole(event.target.value); setChosenEngine(null); setChosenPicks(null); setChosenPermission(null); setChosenTarget(null); }}>
          {workRoles.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
        </select>
      </label>
      {!!role?.engines.length && (
        <p className="meta-txt" data-testid="start-role-hint">{t("roles.startRoleEngines", { role: role.title, agents: role.engines.map((id) => findEngine(engines.data, id)?.title ?? id).join(" → ") })}</p>
      )}
    </>
  );

  if (!shown) return null;
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()} label={title} className="sheet-md">
      <DialogHead title={title} />
      <DialogBody>
        <RunOn projectId={projectId} item={item} target={target} role={role} sendRole={!!roleArg} lead={roleRow} sendSlot={sendSlot} onTarget={setChosenTarget} onClose={onClose} />
        <div className="stack-4" data-testid="start-dialog" style={elsewhere ? { display: "none" } : undefined}>
          {apart && (
            <p className="meta-txt" role="note" data-testid="start-apart">
              {t("codeLink.apartNote")}
            </p>
          )}
          {task && (
            <p className="meta-txt" role="note" data-testid="start-task">
              {t("codeLink.startTask", { task })}
            </p>
          )}
          <Field label={t("codeLink.where")}>
            <div className="seg" role="group" aria-label={t("codeLink.where")} data-testid="start-mode" data-terminal-window={inTomrade || undefined}>
              <button type="button" aria-pressed={mode === "run"} data-mode="run" onClick={() => setChosenMode("run")}>
                <Icon name="i-plug" size={13} /> {t(inTomrade ? "codeLink.startPanel" : "codeLink.startHere")}
              </button>
              <button type="button" aria-pressed={mode === "terminal"} data-mode="terminal" onClick={() => setChosenMode("terminal")}>
                <Icon name="i-terminal" size={13} /> {t(inTomrade ? "codeLink.startTomrade" : "codeLink.startTerminal")}
              </button>
            </div>
            <p className="meta-txt">{t(mode === "run" ? (general ? "codeLink.startHereGeneralHint" : "codeLink.startHereHint") : general ? "codeLink.startTerminalGeneralHint" : inTomrade ? (alsoWindow ? "codeLink.startTomradeHint" : "codeLink.startPaneHint") : "codeLink.startTerminalHint")}</p>
            {mode === "terminal" && terminalWindow && (
              <label className="cfg-row" style={{ cursor: "pointer" }}>
                <input type="checkbox" data-testid="start-also-window" checked={alsoWindow} disabled={busy} onChange={(event) => setChosenWindow(event.target.checked)} />
                <span className="cfg-name">{t("codeLink.alsoWindow")}</span>
              </label>
            )}
            {mode === "terminal" && herdrStatus.data && (
              <p className="meta-txt" role="status" data-testid="start-herdr-status">
                {t(herdrStatus.data === "running" ? "codeLink.herdrRunning" : herdrStatus.data === "notRunning" ? "codeLink.herdrNotRunning" : "codeLink.herdrNotInstalled")}
                {herdrStatus.data !== "running" && <> · {t(herdrStatus.data === "notRunning" ? "codeLink.herdrStartsOnStart" : "codeLink.herdrSetupHint")}</>}
              </p>
            )}
            {rememberedStart && !latest && !thread && (
              <p className="meta-txt" data-testid="start-remembered">{t("codeLink.rememberedHint")}</p>
            )}
          </Field>

          <Field label={t("codeLink.agentHead")} htmlFor="stEngine">
            <select id="stEngine" className="select" value={engineId} disabled={busy} onChange={(event) => { setChosenEngine(event.target.value); setChosenPicks(null); setChosenPermission(null); }}>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id} disabled={!candidate.ok}>
                  {candidate.title}{candidate.ok ? "" : ` — ${engineStateLabel(candidate, t, t("settingsDialog.engineUnavailable"))}`}
                </option>
              ))}
              {otherAllowed && <option value="other">{t("codeLink.otherAgent")}</option>}
            </select>
            {!candidates.length && !otherAllowed && <p className="meta-txt">{t("codeLink.noAgents")}</p>}
            {engine && !engine.ok && (
              <p className="meta-txt" data-testid="start-engine-not-ready">
                {t("localCli.notReady", { title: engine.title, state: engineStateLabel(engine, t, t("settingsDialog.engineUnavailable")) })}
                {" "}
                <button type="button" className="btn btn-ghost" style={{ padding: "0 6px" }} data-testid="start-engine-configure" onClick={() => { onClose(); openSettings(engine.id); }}>
                  {t("localCli.configure")}
                </button>
              </p>
            )}
          </Field>

          {picks.length > 0 && (
            <div className="field-group">
              <div className="row" style={{ alignItems: "flex-start", gap: "var(--space-3)" }}>
                {picks.map((pick) => {
                  const id = `stPick-${pick.key}`;
                  const value = pickValues[pick.key] ?? "";
                  // "Default" is no choice of this start's: what Settings holds for the engine, else the engine's own, where it has said.
                  const saved = globalValue(pick.key);
                  const stands = saved ? (pick.choices.find((c) => c.value === saved)?.label ?? saved) : pickFallbackName(t, pick);
                  const defaultLabel = stands ? t("agentPanel.pickDefaultKnown", { value: stands }) : t("codeLink.defaultOption");
                  return (
                    <div className="field" style={{ flex: 1 }} key={`${engineId}-${pick.key}`}>
                      <label htmlFor={id}>{pickTitle(pick)}</label>
                      <PickSelect id={id} pick={pick} value={value} onChange={(next) => setPick(pick.key, next)} defaultLabel={defaultLabel} disabled={busy} />
                    </div>
                  );
                })}
              </div>
              <p className="meta-txt" data-testid="start-picks-hint">{t("codeLink.picksHint", { engine: engine?.title ?? "" })}</p>
            </div>
          )}

          {permissionModes && (
            <Field label={t("codeLink.permissionsHead")} htmlFor="stPermission">
              <select id="stPermission" className="select" value={permissionMode} disabled={busy} onChange={(event) => setChosenPermission(event.target.value)}>
                {permissionModes.choices.map((choice) => <option key={choice.value} value={choice.value}>{permissionLabel(t, choice)}</option>)}
              </select>
              {permissionHint(t, permissionMode) && <p className="meta-txt" data-testid="start-permission-hint">{permissionHint(t, permissionMode)}</p>}
              {byRoleLimit && role && <p className="meta-txt" data-testid="start-role-limit">{t(roleMode ? "roles.startRoleLimit" : "roles.startRoleNoMode", { role: role.title, limit: t(`devices.ceiling_${role.permission!}` as MessageKey), agent: engine?.title ?? "" })}</p>}
              {isFullAccess(permissionMode) && (
                <p className="start-warning" role="note" data-testid="start-full-access">
                  <Icon name="i-warn" size={13} />
                  <span>{t("codeLink.fullAccessWarning")}</span>
                </p>
              )}
            </Field>
          )}

          {general && (
            <Field label={t("codeLink.methodHead")} htmlFor="stMethod">
              <select id="stMethod" className="select" value={playbook} disabled={busy} onChange={(event) => setChosenPlaybook(event.target.value)}>
                {methods.map((entry) => <option key={entry.id} value={entry.id}>{method(entry.id).title}</option>)}
                {!methods.some((entry) => entry.id === playbook) && <option value={playbook}>{method(playbook).title}</option>}
              </select>
              {method(playbook).when && <p className="meta-txt" data-testid="start-method-when">{method(playbook).when}</p>}
              <p className="meta-txt" data-testid="start-recommendation" data-recommended={recommended ?? undefined}>
                {recommending
                  ? t("codeLink.recommending")
                  : recommended && recommendation
                    ? <>
                        {/* a guess from the work type has no reason worth reading; the assistant's does */}
                        {recommendation.source === "llm" ? `${t("codeLink.recommended")} · ${recommendedTitle} — ${recommendation.reason}` : `${t("codeLink.recommendedFallback")} · ${recommendedTitle}`}
                        {recommended !== playbook && <> <button type="button" className="btn btn-ghost" style={{ padding: "0 6px" }} data-testid="start-use-recommendation" disabled={busy} onClick={() => setChosenPlaybook(recommended)}>{t("codeLink.useRecommendation")}</button></>}
                      </>
                    : ""}
              </p>
            </Field>
          )}

          {waitsOn.length > 0 && (
            <Field label={t("codeLink.waitsOnHead")}>
              <ul className="stack-1" data-testid="start-waits-on" style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {waitsOn.map((other) => (
                  <li key={other.id} className="meta-txt">
                    {onOpenIssue
                      ? <button type="button" className="btn btn-ghost num" style={{ padding: "0 4px" }} onClick={() => { onClose(); onOpenIssue(other.key); }}>{other.key}</button>
                      : <span className="num">{other.key}</span>}
                    {` ${other.title} · ${STATUS[other.status].label}`}
                  </li>
                ))}
              </ul>
              <p className="meta-txt">{t("codeLink.waitsOnHint")}</p>
            </Field>
          )}

          {asked && mode === "run" && (
            <div className="start-asked" role="status" data-testid="start-asked">
              <p className="meta-txt">{t("codeLink.askedLede")}</p>
              <blockquote>{asked}</blockquote>
            </div>
          )}

          {start.isPending && <StartProgressNote mode={mode} general={general} branch={latest?.branch || null} />}

          {error && (
            <div role="alert" className="start-problem" data-testid="start-error">
              {error.failure ? (
                (() => {
                  const words = gateWords(error.failure, item.key);
                  return (
                    <>
                      <p className="start-problem-lead">{words.lead}</p>
                      {words.detail && <p className="meta-txt num start-problem-detail">{words.detail}</p>}
                      <StartGateFix
                        projectId={projectId}
                        itemId={item.id}
                        failure={error.failure}
                        onRetry={(allowBlocked, releaseBranch) => submit(allowBlocked, releaseBranch)}
                        onLeave={onClose}
                        onOpenRepositories={onOpenRepositories}
                        onOpenIssue={onOpenIssue}
                        onOpenEngine={(id) => openSettings(id ?? engineId)}
                        onStartFirst={(key) => {
                          const first = items.data?.find((other) => other.key === key);
                          if (first) submit(false, false, { itemId: first.id, key });
                        }}
                      />
                    </>
                  );
                })()
              ) : (
                <p className="start-problem-lead">{error.message}</p>
              )}
            </div>
          )}
        </div>
      </DialogBody>
      <DialogFoot>
        {general && (
          <button type="button" className="btn btn-secondary" data-testid="start-takeover" title={t("codeLink.takeoverHint")} disabled={busy} onClick={() => takeover.mutate()}>
            {t("codeLink.takeover")}
          </button>
        )}
        <span className="spacer" />
        <DialogClose asChild>
          <button type="button" className="btn btn-secondary">{t("common.cancel")}</button>
        </DialogClose>
        {elsewhere ? <span ref={setSendSlot} style={{ display: "contents" }} /> : asked && mode === "run" && threadId ? (
          <button
            type="button"
            className="btn btn-primary"
            data-testid="start-open-thread"
            onClick={() => {
              onClose();
              showThread(threadId);
            }}
          >
            {t("codeLink.openConversation")}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" data-testid="start-confirm" disabled={busy || !engineId || !ready} onClick={() => submit()}>
            {start.isPending ? <><Icon name="i-sync" size={13} className="is-spinning" /> {t("codeLink.starting")}</> : t(continuing ? "codeLink.continueAction" : waitsOn.length ? "codeLink.startAnyway" : "codeLink.startAction")}
          </button>
        )}
      </DialogFoot>
    </Dialog>
  );
}

const Field = ({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) => (
  <div className="field">
    <label htmlFor={htmlFor}>{label}</label>
    {children}
  </div>
);
