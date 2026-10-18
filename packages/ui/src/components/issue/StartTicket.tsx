import type { AgentSettings, EnginePick, PlaybookRecommendation } from "@tomradex/agent";
import type { StartOptions } from "@tomradex/code-link";
import type { Item } from "@tomradex/domain";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { findEngine, methodWords, ticketMethods, useAgentThread, useAgentThreads, useEngines, usePlaybooks } from "~/lib/agent";
import { invoke } from "~/lib/api";
import { onStartRequest, useHerdrStatus, useCodeDeliveries, useCodeSessions, useStartDefaults, useStartTicket } from "~/lib/codeLink";
import { StartGateFix, useGateWords, type StartFailure } from "./StartGateFix";
import { useI18n } from "~/lib/i18n";
import { engineStateLabel } from "~/lib/localCli";
import { useHintToast } from "~/lib/onboarding";
import { STATUS } from "~/lib/domain";
import { invalidateWorkspace, useItems, useSettings } from "~/lib/queries";
import { readableError, useToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { Icon } from "~/components/icons";
import { useAgentDock } from "~/components/chrome/ProjectShell";
import { Dialog, DialogBody, DialogClose, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { isFullAccess, permissionHint, permissionLabel } from "~/lib/codeLink";

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
  useEffect(
    () =>
      onStartRequest(item.id, (mode) => {
        setRequested(mode);
        setOpen(true);
      }),
    [item.id]
  );
  const sessions = useCodeSessions(projectId, item.id);
  const deliveries = useCodeDeliveries(projectId, item.id);
  const engines = useEngines();
  const startable = item.kind === "ticket" && item.status !== "done" && item.status !== "cancelled";
  // Pointed out the first time it could actually run: a local agent is ready to take the ticket.
  useHintToast("hint.start", startable && !!engines.data?.some((e) => e.ok && e.capabilities.some((c) => c === "code" || c === "general")), "onboarding.startHint");
  if (!startable) return null;
  const active = deliveries.data?.find((delivery) => delivery.state === "active");
  const hasSession = !!active && !!sessions.data?.some((session) => session.delivery === active.sequence);
  return (
    <>
      <button type="button" className={cn("btn btn-primary", className)} data-testid="start-ticket" onClick={() => setOpen(true)}>
        {t(hasSession ? "codeLink.continue" : "codeLink.start")}
      </button>
      {open && (
        <StartTicketDialog
          {...props}
          requested={requested}
          onClose={() => {
            setOpen(false);
            setRequested(null);
          }}
        />
      )}
    </>
  );
}

function StartTicketDialog({ projectId, item, onOpenIssue, onOpenRepositories, onClose, requested }: StartTicketProps & { onClose: () => void; requested?: "run" | "terminal" | null }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const { showThread, openSettings } = useAgentDock();
  const general = item.workType === "general";
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
  const [chosenMode, setChosenMode] = useState<StartOptions["mode"] | null>(requested ?? null);
  const mode: StartOptions["mode"] = chosenMode ?? ((latest?.mode ?? rememberedStart?.mode) === "terminal" ? "terminal" : "run");
  const herdrStatus = useHerdrStatus(mode === "terminal");
  const capability = general ? "general" : "code";
  // An agent Tomrade drives over ACP has no terminal session to open.
  const candidates = useMemo(
    () => (engines.data ?? []).filter((engine) => engine.capabilities.includes(capability) && (mode !== "terminal" || engine.terminal !== false) && (mode === "terminal" || !engine.terminalOnly)),
    [engines.data, capability, mode]
  );
  const otherAllowed = mode === "terminal" && !!otherCommand;
  const [chosenEngine, setChosenEngine] = useState<string | null>(null);
  const lastAgent = latest?.agent ?? thread?.engine ?? rememberedStart?.engine ?? null;
  const remembered = findEngine(candidates, lastAgent)?.id ?? lastAgent;
  const engineId =
    chosenEngine && (candidates.some((engine) => engine.id === chosenEngine) || (chosenEngine === "other" && otherAllowed))
      ? chosenEngine
      : remembered && (candidates.some((engine) => engine.id === remembered) || (remembered === "other" && otherAllowed))
        ? remembered
        : (candidates.find((engine) => engine.ok) ?? candidates[0])?.id ?? (otherAllowed ? "other" : "");
  const engine = candidates.find((candidate) => candidate.id === engineId);
  const picks = engineId === "other" ? [] : (engine?.picks ?? []);
  const globalOptions = (agentSettings?.engines?.[engineId] ?? {}) as Record<string, unknown>;
  const globalValue = (key: string) => (typeof globalOptions[key] === "string" && globalOptions[key] ? (globalOptions[key] as string) : "");

  // Knobs: the thread's own overrides when it runs on this engine, then what the last start here used, then what the user changes now.
  const [chosenPicks, setChosenPicks] = useState<Record<string, string> | null>(null);
  const threadPicks = useMemo(() => {
    const out: Record<string, string> = {};
    if (thread && thread.engine === engineId) for (const [key, value] of Object.entries(thread.options ?? {})) if (typeof value === "string") out[key] = value;
    else if (rememberedStart && findEngine(candidates, rememberedStart.engine)?.id === engineId) for (const [key, value] of Object.entries(rememberedStart.options ?? {})) if (typeof value === "string") out[key] = value;
    return out;
  }, [thread, engineId, rememberedStart]);
  const pickValues = chosenPicks ?? threadPicks;
  const setPick = (key: string, value: string) => setChosenPicks({ ...pickValues, [key]: value });
  const pickTitle = (pick: EnginePick) => (pick.key === "model" || pick.key === "profile" ? t("agentPanel.modelHead") : pick.key === "effort" ? t("agentPanel.effortHead") : pick.title);

  const permissionModes = !general && mode === "run" ? engine?.permissionModes : undefined;
  const [chosenPermission, setChosenPermission] = useState<string | null>(null);
  const rememberedPermission = thread?.engine === engineId ? thread?.permissionMode : rememberedStart?.engine === engineId ? rememberedStart.permissionMode : null;
  const permissionMode = permissionModes ? (chosenPermission ?? rememberedPermission ?? permissionModes.default) : undefined;

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
      .catch(() => undefined)
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

  const submit = (allowBlocked = waitsOn.length > 0, releaseBranch = false) => {
    setError(null);
    const options: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(pickValues)) if (value) options[key] = value;
    start.mutate(
      { itemId: item.id, mode, engine: engineId, options, ...(general ? { playbook } : {}), ...(permissionMode ? { permissionMode } : {}), ...(allowBlocked ? { allowBlocked } : {}), ...(releaseBranch ? { releaseBranch } : {}) },
      {
        onSuccess: (result) => {
          if (!result.ok) {
            setError({ message: result.message, failure: result });
            return;
          }
          onClose();
          const vars = { key: item.key, branch: result.branch };
          const warning = result.warnings?.join("\n");
          if (result.mode === "run") {
            const started = result.waitingOn ? t("codeLink.waitingToast", { question: result.waitingOn }) : t(result.continued ? "codeLink.continuedToast" : "codeLink.startedToast", vars);
            toast({ body: warning ? `${started}\n${warning}` : started });
            showThread(result.threadId);
          } else if (result.launched) {
            const started = t("codeLink.terminalToast", vars);
            toast({ body: warning ? `${started}\n${warning}` : started });
          } else {
            const command = result.command ?? "";
            toast({ body: warning ? `${command}\n${warning}` : command, actions: [{ label: t("codeLink.copyCommand"), run: () => void navigator.clipboard?.writeText(command).then(() => toast({ body: t("codeLink.commandCopied") })) }] });
          }
        },
        onError: (err) => setError({ message: readableError(err) })
      }
    );
  };

  // opened because a start elsewhere stopped: try once more here, once the agents are known, so the problem shows with its fix
  const retried = useRef(false);
  useEffect(() => {
    if (!requested || retried.current || !engines.data) return;
    retried.current = true;
    submit();
  });

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()} label={title} className="sheet-md">
      <DialogHead title={title} />
      <DialogBody>
        <div className="stack-4" data-testid="start-dialog">
          <Field label={t("codeLink.where")}>
            <div className="seg" role="group" aria-label={t("codeLink.where")} data-testid="start-mode">
              <button type="button" aria-pressed={mode === "run"} onClick={() => setChosenMode("run")}>
                <Icon name="i-plug" size={13} /> {t("codeLink.startHere")}
              </button>
              <button type="button" aria-pressed={mode === "terminal"} onClick={() => setChosenMode("terminal")}>
                <Icon name="i-terminal" size={13} /> {t("codeLink.startTerminal")}
              </button>
            </div>
            <p className="meta-txt">{t(mode === "run" ? (general ? "codeLink.startHereGeneralHint" : "codeLink.startHereHint") : general ? "codeLink.startTerminalGeneralHint" : "codeLink.startTerminalHint")}</p>
            {mode === "terminal" && herdrStatus.data && (
              <p className="meta-txt" role="status" data-testid="start-herdr-status">
                {t(herdrStatus.data === "running" ? "codeLink.herdrRunning" : herdrStatus.data === "notRunning" ? "codeLink.herdrNotRunning" : "codeLink.herdrNotInstalled")}
                {herdrStatus.data !== "running" && <> · {t("codeLink.herdrSetupHint")}</>}
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
            <div className="row" style={{ alignItems: "flex-start", gap: "var(--space-3)" }}>
              {picks.map((pick) => {
                const id = `stPick-${pick.key}`;
                const value = pickValues[pick.key] ?? "";
                const fallback = globalValue(pick.key);
                const defaultLabel = fallback ? `${t("codeLink.defaultOption")} (${pick.choices.find((c) => c.value === fallback)?.label ?? fallback})` : t("codeLink.defaultOption");
                return (
                  <div className="field" style={{ flex: 1 }} key={pick.key}>
                    <label htmlFor={id}>{pickTitle(pick)}</label>
                    {pick.freeText ? (
                      <>
                        <input id={id} className="input" list={`${id}-list`} value={value} placeholder={fallback || t("codeLink.modelPlaceholder")} disabled={busy} onChange={(event) => setPick(pick.key, event.target.value)} />
                        <datalist id={`${id}-list`}>{pick.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label ?? choice.value}</option>)}</datalist>
                      </>
                    ) : (
                      <select id={id} className="select" value={value} disabled={busy} onChange={(event) => setPick(pick.key, event.target.value)}>
                        <option value="">{defaultLabel}</option>
                        {pick.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label ?? choice.value}</option>)}
                        {value && !pick.choices.some((choice) => choice.value === value) && <option value={value}>{value}</option>}
                      </select>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {permissionModes && (
            <Field label={t("codeLink.permissionsHead")} htmlFor="stPermission">
              <select id="stPermission" className="select" value={permissionMode} disabled={busy} onChange={(event) => setChosenPermission(event.target.value)}>
                {permissionModes.choices.map((choice) => <option key={choice.value} value={choice.value}>{permissionLabel(t, choice)}</option>)}
              </select>
              {permissionHint(t, permissionMode) && <p className="meta-txt" data-testid="start-permission-hint">{permissionHint(t, permissionMode)}</p>}
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
        {asked && mode === "run" && threadId ? (
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
            {start.isPending ? t("codeLink.starting") : t(continuing ? "codeLink.continueAction" : waitsOn.length ? "codeLink.startAnyway" : "codeLink.startAction")}
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
