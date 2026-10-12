import { useState } from "react";
import type { QuickSetupResult } from "@tomradex/llm";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import { useAdoptDetected, useDetected, useProviders } from "~/lib/setup";
import { SetupProblem } from "./QuickModelSetup";

/** Keys already exported in the person's shell, and models running on this computer: one click each. The key never reaches the page. */
export function DetectedModels() {
  const { t } = useI18n();
  const detected = useDetected();
  const providers = useProviders();
  const adopt = useAdoptDetected();
  const [failed, setFailed] = useState<{ id: string; result: Extract<QuickSetupResult, { ok: false }> } | null>(null);
  const found = detected.data ?? [];
  if (!found.length) return null;
  const titleOf = (preset: string) => providers.data?.find((p) => p.id === preset)?.title ?? preset;

  return (
    <section className="stack-2" data-testid="detected-models">
      <p className="eyebrow">{t("setup.detectedTitle")}</p>
      <ul className="setup-rows">
        {found.map((d) => (
          <li key={d.id} className="setup-row is-ok" data-detected={d.id}>
            <Icon name="i-check" size={13} />
            <div>
              <span className="setup-name">{t(d.source === "env" ? "setup.detectedEnv" : "setup.detectedLocal", { provider: titleOf(d.preset), detail: d.detail })}</span>
              <button
                type="button"
                className="btn btn-primary btn-xs setup-action"
                disabled={adopt.isPending}
                aria-busy={adopt.isPending && adopt.variables === d.id}
                onClick={() => {
                  setFailed(null);
                  adopt.mutate(d.id, { onSuccess: (result) => !result.ok && setFailed({ id: d.id, result }) });
                }}
              >
                {adopt.isPending && adopt.variables === d.id ? t("setup.connecting") : t("setup.use")}
              </button>
              {failed?.id === d.id && <SetupProblem result={failed.result} provider={titleOf(d.preset)} />}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
