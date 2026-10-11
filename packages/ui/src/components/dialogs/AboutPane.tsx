import { useMutation, useQuery } from "@tanstack/react-query";
import { Icon } from "~/components/icons";
import { SectionHead, Tag } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { openExternal, reveal, type AboutInfo } from "~/lib/shell";
import { useToast } from "~/lib/toast";

const SITE = "https://tomrade.com";

/** Plain text, the way a bug report wants it: one fact per line, nothing localized. */
function details(info: AboutInfo): string {
  return [
    `Tomrade ${info.version}${info.packaged ? "" : " (checkout)"}`,
    `Build: ${info.commit ?? "unknown"}${info.builtAt ? ` · ${info.builtAt}` : ""}`,
    `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node} · V8 ${info.v8}`,
    `System: ${info.os} (${info.arch})`
  ].join("\n");
}

/** Which build this is, what it runs on, and whether a newer one is out. */
export function AboutPane() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const about = useQuery({ queryKey: ["about"], queryFn: () => invoke("shell.about"), staleTime: Infinity, retry: false });
  const update = useMutation({ mutationFn: () => invoke("shell.checkForUpdate") });
  const info = about.data;
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
  const site = locale === "zh" ? `${SITE}/zh/` : `${SITE}/`;

  const copy = () => info && void navigator.clipboard?.writeText(details(info)).then(() => toast({ body: t("about.copied") }));

  return (
    <>
      <SectionHead title={t("about.title")}>{t("about.lede")}</SectionHead>
      <div className="panel about-hero">
        <img className="about-logo" src={`${import.meta.env.BASE_URL}logo.png`} alt="" draggable={false} />
        <div className="about-id">
          <div className="about-name">Tomrade</div>
          <div className="about-version num">
            {info ? t("about.versionLine", { version: info.version }) : "—"}
            {info && !info.packaged && <Tag tone="neutral">{t("about.checkout")}</Tag>}
          </div>
          <p className="meta-txt">{t("about.tagline")}</p>
        </div>
      </div>

      {info && (
        <div className="panel about-update">
          {!info.packaged ? (
            <p className="meta-txt">{t("about.checkoutNote")}</p>
          ) : (
            <>
              <p className="about-update-state" role="status">
                {update.isPending
                  ? t("about.checking")
                  : update.isError
                    ? t("about.updateFailed")
                    : update.data?.newer
                      ? `${t("about.updateAvailable", { version: update.data.latest })}${update.data.date ? ` ${t("about.updateDate", { date: date(update.data.date) })}` : ""}`
                      : update.data
                        ? t("about.upToDate", { version: update.data.latest })
                        : null}
              </p>
              {update.data?.newer ? (
                <button type="button" className="btn btn-primary" onClick={() => openExternal(`${site}download/`)}>
                  <Icon name="i-download" size={13} />
                  {t("about.download")}
                </button>
              ) : (
                <button type="button" className="btn btn-secondary" disabled={update.isPending} onClick={() => update.mutate()}>
                  {update.isPending ? t("about.checking") : t("about.checkUpdates")}
                </button>
              )}
            </>
          )}
        </div>
      )}

      <hr className="rule" />
      <SectionHead
        title={t("about.detailsTitle")}
        aside={
          info && (
            <button type="button" className="btn btn-ghost" onClick={copy}>
              <Icon name="i-copy" size={13} />
              {t("about.copy")}
            </button>
          )
        }
      />
      {info ? (
        <dl className="panel about-facts">
          <div className="field-row" data-fact="version">
            <dt>{t("about.version")}</dt>
            <dd className="num">{info.version}</dd>
          </div>
          <div className="field-row" data-fact="build">
            <dt>{t("about.build")}</dt>
            <dd className="num">
              {info.commit ?? "—"}
              {info.builtAt && <span className="meta-txt">{t("about.built", { date: date(info.builtAt) })}</span>}
            </dd>
          </div>
          <div className="field-row" data-fact="electron">
            <dt>Electron</dt>
            <dd className="num">{info.electron}</dd>
          </div>
          <div className="field-row" data-fact="chromium">
            <dt>Chromium</dt>
            <dd className="num">{info.chrome}</dd>
          </div>
          <div className="field-row" data-fact="node">
            <dt>Node.js</dt>
            <dd className="num">{info.node}</dd>
          </div>
          <div className="field-row" data-fact="system">
            <dt>{t("about.system")}</dt>
            <dd className="num">
              {info.os} · {info.arch}
            </dd>
          </div>
          <div className="field-row" data-fact="appData">
            <dt>{t("about.appData")}</dt>
            <dd>
              <span className="num about-path">{info.userData}</span>
              <button type="button" className="btn btn-ghost" onClick={() => reveal(info.userData)}>
                {t("about.reveal")}
              </button>
              <span className="meta-txt about-note">{t("about.appDataNote")}</span>
            </dd>
          </div>
        </dl>
      ) : (
        <p className="meta-txt">{about.isError ? t("about.unavailable") : "…"}</p>
      )}

      <hr className="rule" />
      <SectionHead title={t("about.linksTitle")} />
      <div className="row" style={{ gap: "var(--space-2)", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-ghost" onClick={() => openExternal(site)}>
          <Icon name="i-globe" size={13} />
          {t("about.website")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => openExternal(`${site}download/`)}>
          <Icon name="i-download" size={13} />
          {t("about.downloads")}
        </button>
      </div>
      <p className="meta-txt about-license">
        <strong>{t("about.licenseTitle")}</strong> · {t("about.license")}
      </p>
      <p className="meta-txt">Copyright © Tomrade</p>
    </>
  );
}
