import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Tag } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { useHerdrStatus } from "~/lib/codeLink";
import { HERDR_HINT, herdrHintGate, herdrInstallQuery, useHerdrInstall, type HerdrState } from "~/lib/herdr";
import { useI18n } from "~/lib/i18n";
import { useSeen } from "~/lib/onboarding";
import { openExternal } from "~/lib/shell";
import { errorSpec, useToast } from "~/lib/toast";

/** Installs herdr in a terminal the person watches; nothing runs before their click. */
function useInstallHerdr() {
  const { t } = useI18n();
  const toast = useToast();
  return () =>
    invoke("codeLink.installHerdr").then(
      ({ launched, command }) => void toast({ body: launched ? t("setup.terminalOpened") : t("setup.terminalNotOpened", { command }) }),
      (err: unknown) => void toast(errorSpec(err))
    );
}

/** Under Settings' terminal picker on Windows: what Tomrade's own terminal does. */
export function BuiltinTerminalNote() {
  const { t } = useI18n();
  return <div className="meta-txt" data-testid="builtin-terminal-note">{t("codeLink.builtinPitch")}</div>;
}

/** Under Settings' terminal picker: why herdr, and a way to get it while it is missing. */
export function HerdrRecommendation() {
  const { t } = useI18n();
  const status = useHerdrStatus(true);
  const missing = status.data === "notInstalled";
  const plan = useHerdrInstall(missing).data;
  const install = useInstallHerdr();
  const [busy, setBusy] = useState(false);
  return (
    <div className="meta-txt" data-testid="herdr-recommendation">
      <Tag tone="strong">{t("codeLink.herdrRecommended")}</Tag> {t("codeLink.herdrPitch")}
      {missing && plan && (
        <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
          {plan.command ? (
            <>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                data-testid="herdr-install"
                title={plan.command}
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void install().finally(() => setBusy(false));
                }}
              >
                {t("codeLink.herdrInstall")}
              </button>
              {/* What the button runs, in full: without Homebrew it is a script fetched from herdr's site. */}
              <code data-testid="herdr-install-command">{plan.command}</code>
            </>
          ) : (
            <button type="button" className="link-btn" data-testid="herdr-install-guide" onClick={() => openExternal(plan.guide)}>
              {t("codeLink.herdrInstallGuide")} →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const gate = herdrHintGate();

/**
 * After a Start: one sticky toast recommending herdr when the session opened in
 * a plain terminal on a machine without it. Seen once, it stays away for good,
 * on every machine, like the other one-time hints.
 */
export function useHerdrHint() {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const { seen, markSeen } = useSeen();
  const install = useInstallHerdr();
  return (launch: { mode: string; launched: boolean; pane?: string | null }, herdr: HerdrState | undefined) => {
    if (!gate(launch, herdr, seen(HERDR_HINT))) return;
    markSeen(HERDR_HINT);
    void qc
      .fetchQuery(herdrInstallQuery)
      .catch(() => null)
      .then((plan) => {
        const get = plan?.command ? [{ label: t("codeLink.herdrInstall"), run: () => void install() }] : plan ? [{ label: t("codeLink.herdrInstallGuide"), run: () => openExternal(plan.guide) }] : [];
        toast({ body: t("codeLink.herdrPlainLaunch", { pitch: t("codeLink.herdrPitch") }), sticky: true, actions: [...get, { label: t("onboarding.gotIt"), run: () => {} }] });
      });
  };
}
