import { useRef, useState, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import { toPng } from "html-to-image";
import type { Scorecard, ScorecardEngine, ScorecardPr } from "@tomradex/code-link";
import { SectionHead } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { usd } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { keys } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";

const percent = (rate: number | null): string => (rate === null ? "—" : `${Math.round(rate * 100)}%`);

function EngineName({ row }: { row: ScorecardEngine }) {
  const { t } = useI18n();
  return <>{row.engine ? row.title : t("usage.scoreUnknownEngine")}</>;
}

/** Spend per merged PR, or "No data" when the engine priced none — never a zero. */
function Cost({ row }: { row: ScorecardEngine }) {
  const { t } = useI18n();
  return row.costPerPrUsd === null ? <span className="meta-txt">{t("usage.scoreNoData")}</span> : <>{usd(row.costPerPrUsd)}</>;
}

function EngineTable({ card }: { card: Scorecard }) {
  const { t } = useI18n();
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <thead>
          <tr>
            <th>{t("usage.scoreColEngine")}</th>
            <th className="num">{t("usage.scoreColPrs")}</th>
            <th className="num">{t("usage.scoreColFirstPass")}</th>
            <th className="num">{t("usage.scoreColCost")}</th>
          </tr>
        </thead>
        <tbody>
          {card.engines.map((r) => (
            <tr key={r.engine} data-engine={r.engine}>
              <td><EngineName row={r} /></td>
              <td className="num">{r.prs}</td>
              <td className="num">{percent(r.firstPassRate)}<span className="usage-cell-sub">{t("usage.scoreFirstPassSub", { pass: r.firstPass, prs: r.prs })}</span></td>
              <td className="num" data-cost={r.costPerPrUsd ?? "none"}><Cost row={r} /><span className="usage-cell-sub">{t("usage.scoreCostSub", { priced: r.pricedPrs, prs: r.prs })}</span></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>{t("usage.scoreTotal")}</td>
            <td className="num">{card.totals.prs}</td>
            <td className="num">{percent(card.totals.firstPassRate)}<span className="usage-cell-sub">{t("usage.scoreFirstPassSub", { pass: card.totals.firstPass, prs: card.totals.prs })}</span></td>
            <td className="num"><span className="meta-txt">{t("usage.scoreTotalCost")}</span></td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Each pull request the numbers count, so they can be counted again from the tickets and pull requests themselves. */
function Basis({ prs, titles }: { prs: ScorecardPr[]; titles: Map<string, string> }) {
  const { t, locale } = useI18n();
  return (
    <div className="usage-table-wrap">
      <table className="usage-table usage-table-wide">
        <thead>
          <tr>
            <th>{t("usage.scoreBasisTicket")}</th>
            <th>{t("usage.scoreBasisPr")}</th>
            <th>{t("usage.scoreBasisEngine")}</th>
            <th className="num">{t("usage.scoreBasisDelivery")}</th>
            <th>{t("usage.scoreBasisFirstPass")}</th>
            <th className="num">{t("usage.scoreBasisCost")}</th>
          </tr>
        </thead>
        <tbody>
          {prs.map((p) => (
            <tr key={`${p.projectId} ${p.itemId} ${p.repoId} ${p.prNumber ?? p.prUrl}`}>
              <td>{p.itemKey ?? "—"}<span className="usage-cell-sub">{new Date(p.mergedAt).toLocaleDateString(locale, { month: "short", day: "numeric" })}</span></td>
              <td title={p.prUrl ?? undefined}>{p.prNumber !== null ? `#${p.prNumber}` : p.prUrl}</td>
              <td>{p.engine ? (titles.get(p.engine) ?? p.engine) : t("usage.scoreUnknownEngine")}</td>
              <td className="num">{p.delivery}</td>
              <td>{p.firstPass ? t("usage.scoreYes") : t("usage.scoreNo")}</td>
              <td className="num">{p.costUsd === null ? <span className="meta-txt">{t("usage.scoreNoData")}</span> : usd(p.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The picture to share: engines and numbers, and nothing of the project — no names, tickets or code. */
function ShareCard({ card, range, node }: { card: Scorecard; range: string; node: Ref<HTMLDivElement> }) {
  const { t } = useI18n();
  return (
    <div className="score-card-stage" aria-hidden="true">
      <div className="score-card" ref={node}>
        <p className="score-card-brand">Tomrade</p>
        <h2 className="score-card-title">{t("usage.scoreTitle")}</h2>
        <p className="score-card-range">{t("usage.scoreCardRange", { range, prs: card.totals.prs })}</p>
        <div className="score-card-rows">
          {card.engines.map((r) => (
            <div key={r.engine} className="score-card-row">
              <span className="score-card-engine"><EngineName row={r} /></span>
              <span className="score-card-stat">
                <b>{percent(r.firstPassRate)}</b>
                <small>{t("usage.scoreCardFirstPass")} · {t("usage.scoreFirstPassSub", { pass: r.firstPass, prs: r.prs })}</small>
              </span>
              <span className="score-card-stat">
                <b><Cost row={r} /></b>
                <small>{t("usage.scoreCardPerPr")}</small>
              </span>
              <span className="score-card-bar"><i style={{ width: `${Math.round((r.firstPassRate ?? 0) * 100)}%` }} /></span>
            </div>
          ))}
        </div>
        <p className="score-card-note">{t("usage.scoreCardFirstPassNote")}</p>
        <p className="score-card-note">{t("usage.scoreCardCostNote")}</p>
      </div>
    </div>
  );
}

/** First-pass rate and spend per merged pull request, by engine, over the pane's range; exportable as a picture. */
export function ScorecardSection({ days, range }: { days: number; range: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const node = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const score = useQuery({ queryKey: keys.codeLink.scorecard(days), queryFn: () => invoke("codeLink.scorecard", days), staleTime: 0 });
  const card = score.data;
  const titles = new Map(card?.engines.map((e) => [e.engine, e.title]) ?? []);

  const exportImage = async () => {
    if (!node.current) return;
    setExporting(true);
    try {
      const bg = getComputedStyle(node.current).backgroundColor;
      const dataUrl = await toPng(node.current, { pixelRatio: 2, backgroundColor: bg });
      const saved = await invoke("shell.saveImageFile", { title: t("usage.scoreExportTitle"), defaultName: "agent-scorecard.png", dataUrl });
      if (saved) toast({ body: t("usage.scoreExported") });
    } catch (error) {
      toast(errorSpec(error));
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <hr className="rule" />
      <SectionHead
        title={t("usage.scoreTitle")}
        aside={card && card.totals.prs > 0 ? (
          <button type="button" className="btn" disabled={exporting} title={t("usage.scoreExportHint")} data-testid="scorecard-export" onClick={() => void exportImage()}>
            {t("usage.scoreExport")}
          </button>
        ) : undefined}
      >
        {t("usage.scoreLede")}
      </SectionHead>
      <div className="panel usage-dashboard" data-testid="scorecard">
        {score.isLoading && <p className="meta-txt">{t("usage.scoreLoading")}</p>}
        {score.isError && <p className="meta-txt">{t("usage.scoreUnavailable")}</p>}
        {card && (card.totals.prs === 0 ? <p className="meta-txt">{t("usage.scoreNone")}</p> : (
          <>
            <EngineTable card={card} />
            <details className="usage-more">
              <summary>{t("usage.scoreBasis")}</summary>
              <Basis prs={card.prs} titles={titles} />
            </details>
            <div className="usage-notes">
              <p className="meta-txt">{t("usage.scoreFirstPassNote")}</p>
              <p className="meta-txt">{t("usage.scoreCostNote")}</p>
            </div>
            <ShareCard card={card} range={range} node={node} />
          </>
        ))}
      </div>
    </>
  );
}
