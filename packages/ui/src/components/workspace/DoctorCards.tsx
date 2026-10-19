import type { CardAction, ChecklistCard, EngineView, FindingCard } from "@tomradex/agent";
import { Icon, type IconId } from "~/components/icons";
import { Menu, MenuActionItem, MenuHead } from "~/components/ui/menu";
import { useI18n, type MessageKey } from "~/lib/i18n";

type RowState = ChecklistCard["rows"][number]["state"];

const MARK: Record<RowState, IconId> = { pending: "i-clock", running: "i-sync", ok: "i-check", warn: "i-warn", fail: "i-close", skip: "i-chev" };

/** A `checklist` card: each row ticks as it is checked, so a slow test turn is never a frozen screen. */
export function ChecklistBlock({ title, card }: { title: string; card: ChecklistCard }) {
  const { t } = useI18n();
  return (
    <div className="tool-card checklist">
      <div className="tool-head">
        <Icon name="i-bug" size={12} />
        {title}
      </div>
      {card.rows.map((row) => (
        <div className={`tool-row check-row is-${row.state}`} key={row.id}>
          <Icon name={MARK[row.state]} size={12} className={row.state === "running" ? "is-spinning" : undefined} aria-label={t(`doctor.state_${row.state}` as MessageKey)} />
          <span className="check-title">{row.title}</span>
          {row.line && <span className="t-title" title={row.line}>{row.line}</span>}
        </div>
      ))}
    </div>
  );
}

/**
 * A `finding` card: the one thing found, how sure, and buttons for what to do.
 * The backend words every label; the verbs are the panel's own.
 */
export function FindingBlock({ card, engines, allEngines, onAction }: { card: FindingCard; engines: EngineView[]; allEngines: EngineView[]; onAction: (action: CardAction, engineId?: string) => void }) {
  const { t } = useI18n();
  return (
    <div className={`finding is-${card.tone}`} role={card.tone === "fail" ? "alert" : undefined}>
      <p className="finding-head">
        <Icon name={card.tone === "ok" ? "i-check" : "i-warn"} size={13} />
        <span>{card.headline}</span>
        {card.confidence && <span className="tag">{t(`doctor.confidence_${card.confidence}` as MessageKey)}</span>}
      </p>
      {card.body && <p className="finding-body">{card.body}</p>}
      {card.actions.length > 0 && (
        <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
          {card.actions.map((action, i) => {
            if (action.kind === "investigate") {
              // Who reads it, and where what it reads goes, is said before anyone is picked.
              const choices = action.engineIds.flatMap((id) => allEngines.filter((e) => e.id === id && e.ok));
              if (!choices.length) return null;
              return (
                <Menu key={i} label={action.label} wide trigger={
                  <button type="button" className="btn btn-ghost">
                    <Icon name="i-search" size={12} /> {action.label} <Icon name="i-chevdown" size={9} />
                  </button>
                }>
                  <MenuHead title={action.label} />
                  <p className="meta-txt dense menu-note">{action.note}</p>
                  {choices.map((e) => (
                    <MenuActionItem key={e.id} icon={<Icon name="i-search" size={13} />} name={e.title} onSelect={() => onAction(action, e.id)} />
                  ))}
                </Menu>
              );
            }
            if (action.kind !== "retry-with") {
              return (
                <button key={i} type="button" className={`btn ${action.kind === "report" || action.kind === "install-plugin" ? "btn-primary" : "btn-ghost"}`} onClick={() => onAction(action)}>
                  {action.label}
                </button>
              );
            }
            const others = engines.filter((e) => e.id !== action.exclude);
            if (!others.length) return null;
            return (
              <Menu key={i} label={action.label} trigger={
                <button type="button" className="btn btn-ghost">
                  {action.label} <Icon name="i-chevdown" size={9} />
                </button>
              }>
                <MenuHead title={t("agentPanel.retryWithHead")} />
                {others.map((e) => (
                  <MenuActionItem key={e.id} icon={<Icon name="i-send" size={13} />} name={e.title} onSelect={() => onAction(action, e.id)} />
                ))}
              </Menu>
            );
          })}
        </div>
      )}
    </div>
  );
}
