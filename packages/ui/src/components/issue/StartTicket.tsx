import type { AgentSettings, EnginePick, PlaybookRecommendation } from "@tomradex/agent";
import type { StartOptions } from "@tomradex/code-link";
import type { Item } from "@tomradex/domain";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ticketMethods, useAgentThread, useAgentThreads, useEngines, usePlaybooks } from "~/lib/agent";
import { invoke } from "~/lib/api";
import { useCodeDeliveries, useCodeSessions, useStartTicket } from "~/lib/codeLink";
import { useI18n } from "~/lib/i18n";
import { STATUS } from "~/lib/domain";
import { invalidateWorkspace, useItems, useSettings } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { Icon } from "~/components/icons";
import { useAgentDock } from "~/components/chrome/ProjectShell";
import { Dialog, DialogBody, DialogClose, DialogFoot, DialogHead } from "~/components/ui/dialog";

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
  const sessions = useCodeSessions(projectId, item.id);
  const deliveries = useCodeDeliveries(projectId, item.id);
  const startable = item.kind === "ticket" && item.status !== "done" && item.status !== "cancelled";
  if (!startable) return null;
  const active = deliveries.data?.find((delivery) => delivery.state === "active");
  const hasSession = !!active && !!sessions.data?.some((session) => session.delivery === active.sequence);
  return (
    <>
      <button type="button" className={cn("btn btn-primary", className)} data-testid="start-ticket" onClick={() => setOpen(true)}>
        {t(hasSession ? "codeLink.continue" : "codeLink.start")}
      </button>
      {open && <StartTicketDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function StartTicketDialog({ projectId, item, onOpenIssue, onOpenRepositories, onClose }: StartTicketProps & { onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const { showThread } = useAgentDock();
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
  const thread = useAgentThread(projectId, threadId).data?.thread ?? null;

  const agentSettings = settings.data?.agent as AgentSettings | undefined;
  const otherCommand = ((settings.data?.codeLink as { otherCommand?: string } | undefined)?.otherCommand ?? "").trim();
  const [chosenMode, setChosenMode] = useState<StartOptions["mode"] | null>(null);
  const mode = chosenMode ?? (latest?.mode === "terminal" ? "terminal" : "run");
  const capability = general ? "general" : "code";
  const candidates = useMemo(() => (engines.data ?? []).filter((engine) => engine.capabilities.includes(capability)), [engines.data, capability]);
  const otherAllowed = mode === "terminal" && !!otherCommand;
  const [chosenEngine, setChosenEngine] = useState<string | null>(null);
  const remembered = latest?.agent ?? thread?.engine ?? null;
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

  // Knobs: the thread's own overrides when it runs on this engine, then whatever the user changes here.
  const [chosenPicks, setChosenPicks] = useState<Record<string, string> | null>(null);
  const threadPicks = useMemo(() => {
    const out: Record<string, string> = {};
    if (thread && thread.engine === engineId) for (const [key, value] of Object.entries(thread.options ?? {})) if (typeof value === "string") out[key] = value;
    return out;
  }, [thread, engineId]);
  const pickValues = chosenPicks ?? threadPicks;
  const setPick = (key: string, value: string) => setChosenPicks({ ...pickValues, [key]: value });
  const pickTitle = (pick: EnginePick) => (pick.key === "model" || pick.key === "profile" ? t("agentPanel.modelHead") : pick.key === "effort" ? t("agentPanel.effortHead") : pick.title);

  const permissionModes = !general && mode === "run" ? engine?.permissionModes : undefined;
  const [chosenPermission, setChosenPermission] = useState<string | null>(null);
  const permissionMode = permissionModes ? (chosenPermission ?? (thread?.engine === engineId ? thread?.permissionMode : null) ?? permissionModes.default) : undefined;

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
  // A method the delivery already runs, or the ticket already names, stays; the recommendation is one click away. A ticket with none takes it.
  const playbook = chosenPlaybook ?? thread?.execution?.playbook.id ?? item.playbookId ?? recommendation?.playbookId ?? "task.assist";
  const recommended = recommendation?.playbookId ?? null;
  const recommendedTitle = recommended ? (methods.find((method) => method.id === recommended)?.title ?? recommended) : null;

  const [error, setError] = useState<{ message: string; action?: { label: string; run: () => void } } | null>(null);
  const takeover = useMutation({
    mutationFn: () => invoke("agent.takeoverGeneral", projectId, item.id),
    onSuccess: (result) => toast({ body: t(result.stopped > 0 ? "fields.takeoverReady" : "fields.takeoverNoRun") }),
    onError: (err) => setError({ message: err.message }),
    onSettled: () => invalidateWorkspace(qc, projectId)
  });

  const continuing = !!latest || !!thread?.execution;
  const title = t(continuing ? "codeLink.continueTitle" : "codeLink.dialogTitle", { key: item.key });
  const ready = engineId === "other" ? true : !!engine?.ok;
  const busy = start.isPending || takeover.isPending;

  const submit = (allowBlocked = waitsOn.length > 0) => {
    setError(null);
    const options: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(pickValues)) if (value) options[key] = value;
    start.mutate(
      { itemId: item.id, mode, engine: engineId, options, ...(general ? { playbook } : {}), ...(permissionMode ? { permissionMode } : {}), ...(allowBlocked ? { allowBlocked } : {}) },
      {
        onSuccess: (result) => {
          if (!result.ok) {
            const action =
              result.gate === "readiness" && result.bootstrapKey && onOpenIssue
                ? { label: t("codeLink.gateOpenBootstrap", { key: result.bootstrapKey }), run: () => { onClose(); onOpenIssue(result.bootstrapKey!); } }
                : (result.gate === "checkout" || result.gate === "workstream" || result.gate === "remote") && onOpenRepositories
                  ? { label: t("codeLink.gateRepositories"), run: () => { onClose(); onOpenRepositories(); } }
                  : result.gate === "blocked"
                    ? { label: t("codeLink.startAnyway"), run: () => submit(true) }
                    : undefined;
            setError({ message: result.message, action });
            return;
          }
          onClose();
          const vars = { key: item.key, branch: result.branch };
          const warning = result.warnings?.join("\n");
          if (result.mode === "run") {
            const started = t(result.continued ? "codeLink.continuedToast" : "codeLink.startedToast", vars);
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
        onError: (err) => setError({ message: err.message })
      }
    );
  };

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
          </Field>

          <Field label={t("codeLink.agentHead")} htmlFor="stEngine">
            <select id="stEngine" className="select" value={engineId} disabled={busy} onChange={(event) => { setChosenEngine(event.target.value); setChosenPicks(null); setChosenPermission(null); }}>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id} disabled={!candidate.ok}>
                  {candidate.title}{candidate.ok ? "" : ` — ${candidate.reason ?? ""}`}
                </option>
              ))}
              {otherAllowed && <option value="other">{t("codeLink.otherAgent")}</option>}
            </select>
            {!candidates.length && !otherAllowed && <p className="meta-txt">{t("codeLink.noAgents")}</p>}
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
                {permissionModes.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              </select>
            </Field>
          )}

          {general && (
            <Field label={t("codeLink.methodHead")} htmlFor="stMethod">
              <select id="stMethod" className="select" value={playbook} disabled={busy} onChange={(event) => setChosenPlaybook(event.target.value)}>
                {methods.map((method) => <option key={method.id} value={method.id}>{method.title}</option>)}
                {!methods.some((method) => method.id === playbook) && <option value={playbook}>{playbook}</option>}
              </select>
              <p className="meta-txt" data-testid="start-recommendation" data-recommended={recommended ?? undefined}>
                {recommending
                  ? t("codeLink.recommending")
                  : recommended && recommendation
                    ? <>
                        {`${t(recommendation.source === "llm" ? "codeLink.recommended" : "codeLink.recommendedFallback")} · ${recommendedTitle} — ${recommendation.reason}`}
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

          {error && (
            <p role="alert" className="meta-txt" style={{ color: "var(--danger)" }} data-testid="start-error">
              {error.message}
              {error.action && <> <button type="button" className="btn btn-ghost" style={{ padding: "0 6px" }} onClick={error.action.run}>{error.action.label}</button></>}
            </p>
          )}
        </div>
      </DialogBody>
      <DialogFoot>
        {general && (
          <button type="button" className="btn btn-secondary" data-testid="start-takeover" disabled={busy} onClick={() => takeover.mutate()}>
            {t("fields.humanTakeover")}
          </button>
        )}
        <span className="spacer" />
        <DialogClose asChild>
          <button type="button" className="btn btn-secondary">{t("common.cancel")}</button>
        </DialogClose>
        <button type="button" className="btn btn-primary" data-testid="start-confirm" disabled={busy || !engineId || !ready} onClick={() => submit()}>
          {start.isPending ? t("codeLink.starting") : t(continuing ? "codeLink.continueAction" : waitsOn.length ? "codeLink.startAnyway" : "codeLink.startAction")}
        </button>
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
