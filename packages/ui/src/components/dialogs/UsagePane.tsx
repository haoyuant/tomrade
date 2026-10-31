import { useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EngineUsage, UsageDay, UsageTotals } from "@tomradex/agent";
import type { WorkerPurposeUsage, WorkerUsage, WorkerUsageDay, WorkerUsageTotals } from "@tomradex/llm";
import { Eyebrow, SectionHead } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { usd } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { keys } from "~/lib/queries";

const RANGES = [
  { days: 1, label: "usage.rangeToday" as MessageKey },
  { days: 7, label: "usage.rangeWeek" as MessageKey },
  { days: 30, label: "usage.rangeMonth" as MessageKey }
];

const CHART_COLORS = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)",
  "var(--chart-6)", "var(--chart-7)", "var(--chart-8)", "var(--chart-9)", "var(--chart-10)"
];

/** A mark's series colour; the stylesheet lights it into the theme's gradient. */
const series = (index: number): CSSProperties => ({ "--series": CHART_COLORS[index % CHART_COLORS.length] }) as CSSProperties;

const number = (n: number): string => n.toLocaleString();

const compact = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Durations read in the person's own units; a p95 can be hours. */
const duration = (ms: number | null | undefined, locale: string): string => {
  if (ms === null || ms === undefined) return "—";
  const unit = ms < 1000 ? "millisecond" : ms < 60_000 ? "second" : ms < 3_600_000 ? "minute" : "hour";
  const value = unit === "millisecond" ? ms : unit === "second" ? ms / 1000 : unit === "minute" ? ms / 60_000 : ms / 3_600_000;
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow", maximumFractionDigits: value < 10 ? 1 : 0 }).format(value);
};

const dateLabel = (at: number, locale: string): string => new Date(at).toLocaleDateString(locale, { month: "short", day: "numeric" });

const percent = (rate: number | null): string => (rate === null ? "—" : `${Math.round(rate * 100)}%`);

const showDayLabel = (index: number, count: number): boolean => {
  if (count <= 7) return true;
  // Longer ranges name every seventh day; the label is allowed to overflow its column so it stays a date.
  return index === 0 || index % 7 === 0;
};

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="usage-kpi">
      <Eyebrow>{label}</Eyebrow>
      <p className="usage-kpi-value">{value}</p>
      <p className="usage-kpi-sub">{sub}</p>
    </div>
  );
}

function ChartHead({ title, peak }: { title: string; peak?: string }) {
  return (
    <div className="usage-chart-head">
      <span className="usage-chart-title">{title}</span>
      {peak && <span className="usage-peak">{peak}</span>}
    </div>
  );
}

/** One stacked column per local day, bottom-up: new input, cache read, cache write, output. */
function TokenChart({ days }: { days: UsageDay[] }) {
  const { t, locale } = useI18n();
  const max = Math.max(1, ...days.map((d) => d.inputTokens + d.outputTokens));
  const hasRuns = days.some((d) => d.inputTokens + d.outputTokens > 0);
  return (
    <section className="usage-chart-card" aria-label={t("usage.chartTokens")}>
      <ChartHead title={t("usage.chartTokens")} peak={hasRuns ? t("usage.chartPeak", { value: compact(max) }) : undefined} />
      <div className={days.length === 1 ? "usage-plot is-single" : "usage-plot"}>
        {days.map((d) => {
          const total = d.inputTokens + d.outputTokens;
          const title = t("usage.chartDayTitle", {
            date: dateLabel(d.at, locale),
            tokens: number(total),
            new: number(d.uncachedInputTokens),
            read: number(d.cacheReadTokens),
            write: number(d.cacheWriteTokens),
            out: number(d.outputTokens)
          });
          const part = (value: number, cls: string) => (value > 0 ? <span className={`usage-seg ${cls}`} style={{ height: `${(value / max) * 100}%` }} /> : null);
          return (
            <div key={d.date} className={total > 0 ? "usage-col" : "usage-col is-empty"} title={title}>
              {part(d.uncachedInputTokens, "tok-new")}
              {part(d.cacheReadTokens, "tok-read")}
              {part(d.cacheWriteTokens, "tok-write")}
              {part(d.outputTokens, "tok-out")}
            </div>
          );
        })}
      </div>
      <div className="usage-labels" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
        {days.map((d, i) => (
          <span key={d.date}>{showDayLabel(i, days.length) ? dateLabel(d.at, locale) : ""}</span>
        ))}
      </div>
      <div className="usage-chart-foot">
        <div className="usage-legend">
          <span className="usage-legend-item"><i className="usage-swatch tok-new" />{t("usage.legendNew")}</span>
          <span className="usage-legend-item"><i className="usage-swatch tok-read" />{t("usage.legendCacheRead")}</span>
          <span className="usage-legend-item"><i className="usage-swatch tok-write" />{t("usage.legendCacheWrite")}</span>
          <span className="usage-legend-item"><i className="usage-swatch tok-out" />{t("usage.legendOutput")}</span>
        </div>
        <p className="usage-chart-note">{t("usage.chartTokensNote")}</p>
      </div>
    </section>
  );
}

/** Spend per local day, with a hollow mark on days that also had runs no engine priced. */
function SpendChart({ days }: { days: UsageDay[] }) {
  const { t, locale } = useI18n();
  const max = Math.max(1e-9, ...days.map((d) => d.costUsd ?? 0));
  const unknown = days.reduce((sum, d) => sum + d.costUnknownRuns, 0);
  const reported = days.some((d) => d.costKnownRuns > 0);
  return (
    <section className="usage-chart-card" aria-label={t("usage.chartSpend")}>
      <ChartHead title={t("usage.chartSpend")} peak={reported ? t("usage.chartPeak", { value: usd(max) }) : undefined} />
      {reported || unknown ? (
        <>
          <div className={days.length === 1 ? "usage-plot is-single" : "usage-plot"}>
            {days.map((d) => {
              const cost = d.costUsd ?? 0;
              const title = d.costUsd === null
                ? t("usage.chartSpendUnknownTip", { n: d.costUnknownRuns })
                : `${dateLabel(d.at, locale)} · ${usd(cost)}${d.costUnknownRuns > 0 ? ` · ${t("usage.chartSpendUnknownTip", { n: d.costUnknownRuns })}` : ""}`;
              return (
                <div key={d.date} className={`usage-col${cost > 0 ? "" : " is-empty"}`} data-date={d.date} title={title}>
                  {cost > 0 && <span className="usage-seg spend" style={{ height: `${(cost / max) * 100}%` }} />}
                  {d.costUnknownRuns > 0 && <i className="usage-flag" />}
                </div>
              );
            })}
          </div>
          <div className="usage-labels" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
            {days.map((d, i) => (
              <span key={d.date}>{showDayLabel(i, days.length) ? dateLabel(d.at, locale) : ""}</span>
            ))}
          </div>
          <div className="usage-chart-foot">
            <p className="usage-chart-note">{unknown > 0 ? t("usage.chartSpendNote", { unknown }) : t("usage.chartSpendNoteClean")}</p>
          </div>
        </>
      ) : (
        <p className="usage-chart-note">{t("usage.chartSpendNone")}</p>
      )}
    </section>
  );
}

/** The engine's share of one measure, in colours the legend and the table repeat. */
function EngineShares({ engines }: { engines: EngineUsage[] }) {
  const { t } = useI18n();
  if (!engines.length) return null;
  const tokenTotal = engines.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
  const spendTotal = engines.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  const share = (value: number, total: number) => (total > 0 ? (value / total) * 100 : 0);
  const bar = (value: (e: EngineUsage) => number, total: number) => (
    total > 0 ? (
      <div className="usage-share">
        {engines.map((e, i) => {
          const pct = share(value(e), total);
          return pct > 0 ? <span key={e.engine} className="usage-share-seg" style={{ ...series(i), width: `${pct}%` }} title={`${e.title} · ${Math.round(pct)}%`} /> : null;
        })}
      </div>
    ) : <p className="meta-txt">{t("usage.chartShareNone")}</p>
  );
  return (
    <div className="usage-shares">
      <span className="usage-share-label">{t("usage.chartShareTokens")}</span>
      {bar((e) => e.inputTokens + e.outputTokens, tokenTotal)}
      <span className="usage-share-label">{t("usage.chartShareSpend")}</span>
      {bar((e) => e.costUsd ?? 0, spendTotal)}
      <div className="usage-engine-legend">
        {engines.map((e, i) => (
          <span key={e.engine} className="usage-engine-key">
            <i className="usage-swatch" style={series(i)} />
            <span className="usage-engine-name" title={e.title}>{e.title}</span>
            <span className="usage-engine-values">
              {t("usage.engineShareValues", {
                token: Math.round(share(e.inputTokens + e.outputTokens, tokenTotal)),
                spend: Math.round(share(e.costUsd ?? 0, spendTotal))
              })}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function UsageTable({ rows, totals }: { rows: EngineUsage[]; totals: UsageTotals }) {
  const { t, locale } = useI18n();
  if (!rows.length) return <p className="meta-txt">{t("usage.none")}</p>;
  return (
    <div className="usage-table-wrap">
      <table className="usage-table usage-table-wide">
        <thead>
          <tr>
            <th>{t("usage.colEngine")}</th>
            <th className="num">{t("usage.colRuns")}</th>
            <th className="num">{t("usage.colInput")}</th>
            <th className="num">{t("usage.colCache")}</th>
            <th className="num">{t("usage.colOutput")}</th>
            <th className="num">{t("usage.colHit")}</th>
            <th className="num">{t("usage.colTime")}</th>
            <th className="num">{t("usage.colSpend")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.engine} data-engine={r.engine}>
              <td>
                <span className="usage-engine"><i className="usage-swatch" style={series(i)} />{r.title}</span>
                {r.models.length > 0 && <span className="usage-cell-sub">{r.models.map((m) => `${m.model} · ${number(m.runs)}`).join(" · ")}</span>}
              </td>
              <td className="num">{number(r.runs)}{(r.failedRuns > 0 || r.cancelledRuns > 0) && <span className="usage-cell-sub">{[r.failedRuns ? t("usage.failedCount", { n: r.failedRuns }) : "", r.cancelledRuns ? t("usage.cancelledCount", { n: r.cancelledRuns }) : ""].filter(Boolean).join(" · ")}</span>}</td>
              <td className="num">{number(r.inputTokens)}<span className="usage-cell-sub">{t("usage.colNew", { n: number(r.uncachedInputTokens) })}</span></td>
              <td className="num">{t("usage.colCacheValue", { read: compact(r.cacheReadTokens), write: compact(r.cacheWriteTokens) })}</td>
              <td className="num">{number(r.outputTokens)}</td>
              <td className="num">{percent(r.cacheHitRate)}</td>
              <td className="num">{duration(r.duration?.medianMs, locale)}<span className="usage-cell-sub">p95 {duration(r.duration?.p95Ms, locale)}</span></td>
              <td className="num">{r.costUsd === null ? <span className="meta-txt">{t("usage.unknown")}</span> : usd(r.costUsd)}<span className="usage-cell-sub">{t("usage.coverage", { known: r.costKnownRuns, runs: r.runs })}</span></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>{t("usage.total")}</td>
            <td className="num">{number(totals.runs)}</td>
            <td className="num">{number(totals.inputTokens)}</td>
            <td className="num">{t("usage.colCacheValue", { read: compact(totals.cacheReadTokens), write: compact(totals.cacheWriteTokens) })}</td>
            <td className="num">{number(totals.outputTokens)}</td>
            <td className="num">{percent(totals.cacheHitRate)}</td>
            <td className="num">{duration(totals.duration?.medianMs, locale)}<span className="usage-cell-sub">p95 {duration(totals.duration?.p95Ms, locale)}</span></td>
            <td className="num">{totals.costUsd === null ? <span className="meta-txt">{t("usage.unknown")}</span> : usd(totals.costUsd)}<span className="usage-cell-sub">{t("usage.coverage", { known: totals.costKnownRuns, runs: totals.runs })}</span></td>
          </tr>
        </tfoot>
      </table>
    </div>
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

function WorkerCallsChart({ days }: { days: WorkerUsageDay[] }) {
  const { t, locale } = useI18n();
  const max = Math.max(1, ...days.map((d) => d.calls));
  const hasCalls = days.some((d) => d.calls > 0);
  return (
    <section className="usage-chart-card" aria-label={t("usage.workerChartCalls")}>
      <ChartHead title={t("usage.workerChartCalls")} peak={hasCalls ? t("usage.chartPeak", { value: max }) : undefined} />
      <div className={days.length === 1 ? "usage-plot is-single" : "usage-plot"}>
        {days.map((d) => {
          const ok = d.calls - d.failed;
          return (
            <div key={d.date} className={d.calls > 0 ? "usage-col" : "usage-col is-empty"} title={`${dateLabel(d.at, locale)} · ${d.calls}${d.failed ? ` · ${t("usage.failedCount", { n: d.failed })}` : ""}`}>
              {ok > 0 && <span className="usage-seg calls" style={{ height: `${(ok / max) * 100}%` }} />}
              {d.failed > 0 && <span className="usage-seg calls-failed" style={{ height: `${(d.failed / max) * 100}%` }} />}
            </div>
          );
        })}
      </div>
      <div className="usage-labels" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
        {days.map((d, i) => (
          <span key={d.date}>{showDayLabel(i, days.length) ? dateLabel(d.at, locale) : ""}</span>
        ))}
      </div>
      <div className="usage-chart-foot">
        <p className="usage-chart-note">{t("usage.workerChartCallsNote")}</p>
      </div>
    </section>
  );
}

function WorkerPurposes({ rows }: { rows: WorkerPurposeUsage[] }) {
  const { t } = useI18n();
  const max = Math.max(1, ...rows.map((r) => r.calls));
  return (
    <section className="usage-chart-card" aria-label={t("usage.workerChartPurpose")}>
      <ChartHead title={t("usage.workerChartPurpose")} />
      {rows.length ? (
        <div className="usage-purposes">
          {rows.map((r) => (
            <div key={r.purpose ?? "other"} className="usage-purpose-row" data-purpose={r.purpose ?? ""}>
              <span className="usage-purpose-name">{r.purpose && PURPOSES[r.purpose] ? t(PURPOSES[r.purpose]) : t("usage.purposeOther")}</span>
              <div className="usage-purpose-track">
                <span className="usage-purpose-fill" style={{ width: `${((r.calls - r.failed) / max) * 100}%` }} />
                <span className="usage-purpose-fail" style={{ width: `${(r.failed / max) * 100}%` }} />
              </div>
              <span className="usage-purpose-count num">{number(r.calls)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="meta-txt">{t("usage.workerNone")}</p>
      )}
      <div className="usage-chart-foot">
        <p className="usage-chart-note">{t("usage.workerChartPurposeNote")}</p>
      </div>
    </section>
  );
}

function WorkerTable({ rows }: { rows: WorkerUsage[] }) {
  const { t, locale } = useI18n();
  if (!rows.length) return <p className="meta-txt">{t("usage.workerNone")}</p>;
  return (
    <div className="usage-table-wrap">
      <table className="usage-table usage-table-wide">
        <thead>
          <tr>
            <th>{t("usage.source")}</th>
            <th>{t("usage.purpose")}</th>
            <th className="num">{t("usage.calls")}</th>
            <th className="num">{t("usage.input")}</th>
            <th className="num">{t("usage.cacheRead")}</th>
            <th className="num">{t("usage.output")}</th>
            <th className="num">{t("usage.cacheHit")}</th>
            <th className="num">{t("usage.time")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.source} ${r.purpose ?? ""}`} data-source={r.source} data-purpose={r.purpose ?? ""}>
              <td>{r.title}</td>
              <td>{r.purpose && PURPOSES[r.purpose] ? t(PURPOSES[r.purpose]) : t("usage.purposeOther")}</td>
              <td className="num">{number(r.calls)}{r.failed > 0 && <span className="usage-cell-sub">{t("usage.failedCount", { n: r.failed })}</span>}</td>
              <td className="num">{number(r.inputTokens)}</td>
              <td className="num">{number(r.cacheReadTokens)}</td>
              <td className="num">{number(r.outputTokens)}</td>
              <td className="num">{percent(r.cacheHitRate)}</td>
              <td className="num">{duration(r.duration?.medianMs, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkerTotals({ totals }: { totals: WorkerUsageTotals }) {
  const { t, locale } = useI18n();
  const failureRate = totals.calls ? totals.failed / totals.calls : null;
  return (
    <div className="usage-kpis usage-kpis-worker">
      <Kpi label={t("usage.workerKpiCalls")} value={number(totals.calls)} sub={totals.failed ? t("usage.workerKpiCallsSub", { failed: totals.failed }) : t("usage.workerKpiCallsSubClean")} />
      <Kpi label={t("usage.workerKpiFailure")} value={percent(failureRate)} sub={t("usage.workerKpiFailureSub", { failed: totals.failed, calls: totals.calls })} />
      <Kpi label={t("usage.workerKpiCache")} value={percent(totals.cacheHitRate)} sub={t("usage.workerKpiCacheSub")} />
      <Kpi label={t("usage.workerKpiTime")} value={duration(totals.duration?.medianMs, locale)} sub={totals.duration ? t("usage.workerKpiTimeSub", { median: duration(totals.duration.medianMs, locale), p95: duration(totals.duration.p95Ms, locale) }) : t("usage.workerKpiTimeNone")} />
    </div>
  );
}

function WorkerSection({ days }: { days: number }) {
  const { t } = useI18n();
  const worker = useQuery({ queryKey: keys.llm.workerUsage(days), queryFn: () => invoke("llm.workerUsage", days), staleTime: 0 });
  const range = worker.data?.range;
  return (
    <>
      <hr className="rule" />
      <SectionHead title={t("usage.workerTitle")}>{t("usage.workerLede")}</SectionHead>
      <div className="panel usage-dashboard" data-testid="worker-usage">
        {worker.isLoading && <p className="meta-txt">{t("usage.loading")}</p>}
        {worker.isError && <p className="meta-txt">{t("usage.unavailable")}</p>}
        {range && (range.totals.calls === 0 ? <p className="meta-txt">{t("usage.workerNone")}</p> : (
          <>
            <WorkerTotals totals={range.totals} />
            <div className="usage-chart-grid">
              <WorkerCallsChart days={range.days} />
              <WorkerPurposes rows={range.purposes} />
            </div>
            <details className="usage-more" open>
              <summary>{t("usage.workerTable")}</summary>
              <WorkerTable rows={range.sources} />
            </details>
          </>
        ))}
      </div>
    </>
  );
}

/** Runs, tokens and spend over a chosen range — Tomrade's own record, read fresh each time the pane opens. */
export function UsagePane() {
  const { t, locale } = useI18n();
  const [days, setDays] = useState(7);
  const usage = useQuery({ queryKey: keys.agent.usage(days), queryFn: () => invoke("agent.usage", days), staleTime: 0 });
  const range = usage.data?.range;
  const totals = range?.totals;
  return (
    <>
      <SectionHead
        title={t("usage.title")}
        aside={
          <div className="seg quiet usage-range" role="group" aria-label={t("usage.rangeAria")}>
            {RANGES.map((r) => (
              <button key={r.days} type="button" aria-pressed={days === r.days} data-days={r.days} onClick={() => setDays(r.days)}>
                {t(r.label)}
              </button>
            ))}
          </div>
        }
      >
        {t("usage.lede")}
      </SectionHead>
      <div className="panel usage-dashboard" data-testid="usage-pane">
        {usage.isLoading && <p className="meta-txt">{t("usage.loading")}</p>}
        {usage.isError && <p className="meta-txt">{t("usage.unavailable")}</p>}
        {range && totals && (totals.runs === 0 ? <p className="meta-txt">{t("usage.none")}</p> : (
          <>
            <div className="usage-kpis">
              <Kpi
                label={t("usage.kpiSpend")}
                value={totals.costUsd === null ? "—" : usd(totals.costUsd)}
                sub={totals.costKnownRuns ? t("usage.kpiSpendSub", { known: totals.costKnownRuns, runs: totals.runs }) : t("usage.kpiSpendNone")}
              />
              <Kpi
                label={t("usage.kpiTokens")}
                value={compact(totals.inputTokens + totals.outputTokens)}
                sub={t("usage.kpiTokensSub", { input: compact(totals.inputTokens), output: compact(totals.outputTokens) })}
              />
              <Kpi
                label={t("usage.kpiRuns")}
                value={number(totals.runs)}
                sub={totals.failedRuns || totals.cancelledRuns ? t("usage.kpiRunsSub", { failed: totals.failedRuns, cancelled: totals.cancelledRuns }) : t("usage.kpiRunsSubClean")}
              />
              <Kpi
                label={t("usage.kpiTime")}
                value={duration(totals.duration?.medianMs, locale)}
                sub={totals.duration ? t("usage.kpiTimeSub", { median: duration(totals.duration.medianMs, locale), p95: duration(totals.duration.p95Ms, locale) }) : t("usage.kpiTimeNone")}
              />
            </div>
            <div className="usage-chart-grid">
              <TokenChart days={range.days} />
              <SpendChart days={range.days} />
            </div>
            <section className="usage-section">
              <div className="usage-section-head"><span className="usage-section-title">{t("usage.engineTable")}</span></div>
              <EngineShares engines={range.engines} />
            </section>
            <details className="usage-more" open>
              <summary>{t("usage.allNumbers")}</summary>
              <UsageTable rows={range.engines} totals={totals} />
            </details>
            <div className="usage-notes">
              <p className="meta-txt">{t("usage.notCounted")}</p>
              <p className="meta-txt">{t("usage.ticketNote")}</p>
            </div>
          </>
        ))}
      </div>
      <WorkerSection days={days} />
    </>
  );
}
