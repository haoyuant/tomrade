import { useState } from "react";
import type { DeviceShare, DispatchView } from "@tomradex/dispatch";
import { useAskActions, useAsks, useShareActions, useShares } from "~/lib/devices";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { ROLE_LIMITS } from "~/lib/roles";
import { errorSpec, useToast } from "~/lib/toast";

/** One request from a person this computer is shared with: who, which ticket, and the owner's yes or no. */
export function AskRow({ ask }: { ask: DispatchView }) {
  const { t } = useI18n();
  const toast = useToast();
  const { approve, decline } = useAskActions();
  const busy = approve.isPending || decline.isPending;
  const failed = (error: unknown) => toast(errorSpec(error));
  return (
    <div className="accept-row" data-testid="share-ask">
      <div>
        <div className="accept-name">{t("devices.askLine", { who: ask.fromEmail ?? "", key: ask.key, title: ask.title })}</div>
        <p className="meta-txt">{t("devices.askMeans")}</p>
      </div>
      <button type="button" className="btn btn-ghost" data-testid="share-ask-no" disabled={busy} onClick={() => decline.mutate(ask.id, { onError: failed })}>
        {t("devices.askNo")}
      </button>
      <button type="button" className="btn btn-primary" data-testid="share-ask-yes" disabled={busy} onClick={() => approve.mutate(ask.id, { onError: failed })}>
        {t("devices.askYes")}
      </button>
    </div>
  );
}

/**
 * Sharing this computer with one person at a time: who may send tickets to it, how far theirs may go, and whether
 * each waits for a yes here. Above them, the requests that wait now. Shared on this computer alone, like the
 * switch that lets the account's own computers send it work.
 */
export function ShareComputer() {
  const { t } = useI18n();
  const toast = useToast();
  const shares = useShares();
  const asks = useAsks();
  const { share, unshare } = useShareActions();
  const [email, setEmail] = useState("");
  const busy = share.isPending || unshare.isPending;
  const failed = (error: unknown) => toast(errorSpec(error));
  const save = (next: DeviceShare) => share.mutate(next, { onError: failed });
  const add = () => {
    const address = email.trim();
    if (!address) return;
    share.mutate({ email: address, ceiling: "edits", auto: false }, { onSuccess: () => setEmail(""), onError: failed });
  };
  if (shares.isError) return null;
  const list = shares.data ?? [];
  return (
    <div className="panel accept-work" data-testid="share-computer">
      {(asks.data ?? []).map((ask) => <AskRow key={ask.id} ask={ask} />)}
      <div>
        <div className="accept-name">{t("devices.shareTitle")}</div>
        <p className="meta-txt">{t("devices.shareLede")}</p>
      </div>
      {list.map((s) => (
        <div key={s.email} className="share-person stack-2" data-testid="share-person">
          <div className="accept-row">
            <div className="accept-name">{s.email}</div>
            <select className="input" aria-label={t("devices.shareLimit")} data-testid="share-limit" value={s.ceiling} disabled={busy} onChange={(e) => save({ ...s, ceiling: e.target.value as DeviceShare["ceiling"] })}>
              {ROLE_LIMITS.map((limit) => <option key={limit} value={limit}>{t(`devices.ceiling_${limit}` as MessageKey)}</option>)}
            </select>
            <button type="button" className="btn btn-ghost" data-testid="share-remove" disabled={busy} onClick={() => unshare.mutate(s.email, { onError: failed })}>
              {t("devices.shareRemove")}
            </button>
          </div>
          <label className="accept-check">
            <input type="checkbox" data-testid="share-auto" checked={s.auto} disabled={busy} onChange={() => save({ ...s, auto: !s.auto })} />
            <span>{t("devices.shareAuto")}</span>
          </label>
          {s.auto && <p className="accept-warning" role="note" data-testid="share-auto-warning">{t("devices.shareAutoWarning")}</p>}
        </div>
      ))}
      <form className="accept-row" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className="input" type="email" aria-label={t("devices.shareEmail")} placeholder={t("devices.shareEmail")} data-testid="share-email" value={email} disabled={busy} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1, maxWidth: "none" }} />
        <button type="submit" className="btn btn-secondary" data-testid="share-add" disabled={busy || !email.trim()}>
          {t("devices.shareAdd")}
        </button>
      </form>
      <p className="meta-txt">{t("devices.shareNote")}</p>
    </div>
  );
}
