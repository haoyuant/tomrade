import type { Item } from "@tomrade/domain";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEngines, usePlaybooks } from "~/lib/agent";
import { invoke } from "~/lib/api";
import { invalidateWorkspace } from "~/lib/queries";
import { Icon } from "~/components/icons";
import { useAgentDock } from "~/components/chrome/ProjectShell";
import { Menu, MenuActionItem, MenuHead } from "~/components/ui/menu";
import { useCodeDeliveries, useCodeSessions, useStartTicket } from "~/lib/codeLink";
import { useI18n } from "~/lib/i18n";
import { useToast } from "~/lib/toast";
import { cn } from "~/lib/utils";

/**
 * Start hands the ticket to a local coding agent — headless here, or in the
 * user's own terminal; Continue picks its thread back up. Each gate the start
 * fails answers with the one thing that clears it. Shared by the issue sheet
 * and the docked detail pane, so the button reads the same in both.
 */
function CodingStartTicketMenu({
  projectId,
  item,
  onOpenIssue,
  onOpenRepositories,
  className
}: {
  projectId: string;
  item: Item;
  /** Where a "Open TOM-1" action lands — the bootstrap ticket, by key or id. */
  onOpenIssue?: (idOrKey: string) => void;
  /** Where "Repositories…" lands when the workstream has no repository or this machine no checkout. */
  onOpenRepositories?: () => void;
  className?: string;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const { showThread } = useAgentDock();
  const sessions = useCodeSessions(projectId, item.id);
  const deliveries = useCodeDeliveries(projectId, item.id);
  const start = useStartTicket(projectId);

  const startable = item.kind === "ticket" && item.status !== "done" && item.status !== "cancelled";
  if (!startable || item.workType === "general") return null;
  const active = deliveries.data?.find((delivery) => delivery.state === "active");
  const hasSession = !!active && !!sessions.data?.some((session) => session.delivery === active.sequence);
  const label = start.isPending ? t("codeLink.starting") : t(hasSession ? "codeLink.continue" : "codeLink.start");

  const startTicket = (mode: "run" | "terminal") =>
    start.mutate(
      { itemId: item.id, mode },
      {
        onSuccess: (result) => {
          if (!result.ok) {
            const actions =
              result.gate === "readiness" && result.bootstrapKey && onOpenIssue
                ? [{ label: t("codeLink.gateOpenBootstrap", { key: result.bootstrapKey }), run: () => onOpenIssue(result.bootstrapKey!) }]
                : (result.gate === "checkout" || result.gate === "workstream" || result.gate === "remote") && onOpenRepositories
                  ? [{ label: t("codeLink.gateRepositories"), run: onOpenRepositories }]
                  : undefined;
            toast({ body: result.message, actions });
            return;
          }
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
        onError: (e) => toast({ body: e.message })
      }
    );

  return (
    <Menu
      label={label}
      align="end"
      trigger={
        <button type="button" className={cn("btn btn-primary", className)} data-testid="start-ticket" disabled={start.isPending}>
          {label} <Icon name="i-chevdown" size={12} />
        </button>
      }
    >
      <MenuHead title={item.key} />
      <MenuActionItem icon={<Icon name="i-plug" size={14} />} name={t("codeLink.startHere")} onSelect={() => startTicket("run")} />
      <MenuActionItem icon={<Icon name="i-monitor" size={14} />} name={t("codeLink.startTerminal")} onSelect={() => startTicket("terminal")} />
    </Menu>
  );
}

export function StartTicketMenu(props: Parameters<typeof CodingStartTicketMenu>[0]) {
  return props.item.workType === "general" ? <GeneralStartTicketMenu {...props} /> : <CodingStartTicketMenu {...props} />;
}

function GeneralStartTicketMenu({ projectId, item, className }: Parameters<typeof CodingStartTicketMenu>[0]) {
  const { t } = useI18n();
  const toast = useToast();
  const { showThread } = useAgentDock();
  const qc = useQueryClient();
  const playbooks = usePlaybooks(projectId);
  const engines = useEngines();
  const [engine, setEngine] = useState("");
  const [playbook, setPlaybook] = useState(item.playbookId ?? "");
  useEffect(() => setPlaybook(item.playbookId ?? ""), [item.id, item.playbookId]);
  const savePlaybook = useMutation({
    mutationFn: (next: string) => invoke("items.update", projectId, item.id, { playbookId: next || null }, item.version),
    onSuccess: () => invalidateWorkspace(qc, projectId),
    onError: error => { setPlaybook(item.playbookId ?? ""); toast({ body: error.message }); }
  });
  const start = useMutation({
    mutationFn: () => invoke("agent.startGeneral", projectId, item.id, { ...(playbook ? { playbook } : {}), ...(engine ? { engine } : {}) }),
    onSuccess: result => showThread(result.threadId),
    onError: error => toast({ body: error.message }),
    onSettled: () => { invalidateWorkspace(qc, projectId); void qc.invalidateQueries({ queryKey: ["agent", "threads", projectId] }); }
  });
  const takeover = useMutation({
    mutationFn: () => invoke("agent.takeoverGeneral", projectId, item.id),
    onSuccess: result => toast({ body: t(result.stopped > 0 ? "fields.takeoverReady" : "fields.takeoverNoRun") }),
    onError: error => toast({ body: error.message }),
    onSettled: () => invalidateWorkspace(qc, projectId)
  });
  if (item.kind !== "ticket" || item.status === "done" || item.status === "cancelled") return null;
  return <span className={cn("row", className)}>
    <button type="button" data-testid="start-general" className="btn btn-primary" disabled={start.isPending || takeover.isPending || savePlaybook.isPending} onClick={() => start.mutate()}>
      {start.isPending ? t("codeLink.starting") : t("fields.startGeneral")}
    </button>
    <Menu label={t("fields.executionMethod")} align="end" trigger={<button type="button" data-testid="general-options" className="btn" aria-label={t("fields.executionMethod")}><Icon name="i-chevdown" size={12} /></button>}>
    <div className="stack-3" style={{ padding: "var(--space-3)", width: 280 }}>
    <label className="stack-2">{t("fields.executionMethod")}
    <select className="select" aria-label={t("fields.executionMethod")} value={playbook} onChange={e => { const next = e.target.value; setPlaybook(next); savePlaybook.mutate(next); }} disabled={start.isPending || savePlaybook.isPending}>
      <option value="">{t("fields.defaultMethod")}</option>
      {[...(playbooks.data ?? [])].filter(p => !p.id.startsWith("backlog.") && !p.id.startsWith("code.")).sort((a, b) => Number(!!b.workTypes?.includes("general")) - Number(!!a.workTypes?.includes("general"))).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
    </select>
    </label>
    <label className="stack-2">{t("fields.executionEngine")}
    <select className="select" aria-label={t("fields.executionEngine")} value={engine} onChange={event => setEngine(event.target.value)} disabled={start.isPending || takeover.isPending}>
      <option value="">{t("fields.defaultEngine")}</option>
      {(engines.data ?? []).filter(e => e.capabilities.includes("general")).map(e => <option key={e.id} value={e.id} disabled={!e.ok}>{e.title}</option>)}
    </select>
    </label>
    <button type="button" className="btn btn-secondary" disabled={start.isPending || takeover.isPending || savePlaybook.isPending} onClick={() => takeover.mutate()}>{t("fields.humanTakeover")}</button>
    </div>
    </Menu>
  </span>;
}
