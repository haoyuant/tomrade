import { useState } from "react";
import type { SyncProgress, SyncStep, SyncTrace } from "@tomradex/files";
import { Icon } from "~/components/icons";
import { Fold } from "~/components/ui/atoms";
import { agoLabel } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useOpenHere, useTicking } from "~/lib/syncProgress";

const STEP: Record<SyncStep, MessageKey> = {
  saving: "syncActivity.step_saving",
  reaching: "syncActivity.step_reaching",
  fetching: "syncActivity.step_fetching",
  merging: "syncActivity.step_merging",
  pushing: "syncActivity.step_pushing"
};

type T = ReturnType<typeof useI18n>["t"];

/** A step's name as the person reads it. */
export const stepLabel = (t: T, step: SyncStep): string => t(STEP[step]);

const duration = (t: T, ms: number): string => {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return t("syncActivity.seconds", { n: s < 10 ? s.toFixed(1) : String(Math.round(s)) });
  return t("syncActivity.minutes", { m: String(Math.floor(s / 60)), s: String(Math.round(s % 60)) });
};

/** The step a running sync is in and how far its transfer has come, as git reports it. */
function Running({ progress }: { progress: SyncProgress }) {
  const { t } = useI18n();
  const now = useTicking(true);
  const { transfer } = progress;
  return (
    <p className="meta-txt dense sync-running" role="status" aria-live="polite">
      <Icon name="i-sync" size={12} /> {t("syncActivity.running", { step: t(STEP[progress.step]), elapsed: duration(t, now - progress.since) })}
      {transfer && (
        <span className="sync-transfer">
          {" · "}
          {t("syncActivity.transfer", { percent: String(transfer.percent), done: String(transfer.done), total: String(transfer.total) })}
          {transfer.size && ` · ${transfer.size}`}
          {transfer.rate && ` · ${transfer.rate}`}
        </span>
      )}
    </p>
  );
}

function detailsText(t: T, trace: SyncTrace): string {
  return [
    trace.remote && `${t("syncActivity.remote")}: ${trace.remote}`,
    trace.branch && `${t("syncActivity.branch")}: ${trace.branch}`,
    trace.directory && `${t("syncActivity.directory")}: ${trace.directory}`,
    `${t("syncActivity.proxy")}: ${trace.proxy ? t("syncActivity.viaProxy", { proxy: trace.proxy }) : t("syncActivity.direct")}`,
    `${t("syncActivity.steps")}: ${trace.steps.map((s) => t(s.ok ? "syncActivity.stepOk" : "syncActivity.stepFailed", { step: t(STEP[s.step]), time: duration(t, s.ms) })).join(" → ")}`,
    "",
    trace.output || t("syncActivity.noOutput")
  ].filter((line) => line !== null && line !== undefined).join("\n");
}

/**
 * A sync as it runs, the step it stopped at when it failed, and — folded
 * until asked for, and kept open in this window once opened — what the last
 * one did: where it went, through which proxy, each step's time, git's words.
 */
export function SyncActivity({ id, progress, trace }: { id: string; progress: SyncProgress | null; trace?: SyncTrace }) {
  const { t } = useI18n();
  const [open, toggle] = useOpenHere(`sync-details:${id}`);
  const [copied, setCopied] = useState(false);
  const failed = !progress && trace?.steps.find((s) => !s.ok);
  const copy = () =>
    trace &&
    void navigator.clipboard?.writeText(detailsText(t, trace)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div className="sync-activity">
      {progress && <Running progress={progress} />}
      {failed && <p className="meta-txt dense sync-failed">{t("syncActivity.failedAt", { step: t(STEP[failed.step]) })}</p>}
      {trace && (
        <Fold id={`sync-details-${id}`} title={t("syncActivity.details")} open={open} onToggle={toggle}>
          <p className="meta-txt dense">{t("syncActivity.lastRun", { when: agoLabel(trace.at) })}</p>
          <dl className="sync-details">
            {trace.remote && (
              <>
                <dt>{t("syncActivity.remote")}</dt>
                <dd>{trace.remote}</dd>
              </>
            )}
            {trace.branch && (
              <>
                <dt>{t("syncActivity.branch")}</dt>
                <dd>{trace.branch}</dd>
              </>
            )}
            {trace.directory && (
              <>
                <dt>{t("syncActivity.directory")}</dt>
                <dd>{trace.directory}</dd>
              </>
            )}
            <dt>{t("syncActivity.proxy")}</dt>
            <dd>{trace.proxy ? t("syncActivity.viaProxy", { proxy: trace.proxy }) : t("syncActivity.direct")}</dd>
            <dt>{t("syncActivity.steps")}</dt>
            <dd>
              <ol className="sync-steps">
                {trace.steps.map((s, i) => (
                  <li key={i} data-ok={s.ok}>
                    {t(s.ok ? "syncActivity.stepOk" : "syncActivity.stepFailed", { step: t(STEP[s.step]), time: duration(t, s.ms) })}
                  </li>
                ))}
              </ol>
            </dd>
            <dt>{t("syncActivity.output")}</dt>
            <dd>
              <pre className="sync-output">{trace.output || t("syncActivity.noOutput")}</pre>
            </dd>
          </dl>
          <button type="button" className="btn btn-ghost btn-xs" onClick={copy}>
            <Icon name="i-copy" size={11} /> {copied ? t("syncActivity.copied") : t("syncActivity.copy")}
          </button>
        </Fold>
      )}
    </div>
  );
}
