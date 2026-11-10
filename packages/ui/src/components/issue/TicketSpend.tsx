import { useQuery } from "@tanstack/react-query";
import type { UsageTotals } from "@tomradex/agent";
import { Eyebrow } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { usd } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { keys } from "~/lib/queries";

const compact = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** What the agents' runs on this ticket cost, by agent and by delivery. Hidden until something ran in the app. */
export function TicketSpend({ projectId, itemId, variant = "pane" }: { projectId: string; itemId: string; variant?: "pane" | "sheet" }) {
  const { t } = useI18n();
  const spend = useQuery({ queryKey: keys.agent.ticketUsage(projectId, itemId), queryFn: () => invoke("agent.ticketUsage", projectId, itemId), staleTime: 0 });
  const data = spend.data;
  if (!data || data.totals.runs === 0) return null;
  const amount = (r: UsageTotals) => (r.costUsd === null ? t("usage.unknown") : usd(r.costUsd));
  const { totals } = data;
  const deliveries = data.deliveries.filter((d) => d.runs > 0);
  const body = (
    <div className="ticket-spend" data-testid="ticket-spend">
      <p className="meta-txt">{t("usage.spendLine", { amount: amount(totals), runs: totals.runs, tokens: compact(totals.inputTokens + totals.outputTokens) })}</p>
      <p className="meta-txt dense">
        {totals.costKnownRuns ? t("usage.spendCoverage", { known: totals.costKnownRuns, runs: totals.runs }) : t("usage.spendCoverageNone")}
      </p>
      {data.engines.length > 1 && (
        <p className="meta-txt dense" data-testid="ticket-spend-agents">
          {t("usage.spendByAgent")}: {data.engines.map((e) => `${e.title} ${t("usage.spendRow", { amount: amount(e), runs: e.runs })}`).join(" · ")}
        </p>
      )}
      {data.engines.length === 1 && <p className="meta-txt dense" data-testid="ticket-spend-agents">{data.engines[0]!.title}</p>}
      {deliveries.length > 1 && (
        <p className="meta-txt dense" data-testid="ticket-spend-deliveries">
          {t("usage.spendByDelivery")}:{" "}
          {deliveries.map((d) => `${d.sequence === null ? t("usage.spendBeforeDelivery") : t("usage.spendDelivery", { n: d.sequence })} ${t("usage.spendRow", { amount: amount(d), runs: d.runs })}`).join(" · ")}
        </p>
      )}
    </div>
  );
  return variant === "pane" ? (
    <section className="detail-sect">
      <Eyebrow>{t("usage.spendHead")}</Eyebrow>
      {body}
    </section>
  ) : (
    <div>
      <hr className="rule" />
      <Eyebrow style={{ marginBottom: "var(--space-3)" }}>{t("usage.spendHead")}</Eyebrow>
      {body}
    </div>
  );
}
