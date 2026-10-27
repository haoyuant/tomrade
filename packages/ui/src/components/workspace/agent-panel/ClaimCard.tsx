import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";

/** Where a panel conversation's code can go once it turns to writing it: what the claim card offers. */
export interface ClaimOffer {
  /** The conversation's title, the new ticket's name; or the ticket it is on already. */
  title: string;
  ticket: string | null;
  /** The agent a terminal cell would take it up with; null when none can. */
  cli: { id: string; title: string } | null;
  busy: boolean;
  onHere: () => void;
  onBackground: () => void;
  onCli: (engineId: string) => void;
  onClose: () => void;
}

/**
 * Before a panel conversation's first change to a file: claim a ticket and write on its own branch in this
 * conversation's own copy — here, in a conversation of its own under this one, or with a CLI agent in a terminal
 * cell. Closed, it writes on as before.
 */
export function ClaimCard({ offer }: { offer: ClaimOffer }) {
  const { t } = useI18n();
  const what = [
    offer.ticket ? t("claim.onTicket", { key: offer.ticket, title: offer.title }) : t("claim.newTicket", { title: offer.title || t("claim.untitled") }),
    t("claim.ownBranch"),
    t("claim.carries")
  ].join(" · ");
  return (
    <div className="claim-card" data-testid="claim-card" role="group" aria-label={t("claim.head")}>
      <div className="claim-card-top">
        <p className="claim-card-head">{t("claim.head")}</p>
        <button type="button" className="btn btn-icon" data-testid="claim-close" title={t("claim.close")} aria-label={t("claim.close")} onClick={offer.onClose}>
          <Icon name="i-close" size={11} />
        </button>
      </div>
      <p className="claim-card-what meta-txt dense">{what}</p>
      <div className="claim-card-actions">
        <button type="button" className="btn btn-primary btn-xs" data-testid="claim-here" disabled={offer.busy} onClick={offer.onHere}>{t("claim.here")}</button>
        <button type="button" className="btn btn-secondary btn-xs" data-testid="claim-background" disabled={offer.busy} title={t("agentPanel.toBackgroundTitle")} onClick={offer.onBackground}>{t("agentPanel.toBackground")}</button>
        {offer.cli && (
          <button type="button" className="btn btn-secondary btn-xs" data-testid="claim-cli" data-engine={offer.cli.id} disabled={offer.busy} title={t("claim.cliTitle", { agent: offer.cli.title })} onClick={() => offer.onCli(offer.cli!.id)}>
            {t("claim.cli", { agent: offer.cli.title })}
          </button>
        )}
      </div>
    </div>
  );
}
