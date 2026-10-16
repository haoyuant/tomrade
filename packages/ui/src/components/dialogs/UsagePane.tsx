import { useQuery } from "@tanstack/react-query";
import type { EngineUsage } from "@tomradex/agent";
import type { WorkerUsage } from "@tomradex/llm";
import { Eyebrow, SectionHead } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { usd } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";

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
          <th className="num">{t("usage.uncached")}</th>
          <th className="num">{t("usage.cacheRead")}</th>
          <th className="num">{t("usage.cacheWrite")}</th>
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
            <td className="num">{r.uncachedInputTokens.toLocaleString()}</td>
            <td className="num">{r.cacheReadTokens.toLocaleString()}</td>
            <td className="num">{r.cacheWriteTokens.toLocaleString()}</td>
            <td className="num">{r.outputTokens.toLocaleString()}</td>
            <td className="num">{r.costUsd === null ? <span className="meta-txt">{t("usage.unknown")}</span> : usd(r.costUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const PURPOSES: Record<string, MessageKey> = {
  plan: "usage.purposePlan",
  gaps: "usage.purposeGaps",
  similar: "usage.purposeSimilar",
  dependencies: "usage.purposeDependencies",
  inbox: "usage.purposeInbox",
  playbook: "usage.purposePlaybook",
  branch: "usage.purposeBranch"
};

function WorkerTable({ rows }: { rows: WorkerUsage[] }) {
  const { t } = useI18n();
  if (!rows.length) return <p className="meta-txt">{t("usage.workerNone")}</p>;
  return (
    <table className="usage-table">
      <thead>
        <tr>
          <th>{t("usage.source")}</th>
          <th>{t("usage.purpose")}</th>
          <th className="num">{t("usage.calls")}</th>
          <th className="num">{t("usage.failed")}</th>
          <th className="num">{t("usage.input")}</th>
          <th className="num">{t("usage.cacheRead")}</th>
          <th className="num">{t("usage.output")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.source} ${r.purpose}`} data-source={r.source} data-purpose={r.purpose ?? ""}>
            <td>{r.title}</td>
            <td>{r.purpose && PURPOSES[r.purpose] ? t(PURPOSES[r.purpose]) : t("usage.purposeOther")}</td>
            <td className="num">{r.calls.toLocaleString()}</td>
            <td className="num">{r.failed.toLocaleString()}</td>
            <td className="num">{r.inputTokens.toLocaleString()}</td>
            <td className="num">{r.cacheReadTokens.toLocaleString()}</td>
            <td className="num">{r.outputTokens.toLocaleString()}</td>
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
  const worker = useQuery({ queryKey: ["llm", "workerUsage"], queryFn: () => invoke("llm.workerUsage"), staleTime: 0 });
  return (
    <>
      <SectionHead title={t("usage.title")}>{t("usage.lede")}</SectionHead>
      <div className="panel stack-3" data-testid="usage-pane">
        <Eyebrow>{t("usage.today")}</Eyebrow>
        <UsageTable rows={usage.data?.today ?? []} />
        <Eyebrow>{t("usage.week")}</Eyebrow>
        <UsageTable rows={usage.data?.week ?? []} />
        <p className="meta-txt">{t("usage.notCounted")}</p>
        <p className="meta-txt">{t("usage.ticketNote")}</p>
      </div>
      <SectionHead title={t("usage.workerTitle")}>{t("usage.workerLede")}</SectionHead>
      <div className="panel stack-3" data-testid="worker-usage">
        <Eyebrow>{t("usage.today")}</Eyebrow>
        <WorkerTable rows={worker.data?.today ?? []} />
        <Eyebrow>{t("usage.week")}</Eyebrow>
        <WorkerTable rows={worker.data?.week ?? []} />
      </div>
    </>
  );
}
