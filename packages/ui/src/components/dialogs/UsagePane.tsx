import { useQuery } from "@tanstack/react-query";
import type { EngineUsage } from "@tomradex/agent";
import { Eyebrow, SectionHead } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { usd } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";

function UsageTable({ rows }: { rows: EngineUsage[] }) {
  const { t } = useI18n();
  if (!rows.length) return <p className="meta-txt">{t("usage.none")}</p>;
  return (
    <table className="usage-table">
      <thead>
        <tr>
          <th>{t("usage.engine")}</th>
          <th className="num">{t("usage.runs")}</th>
          <th className="num">{t("usage.input")}</th>
          <th className="num">{t("usage.output")}</th>
          <th className="num">{t("usage.spend")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.engine} data-engine={r.engine}>
            <td>{r.title}</td>
            <td className="num">{r.runs.toLocaleString()}</td>
            <td className="num">{r.inputTokens.toLocaleString()}</td>
            <td className="num">{r.outputTokens.toLocaleString()}</td>
            <td className="num">{r.costUsd === null ? <span className="meta-txt">{t("usage.unknown")}</span> : usd(r.costUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Runs, tokens and spend per engine — Tomrade's own record, read fresh each time the pane opens. */
export function UsagePane() {
  const { t } = useI18n();
  const usage = useQuery({ queryKey: ["agent", "usage"], queryFn: () => invoke("agent.usage"), staleTime: 0 });
  return (
    <>
      <SectionHead title={t("usage.title")}>{t("usage.lede")}</SectionHead>
      <div className="panel stack-3" data-testid="usage-pane">
        <Eyebrow>{t("usage.today")}</Eyebrow>
        <UsageTable rows={usage.data?.today ?? []} />
        <Eyebrow>{t("usage.week")}</Eyebrow>
        <UsageTable rows={usage.data?.week ?? []} />
        <p className="meta-txt">{t("usage.ticketNote")}</p>
      </div>
    </>
  );
}
