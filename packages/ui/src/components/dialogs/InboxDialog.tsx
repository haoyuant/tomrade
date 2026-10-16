import { useEffect, useMemo, useState } from "react";
import type { InboxEntry, InboxKind, InboxListFilter, InboxSourceView } from "@tomradex/inbox";
import { Icon } from "~/components/icons";
import { Dialog, DialogBody, DialogHead } from "~/components/ui/dialog";
import { Spacer, Tag } from "~/components/ui/atoms";
import { agoLabel } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useInboxActions, useInboxEntries, useInboxSources } from "~/lib/inbox";
import { useItems } from "~/lib/queries";
import { openExternal } from "~/lib/shell";
import { useErrorToast, useToast } from "~/lib/toast";

const TABS: InboxListFilter[] = ["new", "activity", "accepted", "merged", "closed", "all"];
const KINDS: InboxKind[] = ["bug", "feedback", "idea"];

/**
 * The project's inbox: feedback and bug reports its sources brought in, each
 * waiting to be accepted as a ticket, merged into one, answered or closed.
 * Nothing reaches the backlog until someone here says so.
 */
export function InboxDialog({ projectId, open, onOpenChange, onOpenIssue }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void; onOpenIssue: (id: string) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const reportError = useErrorToast();
  const [tab, setTab] = useState<InboxListFilter>("new");
  const [showSources, setShowSources] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const entries = useInboxEntries(projectId, tab, open);
  const sources = useInboxSources(projectId, open);
  const waiting = useInboxEntries(projectId, "new", open);
  const stirred = useInboxEntries(projectId, "activity", open);
  const counts: Partial<Record<InboxListFilter, number>> = { new: waiting.data?.length ?? 0, activity: stirred.data?.length ?? 0 };
  const actions = useInboxActions(projectId);
  const list = entries.data ?? [];
  const entry = list.find((e) => e.id === selected) ?? null;
  const anySource = (sources.data ?? []).some((s) => s.enabled);

  // the first entry is open on arrival, and the next one after the open one is triaged away
  useEffect(() => {
    if (!list.length) setSelected(null);
    else if (!list.some((e) => e.id === selected)) setSelected(list[0]!.id);
  }, [list, selected]);

  const pull = () =>
    actions.refresh.mutate(undefined, { onSuccess: (n) => toast({ body: n ? t("inbox.pulled", { n }) : t("inbox.pulledNone") }), onError: reportError });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("inbox.title")} className="sheet-inbox" resizable="inbox">
      <DialogHead
        title={t("inbox.title")}
        aside={
          <>
            <button type="button" className="btn btn-ghost" aria-pressed={showSources} data-testid="inbox-sources" onClick={() => setShowSources((v) => !v)}>
              <Icon name="i-sliders" size={13} /> {t("inbox.sources")}
            </button>
            <button type="button" className="btn btn-secondary" disabled={actions.refresh.isPending || !anySource} onClick={pull}>
              <Icon name="i-sync" size={13} className={actions.refresh.isPending ? "is-spinning" : undefined} /> {actions.refresh.isPending ? t("inbox.pulling") : t("inbox.pull")}
            </button>
          </>
        }
      />
      <DialogBody className="inbox-body">
        {entries.isError ? (
          <p className="meta-txt">{t("inbox.off")}</p>
        ) : showSources ? (
          <SourcesPane projectId={projectId} sources={sources.data ?? []} onBack={() => setShowSources(false)} />
        ) : (
          <>
            <div className="seg quiet inbox-tabs" role="group" aria-label={t("inbox.tabsAria")}>
              {TABS.filter((s) => s !== "activity" || !!counts.activity || tab === "activity").map((s) => (
                <button key={s} type="button" aria-pressed={tab === s} data-tab={s} onClick={() => setTab(s)}>
                  {t(`inbox.tab_${s}` as MessageKey)}
                  {!!counts[s] && <span className="side-count num">{counts[s]}</span>}
                </button>
              ))}
            </div>
            {!list.length && entries.isSuccess ? (
              <div className="inbox-empty">
                {tab === "new" && !anySource ? (
                  <>
                    <p className="meta-txt">{t("inbox.emptyNoSources")}</p>
                    <button type="button" className="btn btn-secondary" onClick={() => setShowSources(true)}>
                      {t("inbox.chooseSources")}
                    </button>
                  </>
                ) : (
                  <p className="meta-txt">{tab === "new" ? t("inbox.emptyNew") : t("inbox.empty")}</p>
                )}
              </div>
            ) : (
              <div className="inbox-split">
                <ul className="inbox-entries" aria-label={t("inbox.title")}>
                  {list.map((e) => (
                    <li key={e.id}>
                      <button type="button" className="inbox-entry" aria-current={e.id === selected} data-entry={e.externalId} onClick={() => setSelected(e.id)}>
                        <span className="inbox-entry-title">{e.title}</span>
                        <span className="inbox-entry-meta">
                          <Tag tone={e.kind === "bug" ? "neutral" : "faint"}>{t(`inbox.kind_${e.kind}` as MessageKey)}</Tag>
                          <span className="num">{e.externalId}</span>
                          <span>{agoLabel(e.receivedAt)}</span>
                          {e.activityAt !== null && <Tag tone="strong">{t("inbox.activity")}</Tag>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {entry ? (
                  <EntryDetail key={entry.id} projectId={projectId} entry={entry} source={(sources.data ?? []).find((s) => s.id === entry.source)} onOpenIssue={onOpenIssue} />
                ) : (
                  <p className="meta-txt inbox-pick">{t("inbox.pick")}</p>
                )}
              </div>
            )}
          </>
        )}
      </DialogBody>
    </Dialog>
  );
}

function SourcesPane({ projectId, sources, onBack }: { projectId: string; sources: InboxSourceView[]; onBack: () => void }) {
  const { t } = useI18n();
  const reportError = useErrorToast();
  const { setSource, setOption } = useInboxActions(projectId);
  return (
    <div className="stack-3" data-testid="inbox-sources-pane">
      <div className="row">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          <Icon name="i-back" size={13} /> {t("inbox.back")}
        </button>
      </div>
      <p className="meta-txt">{t("inbox.sourcesLede")}</p>
      {!sources.length && <p className="meta-txt">{t("inbox.noSources")}</p>}
      <div className="panel stack-3">
        {sources.map((s) => (
          <div className="inbox-source" key={s.id} data-source={s.id}>
            <div className="row">
              <span className="cfg-name">{s.title}</span>
              <Spacer />
              <button
                type="button"
                className="switch"
                role="switch"
                aria-checked={s.enabled}
                aria-label={t("inbox.sourceOn", { name: s.title })}
                disabled={setSource.isPending}
                onClick={() => setSource.mutate({ id: s.id, enabled: !s.enabled }, { onError: reportError })}
              />
            </div>
            {s.enabled && (
              <p className="meta-txt dense">
                {s.unavailable
                  ? t("inbox.sourceUnavailable", { why: s.unavailable })
                  : s.error
                    ? t("inbox.sourceError", { error: s.error })
                    : s.pulledAt
                      ? t("inbox.sourcePulled", { when: agoLabel(s.pulledAt) })
                      : t("inbox.sourceNever")}
                {s.pending > 0 && ` · ${t("inbox.sourcePending", { n: s.pending })}`}
              </p>
            )}
            {s.enabled &&
              s.options.map((o) => (
                <div className="row inbox-source-option" key={o.id} data-option={o.id}>
                  <div className="stack-1">
                    <span>{o.title}</span>
                    {o.description && <span className="meta-txt dense">{o.description}</span>}
                  </div>
                  <Spacer />
                  <button
                    type="button"
                    className="switch"
                    role="switch"
                    aria-checked={o.value}
                    aria-label={o.title}
                    disabled={setOption.isPending}
                    onClick={() => setOption.mutate({ id: s.id, option: o.id, value: !o.value }, { onError: reportError })}
                  />
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

type Mode = null | "accept" | "merge" | "reply" | "duplicate";

function EntryDetail({ projectId, entry, source, onOpenIssue }: { projectId: string; entry: InboxEntry; source?: InboxSourceView; onOpenIssue: (id: string) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const reportError = useErrorToast();
  const actions = useInboxActions(projectId);
  const items = useItems(projectId);
  const [mode, setMode] = useState<Mode>(null);
  const [title, setTitle] = useState(entry.title);
  const [kind, setKind] = useState<InboxKind>(entry.kind);
  const [search, setSearch] = useState("");
  const [reply, setReply] = useState("");
  const ticket = entry.itemId ? (items.data ?? []).find((i) => i.id === entry.itemId) : undefined;
  const others = useInboxEntries(projectId, "all", mode === "duplicate" || !!entry.duplicateOf);
  const main = entry.duplicateOf ? (others.data ?? []).find((e) => e.id === entry.duplicateOf) : undefined;
  const sourceName = source?.title ?? entry.source;
  const busy = actions.accept.isPending || actions.merge.isPending || actions.close.isPending || actions.reopen.isPending || actions.seen.isPending;

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || mode !== "merge") return [];
    return (items.data ?? []).filter((i) => i.kind === "ticket" && (i.key.toLowerCase() === q || i.key.toLowerCase().startsWith(q) || i.title.toLowerCase().includes(q))).slice(0, 6);
  }, [items.data, search, mode]);

  const mains = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (mode !== "duplicate") return [];
    return (others.data ?? []).filter((e) => e.id !== entry.id && e.status !== "closed" && (!q || e.externalId.toLowerCase().includes(q) || e.title.toLowerCase().includes(q))).slice(0, 6);
  }, [others.data, search, mode, entry.id]);

  const closeAsDuplicate = (duplicateOf?: string) => actions.close.mutate({ id: entry.id, reason: "duplicate", ...(duplicateOf ? { duplicateOf } : {}) }, { onError: reportError });

  const accept = () =>
    actions.accept.mutate(
      { id: entry.id, opts: { title, kind } },
      { onSuccess: ({ item }) => toast({ body: t("inbox.accepted", { key: item.key }), actions: [{ label: t("inbox.openTicket"), run: () => onOpenIssue(item.id) }] }), onError: reportError }
    );

  return (
    <article className="inbox-detail" data-testid="inbox-detail">
      <h3 className="inbox-detail-title">{entry.title}</h3>
      <p className="inbox-detail-meta meta-txt">
        <Tag tone={entry.kind === "bug" ? "neutral" : "faint"}>{t(`inbox.kind_${entry.kind}` as MessageKey)}</Tag>
        <span>{t("inbox.from", { source: sourceName })}</span>
        {entry.url ? (
          <button type="button" className="link-inline num" title={t("inbox.openSource")} onClick={() => openExternal(entry.url!)}>
            {entry.externalId}
          </button>
        ) : (
          <span className="num">{entry.externalId}</span>
        )}
        {entry.reporter && entry.reporter !== entry.externalId && <span>{t("inbox.by", { who: entry.reporter })}</span>}
        <span>{agoLabel(entry.receivedAt)}</span>
      </p>
      {entry.body && <pre className="inbox-detail-body">{entry.body}</pre>}

      {entry.status !== "new" && (
        <div className="row inbox-status">
          <Icon name={entry.status === "closed" ? "i-archive" : entry.status === "merged" ? "i-merge" : "i-check"} size={14} />
          <span>
            {entry.status === "closed"
              ? main
                ? t("inbox.status_closed_duplicateOf", { ref: main.externalId })
                : t(entry.closeReason === "duplicate" ? "inbox.status_closed_duplicate" : "inbox.status_closed_wontfix")
              : t(entry.status === "merged" ? "inbox.status_merged" : "inbox.status_accepted", { key: ticket?.key ?? "…" })}
            {entry.shippedIn && ` · ${t("inbox.shippedIn", { version: entry.shippedIn })}`}
          </span>
          {ticket && (
            <button type="button" className="link-inline" onClick={() => onOpenIssue(ticket.id)}>
              {t("inbox.openTicket")}
            </button>
          )}
          <Spacer />
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => actions.reopen.mutate(entry.id, { onError: reportError })}>
            <Icon name="i-undo" size={13} /> {t("inbox.reopen")}
          </button>
        </div>
      )}
      {entry.activityAt !== null && (
        <div className="row inbox-activity" data-testid="inbox-activity">
          <Icon name="i-info" size={14} />
          <span>{t("inbox.activityText", { source: sourceName, when: agoLabel(entry.activityAt) })}</span>
          <Spacer />
          {entry.url && (
            <button type="button" className="btn btn-ghost" onClick={() => openExternal(entry.url!)}>
              {t("inbox.activityOpen")}
            </button>
          )}
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => actions.seen.mutate(entry.id, { onError: reportError })}>
            {t("inbox.activitySeen")}
          </button>
        </div>
      )}
      {entry.reply && (
        <div className="my-report-reply inbox-reply">
          <span className="meta-txt">{t("inbox.yourReply")}</span> {entry.reply}
        </div>
      )}

      <div className="row inbox-detail-actions">
        {entry.status === "new" && (
          <>
            <button type="button" className="btn btn-primary" aria-pressed={mode === "accept"} data-testid="inbox-accept" onClick={() => setMode(mode === "accept" ? null : "accept")}>
              <Icon name="i-plus" size={13} /> {t("inbox.acceptAs")}
            </button>
            <button type="button" className="btn btn-secondary" aria-pressed={mode === "merge"} onClick={() => setMode(mode === "merge" ? null : "merge")}>
              <Icon name="i-merge" size={13} /> {t("inbox.mergeInto")}
            </button>
          </>
        )}
        <button type="button" className="btn btn-secondary" aria-pressed={mode === "reply"} disabled={!source?.canReply} title={source?.canReply ? undefined : t("inbox.noReply", { source: sourceName })} onClick={() => setMode(mode === "reply" ? null : "reply")}>
          <Icon name="i-send" size={13} /> {t("inbox.reply")}
        </button>
        {entry.status === "new" && (
          <>
            <Spacer />
            <button type="button" className="btn btn-ghost" aria-pressed={mode === "duplicate"} disabled={busy} onClick={() => setMode(mode === "duplicate" ? null : "duplicate")}>
              {t("inbox.duplicate")}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => actions.close.mutate({ id: entry.id, reason: "wontfix" }, { onError: reportError })}>
              {t("inbox.wontfix")}
            </button>
          </>
        )}
      </div>

      {mode === "accept" && entry.status === "new" && (
        <div className="panel stack-3 inbox-form">
          <label className="stack-1">
            <span className="meta-txt">{t("inbox.ticketTitle")}</span>
            <input className="input" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && title.trim() && accept()} />
          </label>
          <div className="row">
            <div className="seg quiet" role="radiogroup" aria-label={t("inbox.kindAria")}>
              {KINDS.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {t(`inbox.kind_${k}` as MessageKey)}
                </button>
              ))}
            </div>
            <Spacer />
            <button type="button" className="btn btn-ghost" onClick={() => setMode(null)}>
              {t("inbox.cancel")}
            </button>
            <button type="button" className="btn btn-primary" disabled={!title.trim() || busy} onClick={accept}>
              {t("inbox.accept")}
            </button>
          </div>
        </div>
      )}

      {mode === "merge" && entry.status === "new" && (
        <div className="panel stack-2 inbox-form">
          <input className="input" value={search} autoFocus placeholder={t("inbox.mergeSearch")} aria-label={t("inbox.mergeSearch")} onChange={(e) => setSearch(e.target.value)} />
          {search.trim() && !matches.length && <p className="meta-txt">{t("inbox.mergeNone")}</p>}
          {matches.map((i) => (
            <button
              key={i.id}
              type="button"
              className="inbox-match"
              disabled={busy}
              onClick={() => actions.merge.mutate({ id: entry.id, itemId: i.id }, { onSuccess: () => toast({ body: t("inbox.merged", { key: i.key }) }), onError: reportError })}
            >
              <span className="num">{i.key}</span>
              <span className="inbox-entry-title">{i.title}</span>
            </button>
          ))}
        </div>
      )}

      {mode === "duplicate" && entry.status === "new" && (
        <div className="panel stack-2 inbox-form">
          <input className="input" value={search} autoFocus placeholder={t("inbox.duplicateSearch")} aria-label={t("inbox.duplicateSearch")} onChange={(e) => setSearch(e.target.value)} />
          {!mains.length && <p className="meta-txt">{t("inbox.duplicateNone")}</p>}
          {mains.map((e) => (
            <button key={e.id} type="button" className="inbox-match" disabled={busy} onClick={() => closeAsDuplicate(e.id)}>
              <span className="num">{e.externalId}</span>
              <span className="inbox-entry-title">{e.title}</span>
            </button>
          ))}
          <div className="row">
            <Spacer />
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => closeAsDuplicate()}>
              {t("inbox.duplicateUnnamed")}
            </button>
          </div>
        </div>
      )}

      {mode === "reply" && source?.canReply && (
        <div className="panel stack-2 inbox-form">
          <textarea className="input report-note" rows={4} value={reply} autoFocus placeholder={t("inbox.replyPlaceholder")} onChange={(e) => setReply(e.target.value)} />
          <div className="row">
            <Spacer />
            <button type="button" className="btn btn-ghost" onClick={() => setMode(null)}>
              {t("inbox.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!reply.trim() || actions.reply.isPending}
              onClick={() =>
                actions.reply.mutate(
                  { id: entry.id, text: reply },
                  {
                    onSuccess: () => {
                      setReply("");
                      setMode(null);
                      toast({ body: t("inbox.replied") });
                    },
                    onError: reportError
                  }
                )
              }
            >
              {t("inbox.replySend")}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
