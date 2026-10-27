import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CardAction, FocusRef } from "@tomradex/agent";
import { Icon } from "~/components/icons";
import { PetStage } from "./PetStage";
import { SetupCard } from "./SetupCard";
import { AgentAttachment, readAttachment } from "./AgentAttachment";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "~/lib/api";
import { Kbd, Spacer } from "~/components/ui/atoms";
import { Menu, MenuActionItem, MenuHead, MenuRadioItem } from "~/components/ui/menu";
import { viewIcon } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { firstCodeStep, foldSteps, startBriefId } from "~/lib/steps";
import { conducts, findEngine, useAgentEvents, useAgentThread, useAgentThreads, useAnswer, useArchiveThread, useCancelRun, useDeleteThread, useEngines, useNewThread, useRevertRun, useSend, useSetEngine, useSetWorkstream, useWorkdir, type RunProgress } from "~/lib/agent";
import { keys, useAssistantAccessories, useBoards, useHeldItem, useItems, useSettings } from "~/lib/queries";
import { ATTENTION_KEY, useAttention, type AttentionEntry } from "~/lib/attention";
import { pickChoiceName, pickFallbackName } from "~/lib/engines";
import { engineStateLabel } from "~/lib/localCli";
import { useSetupInTerminal } from "~/lib/setup";
import { openSettingsPane } from "~/lib/settingsHost";
import { readableError, useErrorToast, useToast } from "~/lib/toast";
import { ReportDialog } from "~/components/dialogs/ReportDialog";
import { isCancelKey, isCommitKey, isComposing } from "~/lib/keys";
import { ImGroupShare, QueuedRow, WorkingLine, type Queued } from "./agent-panel/blocks";
import { GUIDE, GuideList, slashCommand, SlashMenu, STARTERS, type SlashCommand, type SlashContext, type Starter } from "./agent-panel/commands";
import { Composer } from "./agent-panel/Composer";
import { STORE } from "./agent-panel/store";
import { ThreadList, useThreadListState } from "./agent-panel/ThreadList";
import { SessionBar, type BarMode } from "./agent-panel/SessionBar";
import { TerminalSession } from "./agent-panel/TerminalSession";
import { sessionBarRows, type BarRow } from "~/lib/sessionBar";
import { useRecentSessions } from "~/lib/codeLink";
import type { SessionView } from "@tomradex/code-link";
import { hits, keyLabel } from "~/lib/keybindings";
import { Transcript } from "./agent-panel/Transcript";
import { useComposerHistory } from "./agent-panel/useComposerHistory";
import { useEngineChoice } from "./agent-panel/useEngineChoice";
import { useSendQueue } from "./agent-panel/useSendQueue";
import { useSlashMenu } from "./agent-panel/useSlashMenu";
import { useThreadSelection } from "./agent-panel/useThreadSelection";

/** What each kind of waiting is called in the queue line. */
const QUEUE_KIND = { permission: "waitQueue.permission", question: "waitQueue.question", waiting: "waitQueue.waiting", stuck: "waitQueue.stuck" } as const;

const MIN_W = 352;
const MAX_W = 924;
/** Until someone drags it: the former ceiling; the CSS max-width still yields to the board on narrow windows. */
const DEFAULT_W = 616;

export function AgentPanel({
  open,
  onToggle,
  projectId,
  boardId = null,
  requestedThread = null,
  focus,
  onOpenSettings,
  onOpenRepositories,
  onOpenIssue
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  projectId: string;
  /** The workstream page the panel is open on, if any: a new thread starts there. */
  boardId?: string | null;
  /** A thread a screen asked to see (a ticket's Start); `at` makes a repeat request for the same id visible. */
  requestedThread?: { id: string; at: number } | null;
  focus: FocusRef[];
  onOpenSettings: (engineId?: string) => void;
  /** Where a workstream's repository is placed on this machine — the way out of "no local checkout". */
  onOpenRepositories?: () => void;
  onOpenIssue: (id: string) => void;
}) {
  const { t } = useI18n();
  const threads = useAgentThreads(projectId);
  const settings = useSettings();
  const itemsQ = useItems(projectId);
  const boardsQ = useBoards(projectId);
  const accessories = useAssistantAccessories();
  const { threadId, choose: chooseThread, clear: clearThread } = useThreadSelection(projectId, threads.data);
  const detail = useAgentThread(projectId, threadId);
  const engines = useEngines();
  const newThread = useNewThread(projectId);
  const archiveThread = useArchiveThread(projectId);
  const deleteThread = useDeleteThread(projectId);
  const setEngine = useSetEngine(projectId);
  const send = useSend(projectId);
  const answer = useAnswer(projectId);
  const cancel = useCancelRun();
  const revert = useRevertRun(projectId, threadId);
  const setWorkstream = useSetWorkstream(projectId);
  // The thread's workstream names its repository; the workdir says whether this machine can run there.
  const threadBoardId = detail.data?.thread.boardId ?? null;
  const pickedBoardId = threadBoardId ?? (threadId ? null : (boardId ?? null));
  const pickedBoard = pickedBoardId ? (boardsQ.data ?? []).find((b) => b.id === pickedBoardId) : undefined;
  const workdir = useWorkdir(projectId, threadId, !!threadBoardId);
  // "finished" is answered by reopening the ticket at send time, not by blocking the composer.
  const workdirProblem = threadBoardId && workdir.data?.code !== "finished" ? (workdir.data?.problem ?? null) : null;

  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const sending = useRef(false);
  // The run the last send started: until the thread shows it, the run before it says nothing about whether to go on.
  const [sentRun, setSentRun] = useState<string | null>(null);
  const slash = useSlashMenu(draft);
  // /help shows the guide at the foot of the conversation it was typed in; nothing is sent
  const [helpIn, setHelpIn] = useState<string | null>(null);
  const history = useComposerHistory(projectId, draft, setDraft);
  // What rides along as "(viewing: …)": follow tracks the screen, pinned holds
  // a snapshot across navigation, off sends nothing. Session state on purpose —
  // the panel never unmounts inside a project, so it survives navigation.
  const [ctxMode, setCtxMode] = useState<"follow" | "pinned" | "off">("follow");
  const [pinnedFocus, setPinnedFocus] = useState<FocusRef[]>([]);
  const [live, setLive] = useState<{ runId: string; text: string } | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  // what agents in this project wait on the person for: a count on the rail, a word in the thread list
  const everyAttention = useAttention();
  const attention = useMemo(() => everyAttention.filter((e) => e.projectId === projectId), [everyAttention, projectId]);
  const attentionOf = new Map(attention.flatMap((e) => (e.threadId ? [[e.threadId, e] as const] : [])));
  const attentionLabel = (e: AttentionEntry) => t(ATTENTION_KEY[e.kind]);
  const threadList = useThreadListState(projectId);
  // Dots until the person asks for cards; a panel left narrow (the default) has no room for them.
  const [barMode, setBarMode] = useState<BarMode>(() => {
    const saved = localStorage.getItem(STORE.sessionBar);
    if (saved === "rail" || saved === "cards") return saved;
    return Number(localStorage.getItem(STORE.width) ?? DEFAULT_W) >= 720 ? "cards" : "rail";
  });
  const chooseBarMode = useCallback((mode: BarMode) => {
    setBarMode(mode);
    localStorage.setItem(STORE.sessionBar, mode);
  }, []);
  const recentSessions = useRecentSessions(projectId, open);
  // A terminal session picked from the bar takes the place of the thread: the same session as the Terminal window's
  // cell, seen from here. Remembered with its project, so another project's panel never shows it.
  const [openSessionIn, setOpenSessionIn] = useState<{ projectId: string; id: string } | null>(null);
  const openSession = openSessionIn?.projectId === projectId ? openSessionIn.id : null;
  const setOpenSession = useCallback((id: string | null) => setOpenSessionIn(id ? { projectId, id } : null), [projectId]);
  // kept once seen, so the view stays while the bar's list moves on without it (it ended a while ago)
  const lastSession = useRef<SessionView | null>(null);
  const shownSession = openSession ? (recentSessions.data?.find((s) => s.id === openSession) ?? (lastSession.current?.id === openSession ? lastSession.current : null)) : null;
  useEffect(() => {
    if (shownSession) lastSession.current = shownSession;
  }, [shownSession]);
  const composer = useRef<HTMLTextAreaElement>(null);
  /** Whether the transcript follows new lines: true until the person scrolls up to read, again once they come back down. */
  const following = useRef(true);
  const panel = useRef<HTMLElement>(null);

  // Tokens arrive faster than frames: what came in between is shown together, at most once a frame.
  const pendingDelta = useRef<{ runId: string; text: string } | null>(null);
  const deltaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushDelta = useCallback(() => {
    deltaTimer.current = null;
    const next = pendingDelta.current;
    pendingDelta.current = null;
    if (next) setLive((prev) => (prev && prev.runId === next.runId ? { runId: next.runId, text: prev.text + next.text } : next));
  }, []);
  const onDelta = useCallback(
    (runId: string, text: string | null) => {
      if (text === null) {
        if (deltaTimer.current) clearTimeout(deltaTimer.current);
        deltaTimer.current = null;
        pendingDelta.current = null;
        setLive(null);
        return;
      }
      const held = pendingDelta.current;
      // Another run's words never join this one's: what is held is shown first.
      if (held && held.runId !== runId) flushDelta();
      pendingDelta.current = pendingDelta.current ? { runId, text: pendingDelta.current.text + text } : { runId, text };
      deltaTimer.current ??= setTimeout(flushDelta, 16);
    },
    [flushDelta]
  );
  useEffect(
    () => () => {
      if (deltaTimer.current) clearTimeout(deltaTimer.current);
    },
    []
  );
  const onProgress = useCallback((next: RunProgress | null) => {
    setProgress((prev) => {
      if (next === null) return null;
      const same = prev?.runId === next.runId ? prev : null;
      // null clears (the tool ended, the retry went through); only an absent field keeps what was there
      return { runId: next.runId, activity: next.activity !== undefined ? next.activity : same?.activity ?? null, retry: next.retry !== undefined ? next.retry : same?.retry ?? null, usage: next.usage ?? same?.usage ?? null };
    });
  }, []);
  useAgentEvents(projectId, threadId, onDelta, onProgress);

  const runningRun = detail.data?.runs.find((r) => r.status === "running");
  const {
    usable, defaultEngine, currentEngineId, engine, noEngineReady,
    permissionModes, selectedPermissionMode, activePermissionMode, permissionLabel, setPermissionMode,
    threadOptions, engineOptions, picks, pickValue, setPick, pickTitle
  } = useEngineChoice({ projectId, threadId, detail: detail.data, engines: engines.data, settings: settings.data, runningRun });
  const busy = !!runningRun || send.isPending || answer.isPending || uploading;
  const archivedNow = !!detail.data?.thread.archived;
  // A done ticket's conversation, brought back by hand: its next message first reopens the ticket.
  // An old one may be outside the renderer's window, and is asked for by id.
  const threadItem = useHeldItem(projectId, itemsQ.data, !archivedNow && !detail.data?.thread.execution ? detail.data?.thread.itemId : null).item;
  const doneTicket = threadItem?.status === "done" ? threadItem : null;
  const [askReopen, setAskReopen] = useState(false);
  const [reopening, setReopening] = useState(false);
  const blocked = !!workdirProblem || archivedNow;
  const pending = detail.data?.pending ?? null;
  // Stable between renders, so a streamed reply re-renders its own line and not every row above it.
  const runs = useMemo(() => new Map((detail.data?.runs ?? []).map((r) => [r.id, r])), [detail.data?.runs]);
  const cards = useMemo(() => new Map((detail.data?.cards ?? []).map((c) => [c.id, c])), [detail.data?.cards]);
  // A troubleshooting thread runs on the troubleshooter's own engine; a new thread from it goes back to the default.
  const doctorThread = detail.data?.thread.surface === "doctor";
  const investigator = doctorThread ? ((detail.data?.thread.options as { investigator?: string } | null | undefined)?.investigator ?? null) : null;
  const [reportFor, setReportFor] = useState<string | null>(null);
  const byKey = useMemo(() => new Map((itemsQ.data ?? []).map((i) => [i.key, i])), [itemsQ.data]);
  // A thread opens on what the panel is showing — the same engine, the same knobs — rather than
  // resetting to the settings default. With no thread there is nothing to carry, so the chips' own
  // value (the default engine) is what the thread gets.
  const openThread = (args: { engine?: string; boardId?: string | null } = {}) =>
    newThread.mutateAsync({ engine: args.engine ?? (doctorThread ? defaultEngine : currentEngineId), boardId: args.boardId === undefined ? boardId : args.boardId, options: doctorThread ? {} : threadOptions });
  const chooseBoard = (next: string | null) => {
    if (busy || next === pickedBoardId) return;
    if (threadId) setWorkstream.mutate({ threadId, boardId: next });
    else void openThread({ boardId: next }).then((th) => pickThread(th.id));
  };
  const mediaCapabilities = useQuery({
    queryKey: keys.agent.mediaCapabilities(currentEngineId, engineOptions, settings.data?.models),
    queryFn: () => invoke("agent.mediaCapabilities", currentEngineId, engineOptions),
    retry: false
  });
  const acceptedMedia = mediaCapabilities.data?.input ?? [];
  const addAttachments = (files: File[]) => {
    if (busy) return;
    if (attachments.length + files.length > 8) { setAttachmentError(t("agentPanel.tooManyAttachments")); return; }
    if (files.some(file => !acceptedMedia.includes(file.type))) { setAttachmentError(t("agentPanel.unsupportedAttachment")); return; }
    if (files.some(file => !file.size || file.size > 32 * 1024 * 1024)) { setAttachmentError(t("agentPanel.attachmentSize")); return; }
    setAttachmentError(null);
    setAttachments(previous => [...previous, ...files]);
  };

  useEffect(() => {
    const saved = localStorage.getItem(STORE.width);
    if (panel.current) panel.current.style.width = `${saved ? Math.min(MAX_W, Math.max(MIN_W, Number(saved))) : DEFAULT_W}px`;
  }, [open]);

  // After layout, so a working line or question that just mounted is inside scrollHeight.
  useEffect(() => {
    const el = scroll.current;
    if (!el || !following.current) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [detail.data?.messages.length, live?.text, runningRun?.id, pending?.question.id]);

  // another thread opens at its newest line
  useEffect(() => {
    following.current = true;
  }, [threadId]);

  // A finished run hands the keyboard back to the composer only when it was the panel's to begin with.
  useEffect(() => {
    if (busy) return;
    const active = document.activeElement;
    if (!active || active === document.body || panel.current?.contains(active)) composer.current?.focus();
  }, [busy]);

  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startW = panel.current?.offsetWidth ?? MIN_W;
    document.body.style.userSelect = "none";
    const onMove = (e: MouseEvent) => {
      const width = Math.min(MAX_W, Math.max(MIN_W, startW + (startX - e.clientX)));
      if (panel.current) panel.current.style.width = `${width}px`;
      localStorage.setItem(STORE.width, String(width));
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const pickThread = (id: string) => {
    if (threadId && id !== threadId) { setAttachments([]); setAttachmentError(null); setAskReopen(false); history.stopBrowsing(); }
    setOpenSession(null);
    chooseThread(id);
  };
  useEffect(() => {
    if (!requestedThread) return;
    setAttachments([]);
    setAttachmentError(null);
    setOpenSession(null);
    chooseThread(requestedThread.id);
  }, [requestedThread, projectId, chooseThread, setOpenSession]);

  // Snapshotted at send time: navigating away mid-run can't change what "this" meant.
  const sendFocus = ctxMode === "off" ? [] : ctxMode === "pinned" ? pinnedFocus : focus;

  /** `queued` sends a waiting message as it was written: its own focus, no attachments, the draft left alone. */
  const doSend = async (text = draft.trim(), queued?: Queued) => {
    const files = queued ? [] : attachments;
    if ((!text && !files.length) || busy || blocked || sending.current) return false;
    if (doneTicket) { setAskReopen(true); return false; }
    if (files.some(file => !acceptedMedia.includes(file.type))) { setAttachmentError(t("agentPanel.unsupportedAttachment")); return false; }
    sending.current = true; setUploading(true); setAttachmentError(null);
    try {
      let target = threadId;
      if (!target) target = (await openThread({ boardId })).id;
      else if (detail.data?.messages.length === 0 && !usable(currentEngineId) && usable(defaultEngine)) await setEngine.mutateAsync({ threadId: target, engineId: defaultEngine });
      pickThread(target);
      const refs = await Promise.all(files.map(async file => invoke("agent.media.upload", projectId, target!, {
        name: file.name, mime: file.type, base64: await readAttachment(file)
      })));
      following.current = true;
      const focusNow = queued ? queued.focus : sendFocus;
      const { runId } = await send.mutateAsync({ threadId: target, text, focus: focusNow.length ? focusNow : undefined, attachments: refs.length ? refs : undefined });
      setSentRun(runId);
      if (!queued) { if (text) history.remember(text); setDraft(""); setAttachments([]); }
      return true;
    } catch (error) { setAttachmentError(readableError(error)); return false; }
    finally { sending.current = false; setUploading(false); }
  };

  const slashContext: SlashContext = {
    newThread: () => {
      // a new conversation leaves a running turn behind only if the person says so
      if (runningRun && !window.confirm(t("agentPanel.slashNewStops"))) return;
      if (runningRun) cancel.mutate(runningRun.id);
      setDraft("");
      void openThread({ boardId }).then((th) => pickThread(th.id));
    },
    help: () => {
      setDraft("");
      following.current = true;
      setHelpIn(threadId ?? "");
    }
  };
  const runSlash = (command: SlashCommand) => {
    slash.setAt(0);
    command.run(slashContext);
  };

  // Waiting messages go on only after a turn that ended well: a stop, a failure or a question holds them.
  const runList = detail.data?.runs ?? [];
  const lastRun = runList[runList.length - 1];
  const caughtUp = !sentRun || runList.some((r) => r.id === sentRun);
  const queueHeld = !lastRun || lastRun.status !== "done" || !!pending || !!doneTicket || blocked;
  const sendQueue = useSendQueue({ projectId, threadId, engine, currentEngineId, runningRun, messages: detail.data?.messages, busy, held: queueHeld, caughtUp, sending, doSend });
  const { queue, steeringNow } = sendQueue;

  const enqueue = () => {
    const text = draft.trim();
    if (!threadId || !text || attachments.length || blocked) return;
    sendQueue.editQueue(threadId, (q) => [...q, { id: crypto.randomUUID(), text, focus: sendFocus }]);
    history.remember(text);
    setDraft("");
  };
  const steerDraft = () => {
    const text = draft.trim();
    if (!threadId || !runningRun || !text || attachments.length || blocked) return;
    history.remember(text);
    setDraft("");
    void sendQueue.steer(threadId, { id: crypto.randomUUID(), text, focus: sendFocus });
  };

  const reopenAndSend = async () => {
    if (!doneTicket || !threadId || reopening) return;
    setReopening(true); setAttachmentError(null);
    try {
      await invoke("items.update", projectId, doneTicket.id, { status: "doing" }, doneTicket.version);
      const result = await invoke("codeLink.start", projectId, doneTicket.id, { mode: "run", engine: detail.data?.thread.engine, threadId, message: draft.trim() });
      if (!result.ok) { setAttachmentError(result.message); return; }
      following.current = true;
      setDraft(""); setAskReopen(false);
      if (result.threadId) pickThread(result.threadId);
    } catch (error) { setAttachmentError(readableError(error)); }
    finally { setReopening(false); }
  };

  // Hidden once anything is typed or attached, so a click never overwrites the user's own words.
  const empty = threadId ? detail.data?.messages.length === 0 : true;
  // The hint about undoing rides on the newest set of changes only.
  const lastChangesId = [...(detail.data?.messages ?? [])].reverse().find((m) => m.block.type === "changes")?.id ?? null;
  const newestLast = [...(detail.data?.messages ?? [])].reverse();
  const folded = useMemo(() => foldSteps(detail.data?.messages ?? []), [detail.data?.messages]);
  // The kickoff brief is machine-written and long: it opens folded, so the person's own exchange stays in view.
  const briefId = useMemo(() => startBriefId(detail.data?.messages ?? [], !!detail.data?.thread.itemId), [detail.data?.messages, detail.data?.thread.itemId]);
  // Chat that turns to code: a rule where the first file is changed, with the ticket it is for when the thread has one.
  const codeStep = useMemo(() => firstCodeStep(detail.data?.messages ?? []), [detail.data?.messages]);
  const codeFrom = useMemo(() => (codeStep ? { id: codeStep, ticket: threadItem?.key ?? null } : null), [codeStep, threadItem?.key]);
  const lastErrorId = newestLast[0]?.block.type === "error" ? newestLast[0].id : null;
  const lastAskedBlock = newestLast.find((m) => m.role === "user" && m.block.type === "text")?.block;
  const lastAsked = lastAskedBlock?.type === "text" ? lastAskedBlock.text : null;
  const starters =
    empty && itemsQ.data && !detail.data?.thread.itemId && !busy && !draft && !attachments.length
      ? STARTERS[itemsQ.data.length ? "backlog" : "fresh"]
      : [];
  const pickStarter = (starter: Starter) => {
    const text = t(starter.prompt ?? starter.label);
    if (!starter.fill) return void doSend(text);
    setDraft(text);
    requestAnimationFrame(() => {
      composer.current?.focus();
      composer.current?.setSelectionRange(text.length, text.length);
    });
  };

  // set further down, once the bar's rows are known: what answering one waiting conversation leads to
  const waitQueue = useRef({ answered: (_key: string) => {} });
  const doAnswer = (questionId: string, value: string | string[]) => {
    if (!threadId || answer.isPending || (busy && pending?.kind !== "permission")) return;
    const key = `thread:${threadId}`;
    answer.mutate({ threadId, questionId, value }, { onSuccess: () => waitQueue.current.answered(key) });
  };
  // rows take callbacks that keep their identity; each reads the latest render's handlers
  const latest = useRef({ doAnswer, revert: revert.mutate, onOpenSettings });
  latest.current = { doAnswer, revert: revert.mutate, onOpenSettings };
  const answerRow = useCallback((questionId: string, value: string | string[]) => latest.current.doAnswer(questionId, value), []);
  const revertRow = useCallback((runId: string) => latest.current.revert(runId), []);
  const settingsRow = useCallback((engineId?: string) => latest.current.onOpenSettings(engineId), []);
  const reportError = useErrorToast();
  const toast = useToast();
  const setupInTerminal = useSetupInTerminal();
  // Only with the troubleshooter plugin on; it opens its own thread about the failure.
  const canTroubleshoot = !!engines.data?.some((e) => e.id === "doctor") && !doctorThread;
  const troubleshoot = (failedThread: string, runId: string | null) =>
    void invoke("doctor.start", projectId, { threadId: failedThread, ...(runId ? { runId } : {}) }).then(({ threadId: id }) => pickThread(id), reportError);
  // Setup's failing agent rows hand the engine and its test error straight to the troubleshooter.
  const troubleshootEngine = (engineId: string, error?: string) =>
    void invoke("doctor.start", projectId, { engineId, ...(error ? { error } : {}) }).then(({ threadId: id }) => pickThread(id), reportError);
  // What a finding's buttons do: the backend worded them, the verbs are the panel's.
  const cardAction = async (action: CardAction, inThread: string, engineId?: string) => {
    try {
      if (action.kind === "install" || action.kind === "sign-in") {
        const started = await setupInTerminal.mutateAsync({ engineId: action.engineId, step: action.kind === "install" ? "install" : "signIn" });
        toast({ body: started.launched ? t("doctor.inTerminal") : t("agentPanel.signInManual", { command: started.command }) });
      } else if (action.kind === "settings") {
        if (!action.pane || !openSettingsPane(action.pane)) onOpenSettings(action.engineId);
      }
      else if (action.kind === "install-plugin") {
        await invoke("community.install", action.pluginId);
        toast({ body: action.done });
      }
      else if (action.kind === "report") setReportFor(inThread);
      else if (action.kind === "investigate" && engineId) await invoke("doctor.investigate", projectId, inThread, engineId);
      else if (action.kind === "say") { if (!busy) await send.mutateAsync({ threadId: inThread, text: action.text }); }
      else if (action.kind === "retry-with" && engineId) {
        const target = await invoke("agent.thread", projectId, action.threadId);
        const asked = [...target.messages].reverse().find((m) => m.role === "user" && m.block.type === "text")?.block;
        await setEngine.mutateAsync({ threadId: action.threadId, engineId });
        pickThread(action.threadId);
        if (asked?.type === "text") await send.mutateAsync({ threadId: action.threadId, text: asked.text });
      }
    } catch (error) {
      reportError(error);
    }
  };
  const actions = useRef({ cardAction, troubleshoot });
  actions.current = { cardAction, troubleshoot };
  const cardActionRow = useCallback((action: CardAction, inThread: string, engineId?: string) => void actions.current.cardAction(action, inThread, engineId), []);
  // Another agent takes the failed message: the thread moves to it, then the message goes again.
  const retryWith = async (engineId: string) => {
    if (!threadId || !lastAsked || busy) return;
    await setEngine.mutateAsync({ threadId, engineId });
    await doSend(lastAsked);
  };
  // A ticket's coding thread stays with agents that can code.
  const needsCode = !!detail.data?.thread.itemId && !!engine?.capabilities.includes("code");
  const retryEngines = useMemo(
    () => (engines.data ?? []).filter((e) => e.ok && !e.terminalOnly && conducts(e) && (!needsCode || e.capabilities.includes("code"))),
    [engines.data, needsCode]
  );
  const transcriptActions = useMemo(
    () => ({ projectId, runs, cards, engines: engines.data, retryEngines, pending, byKey, busy, onOpenIssue, onAnswer: answerRow, onRevert: revertRow, onOpenSettings: settingsRow, onCardAction: cardActionRow }),
    [projectId, runs, cards, engines.data, retryEngines, pending, byKey, busy, onOpenIssue, answerRow, revertRow, settingsRow, cardActionRow]
  );

  const itemsById = useMemo(() => new Map((itemsQ.data ?? []).map((i) => [i.id, i])), [itemsQ.data]);
  const barRows = useMemo(
    () => sessionBarRows({
      threads: threads.data ?? [], sessions: recentSessions.data ?? [], attention, openThreadId: threadId, openSessionId: openSession,
      itemTitle: (id) => itemsById.get(id)?.title ?? null, itemKey: (id) => itemsById.get(id)?.key ?? null
    }),
    [threads.data, recentSessions.data, attention, threadId, openSession, itemsById]
  );
  const showInTerminal = (sessionId: string, terminalApp: string | null) =>
    void invoke("codeLink.showSession", projectId, sessionId).then((shown) => {
      if (!shown) toast({ body: terminalApp ? t("sessionBar.elsewhere", { app: terminalApp.replace(/\.app$/, "") }) : t("sessionBar.notShown") });
    }, reportError);
  const pickBarRow = (row: BarRow) => {
    if (row.threadId) return pickThread(row.threadId);
    if (row.sessionId) setOpenSession(row.sessionId);
  };
  const sessionRow = shownSession ? barRows.find((r) => r.sessionId === shownSession.id) : undefined;
  // ── what waits on the person besides what is open: a line on top, and once one is answered the next comes up ──
  const currentKey = openSession ? `session:${openSession}` : threadId ? `thread:${threadId}` : null;
  const waitingElsewhere = barRows.filter((r) => r.status === "wait" && r.key !== currentKey);
  const goesOn = (settings.data?.sessions as { afterAnswer?: string } | undefined)?.afterAnswer !== "stay";
  const rowName = (r: BarRow) => r.ticket ?? (r.title || t("agentPanel.newThread"));
  waitQueue.current.answered = (key: string) => {
    if (!goesOn) return;
    const handled = barRows.find((r) => r.key === key);
    const next = waitingElsewhere.find((r) => r.key !== key);
    if (next) {
      pickBarRow(next);
      toast({ body: t("waitQueue.handledNext", { name: handled ? rowName(handled) : "" }) });
    } else toast({ body: t("waitQueue.none") });
  };
  const nextWaiting = () => {
    const next = waitingElsewhere[0];
    if (next) pickBarRow(next);
  };
  const latestNext = useRef(nextWaiting);
  latestNext.current = nextWaiting;
  // ⌥↓ (rebindable) goes to the next waiting one; inside text it moves the caret, so a field with words keeps it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!hits(e, "nextWaiting")) return;
      const field = e.target as HTMLElement | null;
      if ((field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) && field.value) return;
      if (field?.isContentEditable) return;
      e.preventDefault();
      latestNext.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  // the bar is memoized; its handlers keep their identity and read the latest render's state
  const latestBar = useRef({ pickBarRow, newThread: () => {} });
  latestBar.current = { pickBarRow, newThread: () => void openThread({ boardId }).then((th) => pickThread(th.id)) };
  const pickBarRowStable = useCallback((row: BarRow) => latestBar.current.pickBarRow(row), []);
  const newBarThread = useCallback(() => latestBar.current.newThread(), []);
  // ⌘\ swaps the bar between dots and cards wherever the focus is, while the panel is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!hits(e, "sessionBar")) return;
      e.preventDefault();
      chooseBarMode(barMode === "rail" ? "cards" : "rail");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, barMode, chooseBarMode]);

  const archiveThreadById = (id: string) => {
    if (busy) return;
    archiveThread.mutate(id, { onSuccess: () => { if (id === threadId) clearThread(); } });
  };
  const deleteThreadById = (id: string) => {
    if (busy || !window.confirm(t("agentPanel.deleteThreadConfirm"))) return;
    deleteThread.mutate(id, { onSuccess: () => { if (id === threadId) clearThread(); } });
  };

  if (!open) {
    return (
      <div className="rail ai-rail">
        <button type="button" className="btn btn-icon rail-btn" title={t("agentPanel.expandAssistant")} aria-label={t("agentPanel.expandAssistantAria")} onClick={() => onToggle(true)}>
          <Icon name="i-panel" size={15} />
          {attention.length > 0 && (
            <span className="rail-badge num" role="status" title={attention.map(attentionLabel).join(" · ")} aria-label={t("agentPanel.waitingBadge", { n: attention.length })}>
              {attention.length}
            </span>
          )}
        </button>
        <span className="rail-label">{t("agentPanel.assistantLabel")}</span>
      </div>
    );
  }

  return (
    <aside className="ai" ref={panel}>
      <div className="ai-resize" title={t("agentPanel.dragToResize")} onMouseDown={startResize} />
      <div className="ai-head">
        <h2 style={{ fontSize: "var(--text-base)" }}>{t("agentPanel.assistantLabel")}</h2>
        <Spacer />
        <Menu
          label={t("agentPanel.guideTitle")}
          align="end"
          wide
          trigger={
            <button type="button" className="btn btn-icon" title={t("agentPanel.guide")} aria-label={t("agentPanel.guide")}>
              <Icon name="i-keyboard" size={14} />
            </button>
          }
        >
          <MenuHead title={t("agentPanel.guideTitle")} />
          <GuideList />
        </Menu>
        <ThreadList
          state={threadList}
          threads={threads.data}
          threadId={threadId}
          attentionOf={attentionOf}
          attentionLabel={attentionLabel}
          onPick={pickThread}
          onNew={() => void openThread({ boardId }).then((th) => pickThread(th.id))}
          onArchive={archiveThreadById}
          onDelete={deleteThreadById}
        />
        <button type="button" className="btn btn-icon" title={t("agentPanel.collapsePanel")} aria-label={t("agentPanel.collapseAssistantAria")} onClick={() => onToggle(false)}>
          <Icon name="i-panel" size={15} />
        </button>
      </div>

      {waitingElsewhere.length > 0 && (
        <div className="ai-queue" role="status" data-testid="wait-queue">
          <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 0 L10 5 L5 10 L0 5 Z" /></svg>
          <span className="ai-queue-text">{waitingElsewhere.slice(0, 3).map((r) => t(QUEUE_KIND[r.wait?.kind ?? "waiting"], { name: rowName(r) })).join(" · ")}{waitingElsewhere.length > 3 ? ` · ${t("waitQueue.more", { n: waitingElsewhere.length - 3 })}` : ""}</span>
          <button type="button" className="btn btn-secondary btn-xs" data-testid="wait-queue-next" title={t("waitQueue.nextTitle")} onClick={nextWaiting}>
            {t("waitQueue.next")} <Kbd>{keyLabel("nextWaiting")}</Kbd>
          </button>
        </div>
      )}
      {shownSession ? (
        <TerminalSession
          projectId={projectId}
          session={shownSession}
          title={sessionRow?.title ?? shownSession.title ?? (shownSession.itemIds[0] ? itemsById.get(shownSession.itemIds[0])?.title ?? "" : "")}
          ticket={sessionRow?.ticket ?? (shownSession.itemIds[0] ? itemsById.get(shownSession.itemIds[0])?.key ?? null : null)}
          status={sessionRow?.status ?? (shownSession.state === "ended" || shownSession.state === "lost" ? "done" : shownSession.state === "running" ? "run" : "idle")}
          engines={engines.data}
          onShowInTerminal={shownSession.herdrPane || shownSession.state === "ended" || shownSession.state === "lost" ? () => showInTerminal(shownSession.id, shownSession.terminal) : undefined}
          onClose={() => setOpenSession(null)}
          onAnswered={() => waitQueue.current.answered(`session:${shownSession.id}`)}
        />
      ) : (
      <>
      <div
        className="ai-scroll"
        ref={scroll}
        role="log"
        aria-live="polite"
        aria-busy={busy}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {(noEngineReady || (empty && !detail.data?.thread.itemId)) && <SetupCard onOpenSettings={onOpenSettings} onTroubleshoot={canTroubleshoot ? troubleshootEngine : undefined} />}
        {empty && !noEngineReady && (
          <div className="turn turn-ai">
            <div className="turn-mark">
              <span className="prov-tick" style={{ height: 12 }} />
            </div>
            <div className="turn-body">
              <p>{t("agentPanel.introMessage")}</p>
              {!!starters.length && (
                <div className="starters" role="group" aria-label={t("agentPanel.startersAria")}>
                  {starters.map((starter) => (
                    <button key={starter.label} type="button" className="starter" disabled={blocked} title={workdirProblem ?? undefined} onClick={() => pickStarter(starter)}>
                      <Icon name={starter.icon} size={12} />
                      {t(starter.label)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        <Transcript
          actions={transcriptActions}
          folded={folded}
          briefId={briefId}
          codeFrom={codeFrom}
          lastErrorId={lastErrorId}
          lastChangesId={lastChangesId}
          onRetry={lastAsked && !busy ? () => void doSend(lastAsked) : undefined}
          onRetryWith={lastAsked && !busy && threadId ? (engineId) => void retryWith(engineId) : undefined}
          onTroubleshoot={canTroubleshoot && !busy ? (inThread, runId) => actions.current.troubleshoot(inThread, runId) : undefined}
        />
        {live?.text && (
          <div className="turn turn-ai">
            <div className="turn-mark">
              <span className="prov-tick" style={{ height: 12 }} />
            </div>
            <div className="turn-body">
              <p>{live.text}</p>
            </div>
          </div>
        )}
        {helpIn !== null && helpIn === (threadId ?? "") && (
          <div className="turn turn-ai guide-turn">
            <div className="turn-mark">
              <span className="prov-tick" style={{ height: 12 }} />
            </div>
            <div className="turn-body">
              <p className="guide-head">
                {t("agentPanel.guideTitle")}
                <button type="button" className="btn btn-icon" title={t("common.close")} aria-label={t("common.close")} onClick={() => setHelpIn(null)}>
                  <Icon name="i-close" size={11} />
                </button>
              </p>
              <pre className="guide-text">{GUIDE.map((g) => `${g.keys.padEnd(14)}${t(g.text)}`).join("\n")}</pre>
            </div>
          </div>
        )}
        {runningRun && <WorkingLine startedAt={runningRun.startedAt} progress={progress} streaming={!!live} />}
      </div>

      <div className="ai-foot" onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={event => {
        if (event.dataTransfer.files.length) { event.preventDefault(); addAttachments(Array.from(event.dataTransfer.files)); }
      }}>
        {(accessories.data ?? []).map((accessory) => (
          <PetStage key={accessory.id} accessory={accessory} threadId={threadId} />
        ))}
        {threadId && queue.map((entry) => (
          <QueuedRow
            key={entry.id}
            entry={entry}
            held={!runningRun && queueHeld}
            canSend={!busy}
            onSave={(text) => sendQueue.editQueue(threadId, (q) => q.map((x) => (x.id === entry.id ? { ...x, text } : x)))}
            onRemove={() => sendQueue.editQueue(threadId, (q) => q.filter((x) => x.id !== entry.id))}
            onSendNow={() => void sendQueue.sendQueued(threadId, entry)}
            onSteer={runningRun && engine?.steers ? () => void sendQueue.steer(threadId, entry) : undefined}
          />
        ))}
        {steeringNow.map((entry) => (
          <div key={entry.id} className="ai-queued is-steering">
            <span className="q-state">{t("agentPanel.steering")}</span>
            <p className="q-text" title={entry.text}>{entry.text}</p>
          </div>
        ))}
        {slash.pick && <SlashMenu matches={slash.matches} pick={slash.pick} onRun={runSlash} />}
        {threadId && <ImGroupShare projectId={projectId} threadId={threadId} />}
        <Composer
          composer={composer}
          draft={draft}
          placeholder={archivedNow ? t("agentPanel.archivedPlaceholder") : doneTicket ? t("agentPanel.reopenPlaceholder", { key: doneTicket.key }) : pending ? t("agentPanel.answerPlaceholder") : runningRun ? t(engine?.steers ? "agentPanel.queueOrSteerPlaceholder" : "agentPanel.queuePlaceholder") : doctorThread ? t("doctor.placeholder") : t("agentPanel.messagePlaceholder")}
          archived={archivedNow}
          busy={busy}
          canSend={!(busy || blocked || (!draft.trim() && !attachments.length))}
          problem={workdirProblem}
          acceptedMedia={acceptedMedia}
          onChange={(e) => { history.stopBrowsing(); slash.setClosed(false); slash.setAt(0); setDraft(e.target.value); }}
          onAttach={addAttachments}
          onKeyDown={(e) => {
            if (isComposing(e)) return;
            const slashPick = slash.pick;
            if (slashPick) {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                slash.setAt((slash.matches.indexOf(slashPick) + (e.key === "ArrowUp" ? -1 : 1) + slash.matches.length) % slash.matches.length);
                return;
              }
              if (e.key === "Tab") { e.preventDefault(); setDraft(`/${slashPick.name}`); return; }
              if (isCancelKey(e)) { e.preventDefault(); slash.setClosed(true); return; }
              if (isCommitKey(e) && !e.shiftKey) { e.preventDefault(); runSlash(slashPick); return; }
            }
            if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && history.recall(e.currentTarget, e.key === "ArrowUp" ? -1 : 1)) {
              e.preventDefault();
              return;
            }
            // Esc stops the turn like the Stop button; what is queued stays, held
            if (isCancelKey(e) && runningRun) { e.preventDefault(); cancel.mutate(runningRun.id); return; }
            if (!isCommitKey(e) || e.shiftKey) return;
            e.preventDefault();
            const command = slashCommand(draft);
            if (command) runSlash(command);
            else if (runningRun && (e.metaKey || e.ctrlKey)) steerDraft();
            else if (runningRun) enqueue();
            else void doSend();
          }}
          onSend={() => void doSend()}
          onStop={runningRun ? () => cancel.mutate(runningRun.id) : undefined}
        />
        {!!attachments.length && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          {attachments.map((file, index) => <AgentAttachment key={`${file.name}-${index}`} file={file} disabled={busy} remove={() => setAttachments(previous => previous.filter((_, i) => i !== index))} />)}
        </div>}
        {attachmentError && <p className="ai-error" role="alert">{attachmentError}</p>}
        {askReopen && doneTicket && (
          <p className="ai-workdir meta-txt dense" role="alertdialog" style={{ margin: "6px 0 0", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span>{t("agentPanel.reopenAsk", { key: doneTicket.key })}</span>
            <button type="button" className="btn btn-ghost" style={{ padding: "0 6px" }} disabled={reopening} onClick={() => void reopenAndSend()}>{t("agentPanel.reopenAndSend")}</button>
            <button type="button" className="btn btn-ghost" style={{ padding: "0 6px" }} disabled={reopening} onClick={() => setAskReopen(false)}>{t("common.cancel")}</button>
          </p>
        )}
        {archivedNow && threadId && (
          <p className="ai-workdir meta-txt dense" style={{ margin: "6px 0 0", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span>{t("agentPanel.archivedHere")}</span>
            <button type="button" className="btn btn-ghost" style={{ padding: "0 6px" }} disabled={threadList.unarchive.isPending} onClick={() => threadList.unarchive.mutate(threadId)}>
              {t("agentPanel.restoreThread")}
            </button>
          </p>
        )}
        {threadBoardId && (
          <p className={workdirProblem ? "ai-workdir is-problem meta-txt dense" : "ai-workdir meta-txt dense num"} style={{ margin: "6px 0 0", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {workdirProblem ? (
              <>
                <Icon name="i-warn" size={12} style={{ color: "var(--danger)", flexShrink: 0 }} />
                <span style={{ color: "var(--danger)" }}>{t(workdir.data?.code === "no-checkout" ? "agentPanel.noCheckout" : "agentPanel.workdirError")}</span>
                <span title={workdirProblem} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>
                  {workdirProblem}
                </span>
                {onOpenRepositories && (
                  <button type="button" className="btn btn-ghost ai-repos-link" style={{ padding: "0 6px" }} onClick={onOpenRepositories}>
                    {t("agentPanel.repositoriesLink")}
                  </button>
                )}
              </>
            ) : workdir.data?.cwd ? (
              <span title={workdir.data.cwd} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t("agentPanel.runsIn", { path: workdir.data.cwd })}
              </span>
            ) : null}
          </p>
        )}
        <div className="ai-knobs">
          {/* The workstream is one more knob beside the engine's, not a form field: a chip that opens a menu. */}
          <Menu
            label={t("agentPanel.workstreamLabel")}
            align="start"
            trigger={
              <button
                type="button"
                className={`tag chip-btn ai-ws${pickedBoardId ? "" : " is-quiet"}`}
                title={t("agentPanel.workstreamLabel")}
                aria-label={t("agentPanel.workstreamAria")}
                data-board={pickedBoardId ?? ""}
                disabled={busy}
              >
                <Icon name={pickedBoard ? viewIcon(pickedBoard.icon) : "i-stack"} size={11} />
                {pickedBoard?.name ?? t("agentPanel.wholeProject")}
                <Icon name="i-chevdown" size={9} />
              </button>
            }
          >
            <MenuHead title={t("agentPanel.workstreamLabel")} />
            <MenuRadioItem checked={!pickedBoardId} name={t("agentPanel.wholeProject")} onSelect={() => chooseBoard(null)} />
            {(boardsQ.data ?? []).map((b) => (
              <MenuRadioItem key={b.id} checked={b.id === pickedBoardId} name={b.name} onSelect={() => chooseBoard(b.id)} />
            ))}
          </Menu>
          <Menu
            label={t("agentPanel.contextHead")}
            trigger={
              <button type="button" className={`tag chip-btn ctx-chip${ctxMode === "off" || !sendFocus.length ? " is-quiet" : ""}`} title={t("agentPanel.contextChipTitle")}>
                <Icon name="i-monitor" size={11} />
                <span className="ctx-chip-label">
                  {ctxMode === "off" ? t("agentPanel.contextOff") : sendFocus.length ? sendFocus.map((r) => r.key ?? r.title).join(" · ") : t("agentPanel.contextFollow")}
                </span>
                <Icon name="i-chevdown" size={9} />
              </button>
            }
          >
            <MenuHead title={t("agentPanel.contextHead")} />
            <MenuRadioItem
              checked={ctxMode === "follow"}
              name={t("agentPanel.contextFollow")}
              sub={focus.map((r) => r.key ?? r.title).join(" · ") || undefined}
              onSelect={() => setCtxMode("follow")}
            />
            <MenuRadioItem
              checked={ctxMode === "pinned"}
              name={t("agentPanel.contextPin")}
              sub={(ctxMode === "pinned" ? pinnedFocus : focus).map((r) => r.key ?? r.title).join(" · ") || undefined}
              onSelect={() => {
                if (!focus.length && !pinnedFocus.length) return;
                if (focus.length) setPinnedFocus(focus);
                setCtxMode("pinned");
              }}
            />
            <MenuRadioItem checked={ctxMode === "off"} name={t("agentPanel.contextOff")} onSelect={() => setCtxMode("off")} />
          </Menu>
          {doctorThread ? (
            // the troubleshooter conducts its own threads; nothing to switch to here
            <span className="tag" title={t("agentPanel.whoConducts")}>
              {engine?.title ?? currentEngineId}
              {investigator ? ` · ${findEngine(engines.data, investigator)?.title ?? investigator}` : ""}
            </span>
          ) : (
          <Menu
            label={t("agentPanel.engineLabel")}
            align="end"
            // the window does not refetch on focus: a CLI signed in or a model saved meanwhile shows the next time this opens
            onOpenChange={(open) => { if (open) void engines.refetch(); }}
            trigger={
              <button type="button" className="tag chip-btn" title={t("agentPanel.whoConducts")}>
                {engine?.title ?? currentEngineId}
                {engine && !engine.ok && <Icon name="i-warn" size={11} />}
                <Icon name="i-chevdown" size={9} />
              </button>
            }
          >
            <MenuHead title={t("agentPanel.whoDoesWork")} />
            {/* An engine that is not set up, or fails its check, cannot conduct: it is greyed and leads to its Settings row. */}
            {[...(engines.data ?? [])].filter((e) => !e.terminalOnly && conducts(e)).sort((a, b) => Number(b.ok) - Number(a.ok)).map((e) => (
              <MenuRadioItem
                key={e.id}
                checked={e.id === currentEngineId}
                name={e.title}
                sub={e.ok ? undefined : t("agentPanel.engineNotSetUp", { state: engineStateLabel(e, t, t("settingsDialog.engineUnavailable")) })}
                unready={e.ok ? undefined : t("localCli.configure")}
                title={e.ok ? undefined : e.reason}
                onSelect={() => {
                  if (!e.ok) return onOpenSettings(e.need === "model" ? undefined : e.id);
                  if (busy || e.id === currentEngineId) return;
                  if (threadId) setEngine.mutate({ threadId, engineId: e.id });
                  else void openThread({ engine: e.id, boardId }).then((th) => pickThread(th.id));
                }}
              />
            ))}
            <MenuActionItem icon={<Icon name="i-gear" size={13} />} name={t("agentPanel.manageModelsEngines")} onSelect={() => onOpenSettings()} />
          </Menu>
          )}
          {permissionModes && (
            <Menu label={t("agentPanel.permissions")} align="end" trigger={
              <button type="button" className="tag chip-btn" aria-label={t("agentPanel.permissions")} disabled={setPermissionMode.isPending}>
                {permissionLabel(activePermissionMode ?? selectedPermissionMode)}
                <Icon name="i-chevdown" size={9} />
              </button>
            }>
              <MenuHead title={t("agentPanel.permissions")} />
              {permissionModes.choices.map((choice) => (
                <MenuRadioItem key={choice.value} checked={choice.value === selectedPermissionMode} name={choice.label}
                  sub={runningRun && !engine?.liveModes ? t("agentPanel.modeNextTurn") : undefined}
                  onSelect={() => {
                    if (!threadId) return;
                    setPermissionMode.mutate({ threadId, mode: choice.value });
                    if (engine) localStorage.setItem(STORE.permission(engine.id), choice.value);
                  }} />
              ))}
            </Menu>
          )}
          {activePermissionMode && activePermissionMode !== selectedPermissionMode && (
            <span className="meta-txt">{t("agentPanel.modeQueued", { mode: permissionLabel(selectedPermissionMode) ?? "" })}</span>
          )}
          {picks.map((pick) => {
            const current = pickValue(pick);
            const shown = current ? (pick.choices.find((c) => c.value === current)?.label ?? current) : pickTitle(pick);
            return (
              <Menu
                key={pick.key}
                label={pickTitle(pick)}
                align="end"
                trigger={
                  <button type="button" className={`tag chip-btn${current ? "" : " is-quiet"}`} title={pickTitle(pick)}>
                    {shown}
                    <Icon name="i-chevdown" size={9} />
                  </button>
                }
              >
                <MenuHead title={pickTitle(pick)} />
                <MenuRadioItem checked={!current} name={t("agentPanel.pickDefault")} chips={pickFallbackName(t, pick) ? [pickFallbackName(t, pick)!] : undefined} onSelect={() => setPick(pick.key, null)} />
                {pick.choices.map((c) => (
                  <MenuRadioItem key={c.value} checked={c.value === current} name={pickChoiceName(t, pick, c)} chips={c.searchesWeb ? [t("agentPanel.searchesWeb")] : undefined} onSelect={() => setPick(pick.key, c.value)} />
                ))}
                {/* a value typed by hand in settings still shows as what's in charge */}
                {current && !pick.choices.some((c) => c.value === current) && <MenuRadioItem checked name={current} onSelect={() => {}} />}
              </Menu>
            );
          })}
        </div>
      </div>
      </>
      )}
      <SessionBar
        rows={barRows}
        openKey={shownSession ? `session:${shownSession.id}` : threadId ? `thread:${threadId}` : null}
        mode={barMode}
        engines={engines.data}
        onMode={chooseBarMode}
        onPick={pickBarRowStable}
        onNew={newBarThread}
      />
      <ReportDialog projectId={projectId} threadId={reportFor} onOpenChange={(open) => { if (!open) setReportFor(null); }} />
    </aside>
  );
}

export const aiOpenKey = STORE.open;
