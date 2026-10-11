import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { useI18n } from "~/lib/i18n";
import { readableError } from "~/lib/toast";

/**
 * What a screen shows when loading or drawing it failed — a project a newer
 * version wrote, a render that threw — instead of the router's bare English
 * line and no way out but ⌘R.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <div className="route-error" role="alert">
      <h2 className="sec-title">{t("common.routeErrorTitle")}</h2>
      <p className="meta-txt">{t("common.routeErrorLede")}</p>
      <code className="route-error-detail">{readableError(error)}</code>
      <div className="row" style={{ gap: "var(--space-2)" }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            reset();
            void router.invalidate();
          }}
        >
          {t("common.tryAgain")}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            reset();
            void router.navigate({ to: "/" });
          }}
        >
          {t("common.backToProjects")}
        </button>
      </div>
    </div>
  );
}
