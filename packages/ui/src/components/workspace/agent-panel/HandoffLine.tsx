import type { HandoffRefusal, HandoffView } from "@tomradex/code-link";
import { Icon } from "~/components/icons";
import { useI18n, type MessageKey } from "~/lib/i18n";

const REASON: Record<HandoffRefusal, MessageKey> = {
  builtin: "handoff.reasonBuiltin",
  noSession: "handoff.reasonNoSession",
  running: "handoff.reasonRunning",
  waiting: "handoff.reasonWaiting",
  archived: "handoff.reasonArchived",
  noMcp: "handoff.reasonNoMcp"
};

/**
 * Where the conversation runs, in the panel's foot beside where it works: here, with the way to a terminal cell —
 * or in a terminal cell, with the way to its session and, once its CLI exited, back here. Nothing for an agent
 * that runs only inside Tomrade.
 */
export function HandoffLine({ view, agent, running, busy, transferring, onToTerminal, onShow, onBack }: {
  view: HandoffView;
  /** The agent's name: the thread's engine here, the session's in a terminal. */
  agent: string;
  /** A run is going now, whatever the view said when it was read. */
  running: boolean;
  busy: boolean;
  transferring?: boolean;
  onToTerminal: () => void;
  onShow: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const ghost = { padding: "0 6px" } as const;
  if (view.where === "terminal" && view.terminal) {
    const live = view.terminal.live;
    return (
      <p className="ai-workdir meta-txt dense" data-testid="handoff" data-where="terminal" data-live={live || undefined} style={{ margin: "6px 0 0", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Icon name="i-terminal" size={12} style={{ flexShrink: 0 }} />
        <span>{t(live ? "handoff.inTerminalLive" : "handoff.inTerminalEnded", { agent })}</span>
        <button type="button" className="btn btn-ghost" style={ghost} data-testid="handoff-show" onClick={onShow}>{t("handoff.show")}</button>
        <button type="button" className="btn btn-ghost" style={ghost} data-testid="back-to-panel" disabled={live || busy} title={live ? t("handoff.backBlocked", { agent }) : t("handoff.backTitle")} onClick={onBack}>{t("handoff.back")}</button>
      </p>
    );
  }
  const reason = view.toTerminal.ok ? null : (view.toTerminal.reason ?? "builtin");
  if (reason === "builtin") return null;
  const blocked = reason;
  return (
    <p className="ai-workdir meta-txt dense" data-testid="handoff" data-where="here" style={{ margin: "6px 0 0", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <Icon name="i-terminal" size={12} style={{ flexShrink: 0 }} />
      <span>{agent} · {t("handoff.here")}</span>
      <button type="button" className="btn btn-ghost" style={ghost} data-testid="to-terminal" disabled={!!blocked || busy} title={blocked ? t(REASON[blocked]) : t("handoff.toTerminalTitle")} onClick={onToTerminal}>{t(transferring ? (running ? "handoff.stopping" : "handoff.opening") : running ? "handoff.stopAndTransfer" : "handoff.toTerminal")}</button>
    </p>
  );
}
