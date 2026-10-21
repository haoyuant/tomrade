import { useState } from "react";
import type { EngineView } from "@tomradex/agent";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import { useWorkerTest } from "~/lib/setup";
import { builtinProblem, ROUTES, type SetupRoute } from "~/lib/setupState";
import { QuickModelSetup } from "./QuickModelSetup";

type RouteState = "active" | "pending" | "failed";

/**
 * When every agent the person installed failed its test: the ways to start in
 * order, the failed one marked, and the built-in agent offered as the next —
 * a model connected here, its test answered, and setup is done.
 */
export function BuiltinFallback({ failed, engines }: { failed: EngineView[]; engines: EngineView[] }) {
  const { t } = useI18n();
  const { worker, viaProfile, test, pending } = useWorkerTest();
  const [chosen, setChosen] = useState(false);
  const open = chosen || viaProfile;
  const problem = worker ? builtinProblem(engines, worker) : null;
  const builtin: RouteState = problem || test?.ok === false ? "failed" : open ? "active" : "pending";
  const detail = problem
    ? t("setup.builtinCannot", { reason: problem })
    : pending
      ? t("setup.modelTesting", { title: test?.title ?? worker?.title ?? "" })
      : test?.ok === false
        ? t("setup.modelTestFailed", { title: test.title })
        : null;
  const routes: Record<SetupRoute, { state: RouteState; label: string; detail: string | null }> = {
    own: { state: "failed", label: t("setup.routeOwn"), detail: t("setup.routeOwnFailed", { names: failed.map((e) => e.title).join(" · ") }) },
    builtin: { state: builtin, label: t("setup.routeBuiltin"), detail }
  };
  const icon = (state: RouteState) =>
    state === "failed" ? <Icon name="i-warn" size={12} /> : state === "pending" ? <span className="setup-step-dot" /> : <Icon name="i-sync" size={12} />;
  return (
    <div className="stack-3" data-testid="builtin-fallback">
      <ol className="setup-steps" data-testid="setup-routes">
        {ROUTES.map((id) => (
          <li key={id} data-route={id} data-state={routes[id].state}>
            {icon(routes[id].state)}
            <div className="setup-step-body">
              <span>{routes[id].label}</span>
              {routes[id].detail && <span className={routes[id].state === "failed" ? "setup-fix" : "meta-txt"}>{routes[id].detail}</span>}
            </div>
          </li>
        ))}
      </ol>
      {open ? (
        <QuickModelSetup />
      ) : (
        <div>
          <button type="button" className="btn btn-primary btn-sm" data-testid="use-builtin" onClick={() => setChosen(true)}>
            {t("setup.useBuiltin")}
          </button>
        </div>
      )}
    </div>
  );
}
