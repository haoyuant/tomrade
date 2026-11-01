import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TakeoverDraft, TakeoverEntry } from "@tomradex/takeover";
import { useChooseRepoFolder, useLinkLoneWorkstream } from "~/components/projects/RepositoriesBlock";
import { Eyebrow, Tag } from "~/components/ui/atoms";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { useI18n } from "~/lib/i18n";
import { keys } from "~/lib/queries";
import { openExternal } from "~/lib/shell";
import { useTakeoverApply, useTakeoverOffer, useTakeoverScan } from "~/lib/takeover";
import { errorSpec, useToast } from "~/lib/toast";

/** Before anything is read: what will be, and to whom it would go. Sessions and the model each wait for their own tick. */
function Consent({ projectId, scanning, onScan }: { projectId: string; scanning: boolean; onScan: (input: { sessions: boolean; model: string | null }) => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const offer = useTakeoverOffer(projectId);
  const folder = useChooseRepoFolder(projectId);
  const linkLone = useLinkLoneWorkstream(projectId);
  const [sessions, setSessions] = useState(false);
  const [useModel, setUseModel] = useState(false);
  const repos = offer.data?.repos ?? [];
  const records = offer.data?.sessions ?? [];
  const model = offer.data?.model ?? null;
  const folders = records.map((r) => `${r.title} (${r.folders.join(", ")})`).join("; ");

  const addRepo = async () => {
    const added = await folder.choose();
    if (!added) return;
    linkLone(added.repo);
    void qc.invalidateQueries({ queryKey: keys.takeover.offer(projectId) });
  };

  return (
    <>
      <DialogBody className="stack-3">
        <p className="meta-txt">{t("takeover.lede")}</p>
        <Eyebrow>{t("takeover.reposHeading")}</Eyebrow>
        {offer.data && repos.length === 0 && <p className="meta-txt">{t("takeover.noRepos")}</p>}
        <div className="row" style={{ gap: "var(--space-2)", flexWrap: "wrap" }}>
          {repos.map((repo) => (
            <Tag key={repo.id} tone={repo.placed ? "neutral" : "faint"} title={repo.placed ? undefined : t("takeover.notPlaced")}>
              {repo.name}
              {repo.placed ? "" : ` · ${t("takeover.notPlaced")}`}
            </Tag>
          ))}
          <button type="button" className="btn btn-ghost" data-testid="takeover-add-repo" disabled={folder.busy} onClick={() => void addRepo()}>
            {folder.busy ? t("takeover.addingRepo") : t("takeover.addRepo")}
          </button>
        </div>
        <Eyebrow>{t("takeover.readsHeading")}</Eyebrow>
        <p className="meta-txt">{t("takeover.readsFacts")}</p>
        <label className="cfg-row" style={{ cursor: records.length ? "pointer" : undefined }}>
          <input type="checkbox" data-testid="takeover-sessions" checked={sessions} disabled={!records.length} onChange={(e) => setSessions(e.target.checked)} />
          <span className="cfg-name">{t("takeover.sessionsLabel")}</span>
        </label>
        <p className="meta-txt" data-testid="takeover-sessions-note">{records.length ? t("takeover.sessionsFolders", { folders }) : t("takeover.sessionsNone")}</p>
        {model ? (
          <>
            <label className="cfg-row" style={{ cursor: "pointer" }}>
              <input type="checkbox" data-testid="takeover-model" checked={useModel} onChange={(e) => setUseModel(e.target.checked)} />
              <span className="cfg-name">{t("takeover.modelLabel", { model })}</span>
            </label>
            <p className="meta-txt" data-testid="takeover-model-note">{useModel ? t(sessions ? "takeover.modelSendsSessions" : "takeover.modelSends", { model }) : t("takeover.modelOff")}</p>
          </>
        ) : (
          offer.data && <p className="meta-txt" data-testid="takeover-model-note">{offer.data.modelMissing ? t("takeover.modelNone", { reason: offer.data.modelMissing }) : t("takeover.modelNoneBare")}</p>
        )}
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-primary" data-testid="takeover-scan" disabled={scanning || !repos.some((r) => r.placed)} onClick={() => onScan({ sessions, model: useModel ? model : null })}>
          {scanning ? t("takeover.scanning") : t("takeover.scan")}
        </button>
      </DialogFoot>
    </>
  );
}

function EntryRow({ entry, titleOf, ticked, onToggle }: { entry: TakeoverEntry; titleOf: (id: string) => string; ticked: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <div className="inbox-row" data-testid="takeover-entry" style={{ justifyContent: "flex-start" }}>
      <input type="checkbox" aria-label={entry.title} data-testid="takeover-tick" checked={ticked} onChange={onToggle} style={{ marginTop: 3, flexShrink: 0 }} />
      <div className="inbox-main">
        <span className="inbox-title" style={{ whiteSpace: "normal" }}>{entry.title}</span>
        {entry.summary && <span className="meta-txt">{entry.summary}</span>}
        {entry.dependsOn.length > 0 && <span className="meta-txt" data-testid="takeover-needs">{t("takeover.needs", { titles: entry.dependsOn.map(titleOf).join(", ") })}</span>}
        {entry.similar && <span className="meta-txt">⚠ {t("takeover.similar", { key: entry.similar.key, title: entry.similar.title })}</span>}
        {entry.covered && <span className="meta-txt">⚠ {t("takeover.covered")}</span>}
        {entry.sources.map((s) => (
          <span className="meta-txt" key={`${s.kind}:${s.ref}`} data-testid="takeover-source" style={{ overflowWrap: "anywhere" }}>
            <Tag tone="faint">{s.label}</Tag>{" "}
            {s.url ? (
              <button type="button" className="link-btn num" onClick={() => openExternal(s.url!)}>{s.ref}</button>
            ) : (
              <span className="num">{s.ref}</span>
            )}
            {s.detail ? ` · ${s.detail}` : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The draft: nothing is ticked until the person ticks it, and only what is ticked is written. */
function Draft({ draft, projectId, onBack, onDone }: { draft: TakeoverDraft; projectId: string; onBack: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const apply = useTakeoverApply(projectId);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const titles = new Map(draft.entries.map((e) => [e.id, e.title]));
  const toggle = (id: string) =>
    setTicked((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const submit = () =>
    apply.mutate(
      { draftId: draft.id, entryIds: [...ticked] },
      {
        onSuccess: (r) => {
          toast({ body: r.failed.length ? t("takeover.appliedSome", { n: r.created.length, failed: r.failed.length, reason: r.failed[0]!.reason }) : t("takeover.applied", { n: r.created.length }) });
          onDone();
        },
        onError: (e) => toast(errorSpec(e))
      }
    );

  return (
    <>
      <DialogBody className="stack-3">
        <div className="row" style={{ justifyContent: "space-between", gap: "var(--space-3)", flexWrap: "wrap" }}>
          <span className="meta-txt" data-testid="takeover-summary">
            {t("takeover.summary", { n: draft.entries.length, picked: ticked.size })} · {draft.model ? t("takeover.organisedBy", { model: draft.model }) : t("takeover.factsOnly")}
          </span>
          {draft.entries.length > 0 && (
            <span className="row" style={{ gap: "var(--space-2)" }}>
              <button type="button" className="btn btn-ghost" data-testid="takeover-tick-all" onClick={() => setTicked(new Set(draft.entries.map((e) => e.id)))}>{t("takeover.tickAll")}</button>
              <button type="button" className="btn btn-ghost" onClick={() => setTicked(new Set())}>{t("takeover.tickNone")}</button>
            </span>
          )}
        </div>
        {draft.notes.map((note) => (
          <p className="meta-txt" key={note} data-testid="takeover-note">{note}</p>
        ))}
        {draft.entries.length === 0 && <p className="meta-txt">{t("takeover.empty")}</p>}
        <div className="inbox-list">
          {draft.entries.map((entry) => (
            <EntryRow key={entry.id} entry={entry} titleOf={(id) => titles.get(id) ?? id} ticked={ticked.has(entry.id)} onToggle={() => toggle(entry.id)} />
          ))}
        </div>
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" disabled={apply.isPending} onClick={onBack}>{t("takeover.back")}</button>
        <button type="button" className="btn btn-primary" data-testid="takeover-apply" disabled={!ticked.size || apply.isPending} onClick={submit}>
          {apply.isPending ? t("takeover.applying") : t("takeover.apply", { n: ticked.size })}
        </button>
      </DialogFoot>
    </>
  );
}

export function TakeoverDialog({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const scan = useTakeoverScan(projectId);
  const [draft, setDraft] = useState<TakeoverDraft | null>(null);
  useEffect(() => {
    if (!open) setDraft(null);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("takeover.title")}>
      <DialogHead title={t("takeover.title")} />
      {draft ? (
        <Draft draft={draft} projectId={projectId} onBack={() => setDraft(null)} onDone={() => onOpenChange(false)} />
      ) : (
        <Consent projectId={projectId} scanning={scan.isPending} onScan={(input) => scan.mutate(input, { onSuccess: setDraft, onError: (e) => toast(errorSpec(e)) })} />
      )}
    </Dialog>
  );
}
