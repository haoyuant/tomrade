import { useState } from "react";
import type { Listing, SourceName } from "@tomradex/community";
import { Icon } from "~/components/icons";
import { Eyebrow, SectionHead, Tag } from "~/components/ui/atoms";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { agoLabel } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useBrowse, useCommunityAccount, useCommunityPlugin, useInspect, useReport, useStoreInstall } from "~/lib/plugins";
import { openExternal } from "~/lib/shell";
import { useToast } from "~/lib/toast";
import { Field, Findings, Reach, TrustTags, messageOf } from "./parts";

type Sort = "downloads" | "updated" | "title";

export function BrowseTab() {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("downloads");
  const [officialOnly, setOfficialOnly] = useState(false);
  const browse = useBrowse(query, sort, officialOnly);
  const [open, setOpen] = useState<string | null>(null);
  const SORTS: [Sort, MessageKey][] = [
    ["downloads", "plugins.sortDownloads"],
    ["updated", "plugins.sortUpdated"],
    ["title", "plugins.sortTitle"]
  ];
  const listings = browse.data?.listings ?? [];
  const official = listings.filter((l) => l.source === "official");
  const community = listings.filter((l) => l.source === "community");
  const status = (name: SourceName) => browse.data?.sources.find((s) => s.name === name);
  const officialStatus = status("official");
  const communityStatus = status("community");
  return (
    <>
      <SectionHead title={t("plugins.tabBrowse")}>{t("plugins.browseLede")}</SectionHead>
      <form
        className="row"
        style={{ gap: "var(--space-2)", marginBottom: "var(--space-3)", flexWrap: "wrap" }}
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(text.trim());
        }}
      >
        <input className="input" style={{ flex: "1 1 200px" }} value={text} placeholder={t("plugins.search")} aria-label={t("plugins.search")} onChange={(e) => setText(e.target.value)} data-testid="community-search" />
        <div className="seg quiet" role="group" aria-label={t("plugins.filterLabel")} data-testid="browse-filter">
          <button type="button" aria-pressed={!officialOnly} onClick={() => setOfficialOnly(false)} data-filter="all">
            {t("plugins.filterAll")}
          </button>
          <button type="button" aria-pressed={officialOnly} onClick={() => setOfficialOnly(true)} data-filter="official">
            {t("plugins.filterOfficial")}
          </button>
        </div>
        <div className="seg quiet" role="group" aria-label={t("plugins.search")}>
          {SORTS.map(([id, key]) => (
            <button key={id} type="button" aria-pressed={sort === id} onClick={() => setSort(id)}>
              {t(key)}
            </button>
          ))}
        </div>
      </form>
      <div className="stack-2" style={{ marginBottom: "var(--space-3)" }}>
        {browse.error && <p className="meta-txt" style={{ color: "var(--danger)" }}>{t("plugins.storeUnavailable", { message: messageOf(browse.error) })}</p>}
        {officialStatus && !officialStatus.available && (
          <p className="meta-txt" style={{ color: "var(--danger)" }} data-testid="official-unavailable">
            {t("plugins.officialUnavailable", { message: officialStatus.error ?? "" })}
          </p>
        )}
        {officialStatus?.available && officialStatus.stale && officialStatus.fetchedAt && (
          <p className="meta-txt" data-testid="official-stale">
            {t("plugins.officialStale", { time: agoLabel(officialStatus.fetchedAt) })}
          </p>
        )}
        {communityStatus && !communityStatus.available && (
          <p className="meta-txt" data-testid="community-unavailable">
            {communityStatus.reason === "no-cloud" ? t("plugins.communityNoCloud") : t("plugins.communityUnavailable", { message: communityStatus.error ?? "" })}
          </p>
        )}
        {browse.data && !listings.length && <p className="meta-txt">{t("plugins.nothingFound")}</p>}
      </div>
      <div className="stack-3" data-testid="community-results">
        {!!official.length && (
          <section className="stack-2" data-testid="official-results">
            <Eyebrow>{t("plugins.groupOfficial")}</Eyebrow>
            {official.map((listing) => (
              <ListingRow key={listing.id} listing={listing} onOpen={() => setOpen(listing.id)} />
            ))}
          </section>
        )}
        {!!community.length && (
          <section className="stack-2" data-testid="community-group">
            <Eyebrow>{t("plugins.groupCommunity")}</Eyebrow>
            {community.map((listing) => (
              <ListingRow key={listing.id} listing={listing} onOpen={() => setOpen(listing.id)} />
            ))}
          </section>
        )}
      </div>
      {open && <PluginDetailDialog id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ListingRow({ listing, onOpen }: { listing: Listing; onOpen: () => void }) {
  const { t } = useI18n();
  const latest = listing.latest;
  return (
    <button type="button" className="cfg-row plug-listing" onClick={onOpen} data-id={listing.id} data-source={listing.source}>
      <Icon name="i-plug" size={15} style={{ color: "var(--accent)" }} />
      <div className="cfg-name" style={{ textAlign: "left" }}>
        {listing.title} <span className="meta-txt">{t("plugins.by", { publisher: listing.publisher })}</span>
        <div className="meta-txt dense">{listing.description}</div>
        <div className="row plug-tags" style={{ gap: 6, marginTop: 3 }}>
          {latest && <TrustTags tier={latest.tier} risk={latest.risk} />}
          {latest && !latest.compatible && <Tag tone="faint">{t("plugins.incompatible")}</Tag>}
          {latest?.revoked && <span className="tag risk-high">{t("plugins.revoked")}</span>}
          <span className="meta-txt">{listing.source === "official" ? t("plugins.fromOfficial") : t("plugins.installs", { count: listing.downloads })}</span>
        </div>
      </div>
      {listing.installed ? <Tag tone="neutral">{t("plugins.installedVersion", { version: listing.installed.version })}</Tag> : latest && <Tag tone="strong">{t("plugins.version", { version: latest.version })}</Tag>}
    </button>
  );
}

function PluginDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const detail = useCommunityPlugin(id);
  const [installing, setInstalling] = useState(false);
  const [reporting, setReporting] = useState(false);
  const d = detail.data;
  const latest = d?.latest;
  const canInstall = latest && latest.compatible && !latest.revoked && latest.version !== d?.installed?.version;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} label={d?.title ?? id} className="sheet-md">
      <DialogHead title={d?.title ?? id} aside={latest ? <TrustTags tier={latest.tier} risk={latest.risk} /> : undefined} />
      <DialogBody>
        {detail.error && <p style={{ color: "var(--danger)" }}>{t("plugins.storeUnavailable", { message: messageOf(detail.error) })}</p>}
        {d && (
          <div className="stack-3" data-testid="plugin-detail">
            <p>{d.description}</p>
            {latest?.tier !== "official" && <p className="meta-txt">{t("plugins.unreviewedNote")}</p>}
            <dl className="plug-facts">
              <div className="field-row">
                <dt>{t("plugins.detailRepository")}</dt>
                <dd>
                  <button type="button" className="link-btn mono" onClick={() => openExternal(d.repository)}>
                    {d.repository.replace("https://", "")}
                  </button>
                </dd>
              </div>
              {latest && (
                <div className="field-row">
                  <dt>{t("plugins.detailBuiltFrom")}</dt>
                  <dd>
                    <button type="button" className="link-btn mono" onClick={() => openExternal(`${d.repository}/tree/${latest.commit}`)}>
                      {`${latest.version} · ${latest.commit.slice(0, 7)}`}
                    </button>
                  </dd>
                </div>
              )}
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
      {installing && d && latest && <InstallConfirmDialog id={d.id} title={d.title} publisher={d.publisher} version={latest.version} onClose={() => setInstalling(false)} onDone={onClose} />}
      {reporting && d && <ReportDialog id={d.id} title={d.title} version={latest?.version ?? null} onClose={() => setReporting(false)} />}
    </Dialog>
  );
}

/** What is installed is read on this machine first: nobody else reviewed it. */
function InstallConfirmDialog(props: { id: string; title: string; publisher: string; version: string; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const inspect = useInspect(props.id, props.version);
  const install = useStoreInstall();
  const [error, setError] = useState<string | null>(null);
  const read = inspect.data;
  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()} label={t("plugins.installTitle", { title: props.title, version: props.version })} className="sheet-md">
      <DialogHead title={t("plugins.installTitle", { title: props.title, version: props.version })} aside={read ? <TrustTags tier={read.tier} risk={read.risk} /> : undefined} />
      <DialogBody>
        <div className="stack-3" data-testid="install-inspection">
          {read?.tier !== "official" && <p>{t("plugins.unreviewedNote")}</p>}
          {inspect.isPending && <p className="meta-txt">{t("plugins.installReading")}</p>}
          {inspect.error && <p style={{ color: "var(--danger)" }}>{messageOf(inspect.error)}</p>}
          {read && (
            <>
              <p>{t("plugins.installLede")}</p>
              <Reach reasons={read.riskReasons} inject={read.inject} hosts={read.hosts.filter((h) => h !== "*")} />
              {!!read.findings.length && (
                <>
                  <Eyebrow>{t("plugins.installFindings")}</Eyebrow>
                  <Findings findings={read.findings} />
                </>
              )}
              {read.repository && (
                <button type="button" className="link-btn" onClick={() => openExternal(`${read.repository}/tree/${read.commit}`)}>
                  {t("plugins.installSource")} <span className="mono meta-txt">{read.commit.slice(0, 7)}</span>
                </button>
              )}
              {read.risk === "high" && <p style={{ color: "var(--danger)" }}>{t("plugins.highRiskNote", { publisher: props.publisher })}</p>}
            </>
          )}
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
          disabled={!read || install.isPending}
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
