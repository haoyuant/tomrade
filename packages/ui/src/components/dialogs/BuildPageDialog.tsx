import { useEffect, useState } from "react";
import type { BuildPagePreview, BuildPageState, Candidate, PageConfig } from "@tomradex/build-page";
import { Eyebrow } from "~/components/ui/atoms";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { useBuildPagePreview, useBuildPagePublish, useBuildPageState } from "~/lib/build-page";
import { intlTag } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { openExternal } from "~/lib/shell";
import { errorSpec, useToast } from "~/lib/toast";

function Group({ title, rows, picks, onToggle }: { title: string; rows: Candidate[]; picks: ReadonlySet<string>; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  return (
    <>
      <Eyebrow>{title}</Eyebrow>
      {rows.length === 0 && <p className="meta-txt">{t("buildPage.none")}</p>}
      <div className="inbox-list">
        {rows.map((c) => (
          <label key={c.id} className="inbox-row" data-testid="build-page-candidate" style={{ justifyContent: "flex-start", cursor: "pointer" }}>
            <input type="checkbox" aria-label={c.title} data-testid="build-page-tick" checked={picks.has(c.id)} onChange={() => onToggle(c.id)} style={{ marginTop: 3, flexShrink: 0 }} />
            <span className="inbox-main">
              <span className="inbox-title" style={{ whiteSpace: "normal" }}>{c.title}</span>
              <span className="meta-txt num">{c.key}</span>
            </span>
          </label>
        ))}
      </div>
    </>
  );
}

/** What goes on the page. Nothing starts ticked; the saved ticks come back next time. */
function Choose({ state, initial, busy, onPreview }: { state: BuildPageState; initial: PageConfig; busy: boolean; onPreview: (config: PageConfig) => void }) {
  const { t, locale } = useI18n();
  const [repo, setRepo] = useState(initial.repo ?? state.repos[0] ?? "");
  const [title, setTitle] = useState(initial.title);
  const [footer, setFooter] = useState(initial.footer);
  const [picks, setPicks] = useState<ReadonlySet<string>>(new Set(initial.picks));
  const toggle = (id: string) =>
    setPicks((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const offered = (section: Candidate["section"]) => state.candidates.filter((c) => c.section === section);
  const ticked = state.candidates.filter((c) => picks.has(c.id)).length;
  const published = state.published;

  return (
    <>
      <DialogBody className="stack-3">
        <p className="meta-txt">{t("buildPage.lede")}</p>
        {state.repos.length === 0 ? (
          <p className="meta-txt" data-testid="build-page-no-repo">{t("buildPage.noRepo")}</p>
        ) : (
          <label className="field">
            {t("buildPage.repo")}
            <select className="select" data-testid="build-page-repo" value={repo} onChange={(e) => setRepo(e.target.value)}>
              {state.repos.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>
        )}
        {!state.connected && <p className="meta-txt">{t("buildPage.notConnected")}</p>}
        <label className="field">
          {t("buildPage.pageTitle")}
          <input className="input" data-testid="build-page-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="cfg-row" style={{ cursor: "pointer" }}>
          <input type="checkbox" data-testid="build-page-footer" checked={footer} onChange={(e) => setFooter(e.target.checked)} />
          <span className="cfg-name">{t("buildPage.footer")}</span>
        </label>
        {repo && <p className="meta-txt">{t("buildPage.feedbackNote", { repo })}</p>}
        {published && (
          <p className="meta-txt" data-testid="build-page-last">
            {t("buildPage.lastPublished", { date: new Date(published.at).toLocaleString(intlTag(locale)) })}
            {published.url && (
              <>
                {" · "}
                <button type="button" className="link-btn" onClick={() => openExternal(published.url!)}>{t("buildPage.open")}</button>
              </>
            )}
          </p>
        )}
        <Group title={t("buildPage.roadmap")} rows={offered("roadmap")} picks={picks} onToggle={toggle} />
        <Group title={t("buildPage.changelog")} rows={offered("changelog")} picks={picks} onToggle={toggle} />
      </DialogBody>
      <DialogFoot>
        <span className="meta-txt" data-testid="build-page-picked" style={{ marginRight: "auto" }}>{t("buildPage.picked", { n: ticked })}</span>
        <button type="button" className="btn btn-primary" data-testid="build-page-preview" disabled={busy || !repo} onClick={() => onPreview({ repo, title, footer, picks: [...picks] })}>
          {busy ? t("buildPage.previewing") : t("buildPage.preview")}
        </button>
      </DialogFoot>
    </>
  );
}

/** The very page that publishing writes: the frame shows the preview's html, and publishing names this preview. */
function Preview({ projectId, preview, onBack, onDone }: { projectId: string; preview: BuildPagePreview; onBack: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const publish = useBuildPagePublish(projectId);
  const submit = () =>
    publish.mutate(preview.id, {
      onSuccess: (r) => {
        toast({ body: r.warning ?? (r.url ? t("buildPage.publishedAt", { url: r.url }) : t("buildPage.published")) });
        onDone();
      },
      onError: (e) => toast(errorSpec(e))
    });
  return (
    <>
      <DialogBody className="stack-3">
        <p className="meta-txt" data-testid="build-page-preview-lede">{t("buildPage.previewLede", { roadmap: preview.roadmap, changelog: preview.changelog })}</p>
        <iframe title={t("buildPage.preview")} data-testid="build-page-frame" sandbox="" srcDoc={preview.html} style={{ width: "100%", height: "55vh", border: "1px solid var(--border)", borderRadius: 8, background: "#fff" }} />
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" disabled={publish.isPending} onClick={onBack}>{t("buildPage.back")}</button>
        <button type="button" className="btn btn-primary" data-testid="build-page-publish" disabled={publish.isPending} onClick={submit}>
          {publish.isPending ? t("buildPage.publishing") : t("buildPage.publish")}
        </button>
      </DialogFoot>
    </>
  );
}

export function BuildPageDialog({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const state = useBuildPageState(projectId, open);
  const render = useBuildPagePreview(projectId);
  const [preview, setPreview] = useState<BuildPagePreview | null>(null);
  /** What was last sent to preview, so Back returns to the same ticks. */
  const [asked, setAsked] = useState<PageConfig | null>(null);
  useEffect(() => {
    if (!open) {
      setPreview(null);
      setAsked(null);
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("buildPage.title")}>
      <DialogHead title={t("buildPage.title")} />
      {preview ? (
        <Preview projectId={projectId} preview={preview} onBack={() => setPreview(null)} onDone={() => onOpenChange(false)} />
      ) : state.data ? (
        <Choose
          state={state.data}
          initial={asked ?? state.data.config}
          busy={render.isPending}
          onPreview={(config) => {
            setAsked(config);
            render.mutate(config, { onSuccess: setPreview, onError: (e) => toast(errorSpec(e)) });
          }}
        />
      ) : (
        <DialogBody>{state.error && <p className="meta-txt">{state.error instanceof Error ? state.error.message : String(state.error)}</p>}</DialogBody>
      )}
    </Dialog>
  );
}
