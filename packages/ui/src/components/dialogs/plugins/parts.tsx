import type { ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import type { Finding } from "@tomradex/plugin-kit";
import { Tag } from "~/components/ui/atoms";
import { useI18n, type MessageKey } from "~/lib/i18n";

export type TierName = "official" | "reviewed" | "ai-reviewed" | "local" | "dev";
export type RiskName = "low" | "elevated" | "high";

const TIER: Record<TierName, { label: MessageKey; why: MessageKey; tone: "faint" | "neutral" | "strong" }> = {
  official: { label: "plugins.tierOfficial", why: "plugins.tierOfficialWhy", tone: "strong" },
  reviewed: { label: "plugins.tierReviewed", why: "plugins.tierReviewedWhy", tone: "strong" },
  "ai-reviewed": { label: "plugins.tierAiReviewed", why: "plugins.tierAiReviewedWhy", tone: "neutral" },
  local: { label: "plugins.tierLocal", why: "plugins.tierLocalWhy", tone: "faint" },
  dev: { label: "plugins.tierDev", why: "plugins.tierDevWhy", tone: "faint" }
};

/** What the store vouches for, and — when it is high — the risk label, which is never hidden behind a tooltip. */
export function TrustTags({ tier, risk, reviewedAs }: { tier: TierName | null; risk?: RiskName | null; reviewedAs?: string | null }) {
  const { t } = useI18n();
  const spec = tier ? TIER[tier] : null;
  return (
    <>
      {spec && (
        <Tag tone={spec.tone} title={tier === "reviewed" && reviewedAs ? t("plugins.tierReviewedAsWhy", { version: reviewedAs }) : t(spec.why)}>
          {t(spec.label)}
        </Tag>
      )}
      {risk === "high" && (
        <span className="tag risk-high" data-risk="high">
          {t("plugins.riskHigh")}
        </span>
      )}
      {risk === "elevated" && <Tag tone="faint">{t("plugins.riskElevated")}</Tag>}
    </>
  );
}

const REASONS = new Set(["exec", "fs-any", "network-any", "network", "fs-project", "db", "raw-database", "core-table-writes", "dynamic-code", "env", "fs"]);

/** What a plugin can reach, in plain words: the risk reasons first, then the services and hosts it names. */
export function Reach({ reasons, inject, hosts }: { reasons: string[]; inject: string[]; hosts?: string[] }) {
  const { t } = useI18n();
  // Named hosts say more than "talks to the internet"; the generic line is for when there are none.
  const words = reasons.filter((r) => REASONS.has(r) && !(r === "network" && hosts?.length)).map((r) => t(`plugins.risk_${r}` as MessageKey));
  return (
    <ul className="dash plug-reach">
      {words.map((w) => (
        <li key={w}>{w}</li>
      ))}
      {!!hosts?.length && <li>{t("plugins.hosts", { list: hosts.join(", ") })}</li>}
      {!!inject.length && <li className="meta-txt">{t("plugins.services", { list: inject.join(", ") })}</li>}
      {!words.length && !hosts?.length && !inject.length && <li className="meta-txt">{t("plugins.reachNothing")}</li>}
    </ul>
  );
}

export function Findings({ findings }: { findings: Finding[] }) {
  const { t } = useI18n();
  if (!findings.length) return <p className="meta-txt">{t("plugins.noFindings")}</p>;
  return (
    <ul className="dash plug-findings">
      {findings.map((f, i) => (
        <li key={`${f.rule}-${i}`} data-severity={f.severity}>
          <span className="mono">{f.severity}</span> {f.message} <span className="meta-txt mono">{f.file}:{f.line}</span>
        </li>
      ))}
    </ul>
  );
}

/** The project a screen shows, when there is one: undo and the agent need it. */
export function useCurrentProject(): string | undefined {
  const params = useParams({ strict: false }) as { projectId?: string };
  return params.projectId;
}

export const Field = ({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) => (
  <div className="field">
    <label htmlFor={htmlFor}>{label}</label>
    {children}
  </div>
);

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error));
