import type { ReactNode } from "react";
import type { WebSearchProviderView } from "@tomradex/web-search";
import { Icon } from "~/components/icons";
import { SectionHead, Tag } from "~/components/ui/atoms";
import { useI18n } from "~/lib/i18n";

/**
 * Web search as one pane: the providers in the order they are asked, then
 * (`children`) the settings sections of those listed in `drawn`. A provider
 * set up elsewhere — on a model's profile, say — is a button away.
 */
export function WebSearchPane({ providers, drawn, onGo, children }: { providers: WebSearchProviderView[]; drawn: ReadonlySet<string>; onGo: (pane: string, query?: string) => void; children?: ReactNode }) {
  const { t } = useI18n();
  const answering = providers.find((p) => !p.unavailable)?.id;
  return (
    <>
      <SectionHead title={t("webSearch.label")}>{t("webSearch.lede")}</SectionHead>
      {providers.length ? (
        <div className="stack-2" data-testid="web-search-providers">
          {providers.map((p) => (
            <div key={p.id} className={p.unavailable ? "cfg-row off" : "cfg-row"} data-provider={p.id}>
              <Icon name="i-globe" size={15} style={{ color: p.unavailable ? "var(--meta)" : "var(--accent)" }} />
              <div className="cfg-name">{p.title}</div>
              {p.unavailable && p.settings && drawn.has(p.settings) && <span className="meta-txt">{t("webSearch.setUpBelow")}</span>}
              <Tag tone={p.id === answering ? "strong" : p.unavailable ? "faint" : "neutral"}>
                {t(p.id === answering ? "webSearch.answering" : p.unavailable ? "webSearch.notSetUp" : "webSearch.standby")}
              </Tag>
              {p.settings && !drawn.has(p.settings) && (
                <button type="button" className="btn btn-ghost" onClick={() => onGo(p.settings!)}>
                  {t("webSearch.openSettings")}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="row" style={{ gap: "var(--space-3)", flexWrap: "wrap" }}>
          <p className="meta-txt">{t("webSearch.none")}</p>
          <button type="button" className="btn btn-secondary" onClick={() => onGo("plugins", "search")}>
            {t("webSearch.findPlugin")}
          </button>
        </div>
      )}
      {children}
    </>
  );
}
