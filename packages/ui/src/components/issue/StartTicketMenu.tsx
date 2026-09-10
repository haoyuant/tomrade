import type { Item } from "@tomrade/domain";
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
export function StartTicketMenu({
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
  if (!startable) return null;
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
