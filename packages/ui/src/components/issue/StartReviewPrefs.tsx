import type { TicketReviewPrefs } from "@tomradex/change-review";
import { useSetTicketReviewPrefs, useTicketReviewPrefs } from "~/lib/changes";
import { useI18n } from "~/lib/i18n";
import { readableError, useToast } from "~/lib/toast";

type Choice = "follow" | "on" | "off";
const choiceOf = (value: boolean | null): Choice => (value === null ? "follow" : value ? "on" : "off");
const valueOf = (choice: string): boolean | null => (choice === "on" ? true : choice === "off" ? false : null);

/**
 * Whether this ticket is reviewed by itself once delivered, and whether the findings go to its agent by themselves:
 * its own word, or Settings › Agent review. Kept the moment it is picked, so it holds whichever way the ticket starts.
 */
export function StartReviewPrefs({ projectId, itemId, disabled }: { projectId: string; itemId: string; disabled?: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const prefs = useTicketReviewPrefs(projectId, itemId);
  const set = useSetTicketReviewPrefs(projectId, itemId);
  if (!prefs.data) return null;
  const { own, machine } = prefs.data;
  const onOff = (value: boolean) => t(value ? "codeLink.settingOn" : "codeLink.settingOff");
  const change = (patch: Partial<TicketReviewPrefs>) => set.mutate(patch, { onError: (error) => toast({ body: readableError(error) }) });
  const busy = disabled || set.isPending;
  return (
    <div className="field" data-testid="start-review-prefs">
      <label>{t("codeLink.reviewHead")}</label>
      <div className="row" style={{ alignItems: "flex-start", gap: "var(--space-3)" }}>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="stReviewAuto">{t("codeLink.reviewAutoLabel")}</label>
          <select id="stReviewAuto" className="select" data-testid="start-review-auto" value={choiceOf(own.autoReview)} disabled={busy} onChange={(event) => change({ autoReview: valueOf(event.target.value) })}>
            <option value="follow">{t("codeLink.reviewFollow", { value: onOff(machine.autoReview) })}</option>
            <option value="on">{t("codeLink.reviewOn")}</option>
            <option value="off">{t("codeLink.reviewOff")}</option>
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="stReviewHandBack">{t("codeLink.reviewHandBackLabel")}</label>
          <select id="stReviewHandBack" className="select" data-testid="start-review-hand-back" value={choiceOf(own.autoHandBack)} disabled={busy} onChange={(event) => change({ autoHandBack: valueOf(event.target.value) })}>
            <option value="follow">{t("codeLink.reviewFollow", { value: onOff(machine.autoHandBack) })}</option>
            <option value="on">{t("codeLink.handBackOn")}</option>
            <option value="off">{t("codeLink.handBackOff")}</option>
          </select>
        </div>
      </div>
      <p className="meta-txt">{t("codeLink.reviewPrefsHint")}</p>
    </div>
  );
}
