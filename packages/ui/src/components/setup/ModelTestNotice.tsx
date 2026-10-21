import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import { useWorkerTest } from "~/lib/setup";

/**
 * The worker profile's one-token test as a quiet row: checking while it runs,
 * nothing once it passed, and on a failure the provider's own words with a
 * retry and the way to the model settings. A lent model shows nothing here —
 * its agent's chain already proved it.
 */
export function ModelTestNotice({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  const { viaProfile, test, pending, retest } = useWorkerTest();
  if (!viaProfile) return null;
  if (pending) {
    return (
      <ul className="setup-rows" data-testid="model-test">
        <li className="setup-row" data-state="checking">
          <Icon name="i-sync" size={13} />
          <span className="meta-txt">{t("setup.modelTesting", { title: test?.title ?? "" })}</span>
        </li>
      </ul>
    );
  }
  if (!test || test.ok) return null;
  return (
    <ul className="setup-rows" data-testid="model-test">
      <li className="setup-row" data-state="failed">
        <Icon name="i-warn" size={13} />
        <div>
          <span className="setup-fix" role="alert" data-testid="model-test-error">
            {t("setup.modelTestFailed", { title: test.title })}
          </span>
          {test.detail && (
            <details className="eng-try-details">
              <summary>{t("agentPanel.errorDetails")}</summary>
              <pre>{test.detail}</pre>
            </details>
          )}
          <span className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <button type="button" className="btn btn-secondary btn-xs" data-testid="model-test-retry" onClick={retest}>
              {t("setup.modelTestRetry")}
            </button>
            <button type="button" className="link-btn" onClick={onOpenSettings}>
              {t("setup.modelTestSettings")} →
            </button>
          </span>
        </div>
      </li>
    </ul>
  );
}
