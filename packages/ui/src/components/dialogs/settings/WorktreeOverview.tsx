import type { CSSProperties } from "react";
import type { WorktreeHold } from "@tomradex/code-link";
import { Eyebrow } from "~/components/ui/atoms";
import { WORKTREE_HOLD_KEY, diskSize, removalSummary, useRemoveWorktrees, useWorktreeOverview, useWorktreeSizes, worktreeTotals, type WorktreeBucket } from "~/lib/codeLink";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { readableError, useToast } from "~/lib/toast";

/** Each part keeps its colour wherever it is drawn: the disk's bar, the split, their keys. */
const SERIES: Record<"worktrees" | "other" | WorktreeBucket, string> = {
  worktrees: "var(--chart-1)",
  other: "var(--meta)",
  free: "var(--chart-2)",
  held: "var(--chart-3)",
  open: "var(--chart-4)"
};
const series = (part: keyof typeof SERIES): CSSProperties => ({ "--series": SERIES[part] }) as CSSProperties;

const BUCKETS: WorktreeBucket[] = ["free", "held", "open"];
const BUCKET_KEY: Record<WorktreeBucket, MessageKey> = {
  free: "repositories.overviewBucket_free",
  held: "repositories.overviewBucket_held",
  open: "repositories.overviewBucket_open"
};

const share = (value: number, total: number): number => (total > 0 ? (value / total) * 100 : 0);
const percent = (value: number, total: number): string => {
  const pct = share(value, total);
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
};

function Kpi({ id, label, value, sub }: { id: string; label: string; value: string; sub: string }) {
  return (
    <div className="usage-kpi" data-kpi={id}>
      <Eyebrow>{label}</Eyebrow>
      <p className="usage-kpi-value">{value}</p>
      <p className="usage-kpi-sub">{sub}</p>
    </div>
  );
}

/**
 * Every worktree Tomrade made on this computer, added up: how many, what they take of the disk, how much of that can
 * go now, and which repositories hold it. One press removes the ones nothing would be lost with.
 */
export function WorktreeOverview() {
  const { t } = useI18n();
  const toast = useToast();
  const overview = useWorktreeOverview();
  const groups = overview.data?.groups ?? [];
  const sizes = useWorktreeSizes(groups.flatMap((group) => group.trees.map((tree) => ({ projectId: group.projectId, dir: tree.dir }))), true);
  const remove = useRemoveWorktrees();
  if (!overview.data) return null;

  const totals = worktreeTotals(groups, sizes);
  const disk = overview.data.disk;
  const measuring = totals.measured < totals.count;
  const size = (bytes: number) => (totals.measured === 0 && totals.count > 0 ? "…" : diskSize(bytes));
  const removable = groups.map((group) => ({ projectId: group.projectId, dirs: group.trees.filter((tree) => !tree.hold).map((tree) => tree.dir) })).filter((ask) => ask.dirs.length);
  const most = Math.max(1, ...totals.repos.map((repo) => repo.bytes));
  const otherUsed = disk ? Math.max(0, disk.total - disk.free - totals.bytes) : 0;

  const take = () =>
    remove.mutate(removable, {
      onSuccess: (removals) => {
        const { removed, kept, reason } = removalSummary(removals);
        const why = reason && reason in WORKTREE_HOLD_KEY ? t(WORKTREE_HOLD_KEY[reason as WorktreeHold]) : (reason ?? "");
        toast({ body: kept ? t("repositories.worktreesKeptToast", { n: removed, kept, reason: why }) : t("repositories.worktreesRemovedToast", { n: removed }) });
      },
      onError: (error) => toast({ body: readableError(error) })
    });

  return (
    <div className="panel usage-dashboard worktree-overview" data-testid="worktree-overview">
      <div className="usage-kpis">
        <Kpi id="count" label={t("repositories.overviewWorktrees")} value={String(totals.count)} sub={t("repositories.overviewWorktreesSub", { n: totals.repos.length })} />
        <Kpi
          id="taken"
          label={t("repositories.overviewTaken")}
          value={size(totals.bytes)}
          sub={measuring ? t("repositories.overviewMeasuring", { done: totals.measured, n: totals.count }) : disk ? t("repositories.overviewTakenSub", { pct: percent(totals.bytes, disk.total) }) : ""}
        />
        <Kpi id="free" label={t("repositories.overviewFree")} value={size(totals.buckets.free.bytes)} sub={t("repositories.overviewFreeSub", { n: totals.buckets.free.n })} />
        <Kpi id="disk" label={t("repositories.overviewDiskFree")} value={disk ? diskSize(disk.free) : "—"} sub={disk ? t("repositories.overviewDiskFreeSub", { total: diskSize(disk.total) }) : ""} />
      </div>

      {totals.count === 0 ? (
        <p className="usage-chart-note">{t("repositories.worktreesNone")}</p>
      ) : (
        <>
          <div className="usage-shares">
            {disk && (
              <>
                <span className="usage-share-label">{t("repositories.overviewDiskBar")}</span>
                <div className="usage-share" data-bar="disk" role="img" aria-label={t("repositories.overviewDiskBarAria", { worktrees: diskSize(totals.bytes), other: diskSize(otherUsed), free: diskSize(disk.free) })}>
                  <span className="usage-share-seg" style={{ ...series("worktrees"), width: `${share(totals.bytes, disk.total)}%` }} title={`${t("repositories.overviewWorktrees")} · ${diskSize(totals.bytes)} · ${percent(totals.bytes, disk.total)}`} />
                  <span className="usage-share-seg worktree-other" style={{ ...series("other"), width: `${share(otherUsed, disk.total)}%` }} title={`${t("repositories.overviewDiskOther")} · ${diskSize(otherUsed)} · ${percent(otherUsed, disk.total)}`} />
                </div>
                <div className="usage-engine-legend" data-legend="disk">
                  <span className="usage-engine-key">
                    <i className="usage-swatch" style={series("worktrees")} />
                    <span className="usage-engine-name">{t("repositories.overviewWorktrees")}</span>
                    <span className="usage-engine-values">{size(totals.bytes)}</span>
                  </span>
                  <span className="usage-engine-key">
                    <i className="usage-swatch worktree-other" style={series("other")} />
                    <span className="usage-engine-name">{t("repositories.overviewDiskOther")}</span>
                    <span className="usage-engine-values">{diskSize(otherUsed)}</span>
                  </span>
                  <span className="usage-engine-key">
                    <i className="usage-swatch worktree-free" />
                    <span className="usage-engine-name">{t("repositories.overviewDiskFree")}</span>
                    <span className="usage-engine-values">{diskSize(disk.free)}</span>
                  </span>
                </div>
              </>
            )}
            <span className="usage-share-label">{t("repositories.overviewSplit")}</span>
            <div className="usage-share" data-bar="split">
              {BUCKETS.map((bucket) =>
                totals.buckets[bucket].bytes > 0 ? (
                  <span
                    key={bucket}
                    className="usage-share-seg"
                    data-bucket={bucket}
                    style={{ ...series(bucket), width: `${share(totals.buckets[bucket].bytes, totals.bytes)}%` }}
                    title={`${t(BUCKET_KEY[bucket])} · ${diskSize(totals.buckets[bucket].bytes)} · ${percent(totals.buckets[bucket].bytes, totals.bytes)}`}
                  />
                ) : null
              )}
            </div>
            <div className="usage-engine-legend" data-legend="split">
              {BUCKETS.map((bucket) => (
                <span key={bucket} className="usage-engine-key" data-bucket={bucket}>
                  <i className="usage-swatch" style={series(bucket)} />
                  <span className="usage-engine-name" title={t(BUCKET_KEY[bucket])}>{t(BUCKET_KEY[bucket])}</span>
                  <span className="usage-engine-values">{t("repositories.overviewBucketValue", { n: totals.buckets[bucket].n, size: size(totals.buckets[bucket].bytes) })}</span>
                </span>
              ))}
            </div>
          </div>

          <section className="usage-section" aria-label={t("repositories.overviewByRepo")}>
            <div className="usage-section-head">
              <span className="usage-section-title">{t("repositories.overviewByRepo")}</span>
            </div>
            <div className="usage-purposes worktree-repos">
              {totals.repos.map((repo) => (
                <div key={`${repo.projectId}:${repo.repoId}`} className="usage-purpose-row" data-repo={repo.repoId} title={`${repo.repo} · ${repo.project}`}>
                  <span className="usage-purpose-name">
                    {repo.repo}
                    <span className="worktree-repo-project"> · {repo.project}</span>
                  </span>
                  <div className="usage-purpose-track">
                    <span className="usage-purpose-fill" style={{ ...series("worktrees"), width: `${share(repo.bytes, most)}%` }} />
                  </div>
                  <span className="usage-purpose-count num">{t("repositories.overviewBucketValue", { n: repo.n, size: size(repo.bytes) })}</span>
                </div>
              ))}
            </div>
          </section>

          <div className="row worktree-overview-foot">
            <button type="button" className="btn btn-secondary worktree-overview-clear" disabled={!removable.length || remove.isPending} onClick={take}>
              {remove.isPending ? t("repositories.worktreesRemoving") : t("repositories.overviewRemove", { n: totals.buckets.free.n })}
            </button>
            <p className="usage-chart-note">{t("repositories.overviewDetail")}</p>
          </div>
        </>
      )}
    </div>
  );
}
