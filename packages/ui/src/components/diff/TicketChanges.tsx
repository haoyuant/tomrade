import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ReviewTarget } from "@tomradex/change-review";
import type { ChangedFile, ChangeScope } from "@tomradex/code-link";
import { Icon } from "~/components/icons";
import { Dialog, DialogHead } from "~/components/ui/dialog";
import { messageOf } from "~/lib/api";
import { scopeOf, scopeValue, useChangeComments, useChanges, useReviewTarget, type ChangesSource } from "~/lib/changes";
import { intlTag } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { DiffView, type DiffComment, type DiffCommentDraft } from "./DiffView";

const BRANCH: ChangeScope = { kind: "branch" };

/**
 * A ticket's changes with what chooses them: the code link when it has several, and the scope (its branch against
 * the base, the working tree where one is here, one commit, one run of an agent, or what came since the last review).
 * The comments on its lines are kept and sent from here too, and the delivery's report is shown above. The diff itself
 * is `DiffView`'s.
 */
export function TicketChanges({ source, viewedKey, onNotice }: { source: ChangesSource; viewedKey: string; onNotice: (text: string) => void }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [linkId, setLinkId] = useState<string>();
  const [scope, setScope] = useState<ChangeScope>(BRANCH);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const read = useChanges(source, { linkId, scope, ignoreWhitespace });
  const changes = read.data;
  // What is shown says which scope it is of: an ask this machine cannot answer comes back as the branch.
  const shownScope = changes?.scope ?? scope;
  const shownLink = changes?.linkId;

  const onLoadFile = useCallback(
    (path: string, opts?: { full?: boolean }) => source.file({ linkId: shownLink, scope: shownScope, ignoreWhitespace, path, full: opts?.full }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, shownLink, scopeValue(shownScope), ignoreWhitespace]
  );

  const open = (file: ChangedFile) =>
    source.open({ linkId: shownLink, path: file.path }).then(
      (where) => onNotice(where === null ? t("diff.openMissing") : where === "system" ? t("diff.openedSystem") : t("diff.openedEditor", { editor: where === "cursor" ? "Cursor" : "VS Code" })),
      () => onNotice(t("diff.openMissing"))
    );

  const kept = useChangeComments(source);
  const target: ReviewTarget | undefined = useReviewTarget(source).data;
  const reach = target && target.kind !== "none" ? target : null;
  const [busy, setBusy] = useState(false);
  // The view is given the shown link's comments; a send takes every link's.
  const comments = useMemo<DiffComment[]>(
    () => (kept.data ?? []).filter((c) => c.linkId === shownLink).map((c) => ({ id: c.id, path: c.path, side: c.side, line: c.line, endLine: c.endLine, quote: c.quote, body: c.body, state: c.state, sent: c.sentAt !== null, createdAt: c.createdAt, finding: c.finding })),
    [kept.data, shownLink]
  );
  const unsent = (kept.data ?? []).filter((c) => c.state === "open" && c.sentAt === null);
  /** A write to the comments: read again whether or not it went, and say why when it did not. */
  const writing = async <T,>(write: () => Promise<T>): Promise<T> => {
    try {
      return await write();
    } catch (error) {
      onNotice(messageOf(error));
      throw error;
    } finally {
      void qc.invalidateQueries({ queryKey: source.commentsKey });
    }
  };
  const addComment = async (draft: DiffCommentDraft) => {
    if (!shownLink) return;
    await writing(() => source.addComment({ ...draft, linkId: shownLink }));
  };
  const editComment = async (id: string, patch: { body?: string; state?: DiffComment["state"] }) => void (await writing(() => source.editComment(id, patch)));
  const removeComment = async (id: string) => void (await writing(() => source.removeComment(id)));

  const markReviewed = async (ids: (string | undefined)[]) => {
    let marked = false;
    for (const id of new Set(ids)) marked = !!(await source.markReviewed({ linkId: id }).catch(() => null)) || marked;
    void qc.invalidateQueries({ queryKey: source.key });
    return marked;
  };
  const send = async () => {
    if (busy || !unsent.length) return;
    setBusy(true);
    try {
      const links = unsent.map((c) => c.linkId);
      const sent = await writing(() => source.sendComments(reach ? undefined : { deliver: false }));
      if (!sent.sent) return;
      // Nowhere to send them: the person passes them on.
      const copied = sent.to !== null || (await navigator.clipboard?.writeText(sent.text).then(() => true, () => false));
      await markReviewed([...links, shownLink]);
      onNotice(sent.to !== null ? t("diff.commentsSent", { count: sent.sent, agent: reach?.agentTitle ?? "" }) : copied ? t("diff.commentsCopied", { count: sent.sent }) : t("diff.commentsCopyFailed"));
    } catch {
      // Said already; the comments stay unsent.
    } finally {
      setBusy(false);
    }
  };
  const mark = async () => {
    if (busy) return;
    setBusy(true);
    try {
      onNotice((await markReviewed([shownLink])) ? t("diff.markedReviewed") : t("diff.markReviewedNone"));
    } finally {
      setBusy(false);
    }
  };

  const day = (at: number) => new Date(at).toLocaleDateString(intlTag(locale), { month: "short", day: "numeric" });
  const minute = (at: number) => new Date(at).toLocaleString(intlTag(locale), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const toolbar = changes ? (
    <>
      {changes.links.length > 1 && (
        <select className="input diff__pick" aria-label={t("diff.linkLabel")} data-testid="changes-link" value={changes.linkId} onChange={(e) => { setLinkId(e.target.value); setScope(BRANCH); }}>
          {changes.links.map((l) => (
            <option key={l.id} value={l.id}>
              {l.repoName ? `${l.repoName} · ${l.branch}` : l.branch}
            </option>
          ))}
        </select>
      )}
      <select className="input diff__pick" aria-label={t("diff.scopeLabel")} data-testid="changes-scope" value={scopeValue(shownScope)} onChange={(e) => setScope(scopeOf(e.target.value))}>
        <option value="branch">{t("diff.scopeBranch")}</option>
        {changes.scopes.includes("uncommitted") && <option value="uncommitted">{t("diff.scopeUncommitted")}</option>}
        {changes.scopes.includes("since") && changes.reviewed && <option value="since">{t("diff.scopeSince", { when: minute(changes.reviewed.at) })}</option>}
        {changes.runs.length > 0 && (
          <optgroup label={t("diff.scopeRuns", { count: changes.runs.length })}>
            {changes.runs.map((r) => {
              const run = `${r.source} · ${minute(r.startedAt)}`;
              return (
                <option key={r.id} value={`run:${r.id}`}>
                  {r.before && r.after ? run : t("diff.scopeRunNoDiff", { run })}
                </option>
              );
            })}
          </optgroup>
        )}
        {changes.commits.length > 0 && (
          <optgroup label={t("diff.scopeCommits", { count: changes.commits.length })}>
            {changes.commits.map((c) => (
              <option key={c.sha} value={`commit:${c.sha}`}>
                {`${c.sha.slice(0, 7)} ${c.subject} · ${day(c.at)}`}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <button type="button" className="btn btn-ghost" data-testid="changes-mark-reviewed" disabled={busy} title={changes.reviewed ? t("diff.reviewedAt", { when: minute(changes.reviewed.at) }) : t("diff.markReviewedHint")} onClick={() => void mark()}>
        {t("diff.markReviewed")}
      </button>
    </>
  ) : null;
  const sendControl = (
    <button type="button" className="btn btn-secondary" data-testid="changes-send-comments" disabled={busy || !unsent.length} title={reach || !unsent.length ? t("diff.sendCommentsHint") : t("diff.copyCommentsHint")} onClick={() => void send()}>
      {!unsent.length ? t("diff.sendCommentsIdle") : reach ? t("diff.sendComments", { count: unsent.length, agent: reach.agentTitle }) : t("diff.copyComments", { count: unsent.length })}
    </button>
  );

  return (
    <>
      {changes?.report && (
        <details className="diff__report" data-testid="changes-report" open>
          <summary>{t("diff.reportTitle")}</summary>
          <div className="diff__report-body">{changes.report}</div>
        </details>
      )}
      <DiffView
        changes={changes}
        loading={read.isFetching}
        ignoreWhitespace={ignoreWhitespace}
        onIgnoreWhitespace={setIgnoreWhitespace}
        onLoadFile={onLoadFile}
        viewedKey={viewedKey}
        toolbar={toolbar}
        comments={comments}
        onAddComment={addComment}
        onEditComment={editComment}
        onRemoveComment={removeComment}
        commentsAction={sendControl}
        fileActions={
          changes?.root
            ? (file) =>
                file.status === "deleted" ? null : (
                  <button type="button" className="btn btn-icon" data-testid="changes-open" aria-label={t("diff.openInEditor")} title={t("diff.openInEditor")} onClick={() => void open(file)}>
                    <Icon name="i-popout" size={14} />
                  </button>
                )
            : undefined
        }
      />
    </>
  );
}

/** A ticket's changes in a sheet wide enough to read a diff side by side. */
export function ChangesDialog({ open, onOpenChange, title, source, viewedKey, onNotice }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; source: ChangesSource; viewedKey: string; onNotice: (text: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={title} className="sheet-changes" resizable="changes" movable>
      <DialogHead title={title} />
      <div className="changes-sheet" data-testid="changes-sheet">
        <TicketChanges source={source} viewedKey={viewedKey} onNotice={onNotice} />
      </div>
    </Dialog>
  );
}
