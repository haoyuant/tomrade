import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "~/components/icons";
import { SectionHead, Tag } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { legalUrl, siteUrl } from "~/lib/legal";
import { openExternal, reveal, type AboutInfo } from "~/lib/shell";
import { useToast } from "~/lib/toast";
import { useUpdateActions, useUpdatePrefs, useUpdatesOnScreen, useUpdateStatus, type UpdateStatus } from "~/lib/updates";
import { RestartOnboardingDialog } from "~/components/projects/RestartOnboardingDialog";
import { useSettingsSections } from "~/lib/queries";
import { MyReports } from "./MyReports";

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
  const updates = useUpdateStatus();
  const info = about.data;
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
  const site = siteUrl(locale);
  // The onboarding plugin runs onboarding again; its settings section says it is loaded.
  const onboarding = !!useSettingsSections(locale).data?.some((s) => s.id === "onboarding");
  const [restart, setRestart] = useState(false);

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

      {updates.data && updates.data.blocked !== "checkout" ? (
        <UpdatePanel status={updates.data} site={site} />
      ) : (
        info &&
        !info.packaged && (
          <div className="panel about-update">
            <p className="meta-txt">{t("about.checkoutNote")}</p>
          </div>
        )
      )}

      <MyReports />

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

      {onboarding && (
        <>
          <hr className="rule" />
          <SectionHead title={t("onboarding.sectionTitle")}>{t("onboarding.restartBody")}</SectionHead>
          <div>
            <button type="button" className="btn btn-secondary" data-testid="restart-onboarding" onClick={() => setRestart(true)}>
              <Icon name="i-leaf" size={13} />
              {t("onboarding.restartButton")}
            </button>
          </div>
          <RestartOnboardingDialog open={restart} onOpenChange={setRestart} />
        </>
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
        <button type="button" className="btn btn-ghost" onClick={() => openExternal(legalUrl("terms", locale))}>
          {t("legal.terms")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => openExternal(legalUrl("privacy", locale))}>
          {t("legal.privacy")}
        </button>
      </div>
      <p className="meta-txt about-license">
        <strong>{t("about.licenseTitle")}</strong> · {t("about.license")}
      </p>
      <p className="meta-txt">Copyright © Tomrade</p>
    </>
  );
}

/** Where this build stands against the feed, what to do about it, and how it should ask. */
function UpdatePanel({ status, site }: { status: UpdateStatus; site: string }) {
  const { t, locale } = useI18n();
  const { check, download, install, moveToApplications } = useUpdateActions();
  const [prefs, setPrefs] = useUpdatePrefs();
  useUpdatesOnScreen();
  const phase = status.phase;
  // What is downloaded belongs to the channel it came from.
  const channelLocked = phase.kind === "downloading" || phase.kind === "ready";
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });

  if (status.blocked) {
    return (
      <div className="panel about-update" data-blocked={status.blocked}>
        <div className="about-update-head">
          <p className="about-update-state">{t(status.blocked === "location" ? "about.moveNote" : status.blocked === "local-build" ? "about.localBuildNote" : "about.unsupportedNote")}</p>
          {status.blocked === "location" && (
            <button type="button" className="btn btn-secondary" disabled={moveToApplications.isPending} onClick={() => moveToApplications.mutate()}>
              {t("about.move")}
            </button>
          )}
          {status.blocked === "unsupported" && (
            <button type="button" className="btn btn-secondary" onClick={() => openExternal(`${site}download/`)}>
              <Icon name="i-download" size={13} />
              {t("about.downloads")}
            </button>
          )}
        </div>
      </div>
    );
  }

  const line =
    phase.kind === "checking"
      ? t("about.checking")
      : phase.kind === "current"
        ? t(phase.latest === status.version ? "about.upToDate" : "about.upToDateAhead", { version: phase.latest })
        : phase.kind === "available"
          ? `${t("about.updateAvailable", { version: phase.version })}${phase.date ? ` ${t("about.updateDate", { date: date(phase.date) })}` : ""}`
          : phase.kind === "downloading"
            ? phase.percent >= 100
              ? t("about.preparing", { version: phase.version })
              : t("about.downloading", { version: phase.version, percent: Math.round(phase.percent) })
            : phase.kind === "ready"
              ? t("about.ready", { version: phase.version })
              : phase.kind === "failed"
                ? t("about.updateFailed")
                : null;

  return (
    <div className="panel about-update" data-phase={phase.kind}>
      <div className="about-update-head">
        <p className="about-update-state" role="status">
          {line}
        </p>
        {phase.kind === "available" ? (
          <button type="button" className="btn btn-primary" disabled={download.isPending} onClick={() => download.mutate()}>
            <Icon name="i-download" size={13} />
            {t("about.download")}
          </button>
        ) : phase.kind === "ready" ? (
          <button type="button" className="btn btn-primary" disabled={install.isPending} onClick={() => install.mutate()}>
            {t("about.restart")}
          </button>
        ) : phase.kind === "downloading" ? null : (
          <button type="button" className="btn btn-secondary" disabled={phase.kind === "checking"} onClick={() => check.mutate()}>
            {phase.kind === "checking" ? t("about.checking") : t("about.checkUpdates")}
          </button>
        )}
      </div>
      {phase.kind === "downloading" && (
        <div className="about-update-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(phase.percent)}>
          <span style={{ width: `${phase.percent}%` }} />
        </div>
      )}
      {phase.kind === "failed" && <p className="meta-txt about-update-error">{phase.message.split("\n")[0]}</p>}
      {prefs && (
        <div className="about-update-prefs">
          <div className="about-update-pref" data-pref="autoCheck">
            <div>
              <div className="about-update-pref-name">{t("about.autoCheck")}</div>
              <p className="meta-txt">{t("about.autoCheckNote")}</p>
            </div>
            <button type="button" className="switch" role="switch" aria-checked={prefs.autoCheck} aria-label={t("about.autoCheck")} onClick={() => setPrefs({ autoCheck: !prefs.autoCheck })} />
          </div>
          <div className="about-update-pref" data-pref="channel">
            <div>
              <div className="about-update-pref-name">{t("about.channel")}</div>
              <p className="meta-txt">{t(channelLocked ? "about.channelLocked" : "about.channelNote")}</p>
            </div>
            <div className="seg" role="group" aria-label={t("about.channel")}>
              <button type="button" aria-pressed={prefs.channel === "stable"} disabled={channelLocked} onClick={() => setPrefs({ channel: "stable" })}>
                {t("about.stable")}
              </button>
              <button type="button" aria-pressed={prefs.channel === "beta"} disabled={channelLocked} onClick={() => setPrefs({ channel: "beta" })}>
                {t("about.beta")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
