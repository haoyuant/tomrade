import { useState } from "react";
import type { Listing } from "@tomrade/community";
import { Icon } from "~/components/icons";
import { Eyebrow, SectionHead, Tag } from "~/components/ui/atoms";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useCommunityAccount, useCommunityPlugin, useCommunitySearch, useReport, useStoreInstall } from "~/lib/plugins";
import { openExternal } from "~/lib/shell";
import { useToast } from "~/lib/toast";
import { Field, Findings, Reach, TrustTags, messageOf } from "./parts";

type Sort = "downloads" | "updated" | "title";

export function BrowseTab() {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("downloads");
  const search = useCommunitySearch(query, sort);
  const [open, setOpen] = useState<string | null>(null);
  const SORTS: [Sort, MessageKey][] = [
    ["downloads", "plugins.sortDownloads"],
    ["updated", "plugins.sortUpdated"],
    ["title", "plugins.sortTitle"]
  ];
  return (
    <>
      <SectionHead title={t("plugins.tabBrowse")}>{t("plugins.browseLede")}</SectionHead>
      <form
        className="row"
        style={{ gap: "var(--space-2)", marginBottom: "var(--space-3)" }}
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(text.trim());
        }}
      >
        <input className="input" style={{ flex: 1 }} value={text} placeholder={t("plugins.search")} aria-label={t("plugins.search")} onChange={(e) => setText(e.target.value)} data-testid="community-search" />
        <div className="seg quiet" role="group" aria-label={t("plugins.search")}>
          {SORTS.map(([id, key]) => (
            <button key={id} type="button" aria-pressed={sort === id} onClick={() => setSort(id)}>
              {t(key)}
            </button>
          ))}
        </div>
      </form>
      {search.error && <p className="meta-txt" style={{ color: "var(--danger)" }}>{t("plugins.storeUnavailable", { message: messageOf(search.error) })}</p>}
      {search.data && !search.data.length && <p className="meta-txt">{t("plugins.nothingFound")}</p>}
      <div className="stack-2" data-testid="community-results">
        {search.data?.map((listing) => <ListingRow key={listing.id} listing={listing} onOpen={() => setOpen(listing.id)} />)}
      </div>
      {open && <PluginDetailDialog id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ListingRow({ listing, onOpen }: { listing: Listing; onOpen: () => void }) {
  const { t } = useI18n();
  const latest = listing.latest;
  return (
    <button type="button" className="cfg-row plug-listing" onClick={onOpen} data-id={listing.id}>
      <Icon name="i-plug" size={15} style={{ color: "var(--accent)" }} />
      <div className="cfg-name" style={{ textAlign: "left" }}>
        {listing.title} <span className="meta-txt">{t("plugins.by", { publisher: listing.publisher })}</span>
        <div className="meta-txt dense">{listing.description}</div>
        <div className="row plug-tags" style={{ gap: 6, marginTop: 3 }}>
          {latest && <TrustTags tier={latest.tier} risk={latest.risk} reviewedAs={latest.reviewedAs} />}
          {latest && !latest.compatible && <Tag tone="faint">{t("plugins.incompatible")}</Tag>}
          {latest?.revoked && <span className="tag risk-high">{t("plugins.revoked")}</span>}
          <span className="meta-txt">{t("plugins.installs", { count: listing.downloads })}</span>
        </div>
      </div>
      {listing.installed ? <Tag tone="neutral">{t("plugins.installedVersion", { version: listing.installed.version })}</Tag> : latest && <Tag tone="strong">{t("plugins.version", { version: latest.version })}</Tag>}
    </button>
  );
}

export function PluginDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const detail = useCommunityPlugin(id);
  const [installing, setInstalling] = useState(false);
  const [reporting, setReporting] = useState(false);
  const d = detail.data;
  const latest = d?.latest;
  const report = d?.report;
  const canInstall = latest && latest.compatible && !latest.revoked && latest.version !== d?.installed?.version;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} label={d?.title ?? id} className="sheet-md">
      <DialogHead title={d?.title ?? id} aside={latest ? <TrustTags tier={latest.tier} risk={latest.risk} reviewedAs={latest.reviewedAs} /> : undefined} />
      <DialogBody>
        {detail.error && <p style={{ color: "var(--danger)" }}>{t("plugins.storeUnavailable", { message: messageOf(detail.error) })}</p>}
        {d && (
          <div className="stack-3" data-testid="plugin-detail">
            <p>{d.description}</p>
            <dl className="plug-facts">
              <div className="field-row">
                <dt>{t("plugins.detailRepository")}</dt>
                <dd>
                  <button type="button" className="link-btn mono" onClick={() => openExternal(d.repository)}>
                    {d.repository.replace("https://", "")}
                  </button>
                </dd>
              </div>
              <div className="field-row">
                <dt>{t("plugins.detailLicense")}</dt>
                <dd className="mono">{d.license}</dd>
              </div>
              <div className="field-row">
                <dt>{t("plugins.detailVersions")}</dt>
                <dd>
                  {d.versions.slice(0, 6).map((v) => (
                    <span key={v.version} className="mono meta-txt">
                      {v.version}
                      {v.revoked ? ` (${t("plugins.revoked")})` : ""}
                    </span>
                  ))}
                </dd>
              </div>
              {d.forkOf && (
                <div className="field-row">
                  <dt />
                  <dd className="meta-txt">{t("plugins.detailForkOf", { id: d.forkOf })}</dd>
                </div>
              )}
            </dl>
            {d.manifest && (
              <>
                <Eyebrow>{t("plugins.reachTitle")}</Eyebrow>
                <Reach reasons={latest?.riskReasons ?? []} inject={[...d.manifest.inject, ...d.manifest.optional]} hosts={d.manifest.permissions.network.filter((h) => h !== "*")} />
              </>
            )}
            {report && (
              <div className="panel stack-2">
                <Eyebrow>{t("plugins.detailReport")}</Eyebrow>
                <p>{report.summary}</p>
                {report.tests && <p className="meta-txt">{t("plugins.detailTests", { passed: report.tests.checks.filter((c) => c.ok).length, total: report.tests.checks.length })}</p>}
                <Eyebrow>{t("plugins.detailConcerns")}</Eyebrow>
                {report.ai?.concerns.length ? (
                  <ul className="dash">
                    {report.ai.concerns.map((c, i) => (
                      <li key={i}>
                        <strong>{c.title}</strong> — {c.detail} {c.file && <span className="meta-txt mono">{c.file}{c.line ? `:${c.line}` : ""}</span>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="meta-txt">{t("plugins.detailNoConcerns")}</p>
                )}
                <Findings findings={report.findings.filter((f) => f.severity !== "info")} />
              </div>
            )}
            {!!d.reviews.length && (
              <div className="stack-2">
                <Eyebrow>{t("plugins.detailReviews")}</Eyebrow>
                <ul className="dash">
                  {d.reviews.map((r, i) => (
                    <li key={i}>
                      <span className="mono">{r.version}</span> · {r.decision} {r.notes && `— ${r.notes}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={() => setReporting(true)} disabled={!d}>
          {t("plugins.reportProblem")}
        </button>
        <div className="spacer" />
        {d?.installed && <Tag tone="neutral">{t("plugins.installedVersion", { version: d.installed.version })}</Tag>}
        {canInstall && (
          <button type="button" className="btn btn-primary" onClick={() => setInstalling(true)} data-testid="store-install">
            {d?.installed ? t("plugins.updateTo", { version: latest!.version }) : t("plugins.install")}
          </button>
        )}
      </DialogFoot>
      {installing && d && latest && <InstallConfirmDialog id={d.id} title={d.title} publisher={d.publisher} version={latest.version} risk={latest.risk} reasons={latest.riskReasons} inject={d.manifest ? [...d.manifest.inject, ...d.manifest.optional] : []} hosts={d.manifest?.permissions.network ?? []} onClose={() => setInstalling(false)} onDone={onClose} />}
      {reporting && d && <ReportDialog id={d.id} title={d.title} version={latest?.version ?? null} onClose={() => setReporting(false)} />}
    </Dialog>
  );
}

function InstallConfirmDialog(props: { id: string; title: string; publisher: string; version: string; risk: "low" | "elevated" | "high" | null; reasons: string[]; inject: string[]; hosts: string[]; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const install = useStoreInstall();
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()} label={t("plugins.installTitle", { title: props.title, version: props.version })} className="sheet-md">
      <DialogHead title={t("plugins.installTitle", { title: props.title, version: props.version })} />
      <DialogBody>
        <div className="stack-3">
          <p>{t("plugins.installLede")}</p>
          <Reach reasons={props.reasons} inject={props.inject} hosts={props.hosts.filter((h) => h !== "*")} />
          {props.risk === "high" && <p style={{ color: "var(--danger)" }}>{t("plugins.highRiskNote", { publisher: props.publisher })}</p>}
          {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        </div>
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={props.onClose}>
          {t("plugins.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={install.isPending}
          data-testid="store-install-confirm"
          onClick={() =>
            install.mutate(
              { id: props.id, version: props.version },
              {
                onSuccess: () => {
                  toast({ body: t("plugins.installedDone", { title: props.title, version: props.version }) });
                  props.onClose();
                  props.onDone();
                },
                onError: (e) => setError(messageOf(e))
              }
            )
          }
        >
          {t("plugins.installNow")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}

const REASONS = ["malware", "broken", "misleading", "license", "other"] as const;

function ReportDialog({ id, title, version, onClose }: { id: string; title: string; version: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const account = useCommunityAccount();
  const report = useReport();
  const [reason, setReason] = useState<(typeof REASONS)[number]>("broken");
  const [details, setDetails] = useState("");
  const [error, setError] = useState<string | null>(null);
  const signedIn = account.data?.signedIn;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} label={t("plugins.reportTitle", { title })} className="sheet-md">
      <DialogHead title={t("plugins.reportTitle", { title })} />
      <DialogBody>
        {!signedIn ? (
          <p>{t("plugins.reportNeedsAccount")}</p>
        ) : (
          <div className="stack-3">
            <Field label={t("plugins.reportReason")} htmlFor="rpReason">
              <select id="rpReason" className="select" value={reason} onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}>
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    {t(`plugins.reason_${r}` as MessageKey)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("plugins.reportDetails")} htmlFor="rpDetails">
              <textarea id="rpDetails" className="input" rows={4} value={details} maxLength={4000} onChange={(e) => setDetails(e.target.value)} />
            </Field>
            {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
          </div>
        )}
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("plugins.cancel")}
        </button>
        {signedIn && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={report.isPending}
            onClick={() =>
              report.mutate(
                { id, version, reason, details },
                {
                  onSuccess: () => {
                    toast({ body: t("plugins.reportSent") });
                    onClose();
                  },
                  onError: (e) => setError(messageOf(e))
                }
              )
            }
          >
            {t("plugins.reportSend")}
          </button>
        )}
      </DialogFoot>
    </Dialog>
  );
}
