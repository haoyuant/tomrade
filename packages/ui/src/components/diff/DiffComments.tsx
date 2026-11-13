import { useEffect, useRef, useState } from "react";
import { FoldChevron } from "~/components/ui/atoms";
import { useI18n, type MessageKey } from "~/lib/i18n";
// By path, not alias: the diff's tests load these as they are, and only stand in for what is aliased.
import { agoLabel } from "../../lib/domain";
import { isCancelKey, isCommitKey } from "../../lib/keys";
import type { Anchor, CommentSide, DiffComment, Place } from "./anchors";

/** A file's comments as its body draws them. */
export interface FileNotes {
  placed: { comment: DiffComment; place: Place }[];
  /** Their lines are no longer in the diff. */
  outdated: DiffComment[];
  /** The comment being written, when it is on this file. */
  draft: { anchor: Anchor; place: Place | null } | null;
  /** The comment being edited. */
  editing: string | null;
}

/** What the rows of a diff can do about comments. One object for the life of the view, so memoized files keep still. */
export interface NoteActions {
  canAdd: boolean;
  canEdit: boolean;
  canRemove: boolean;
  /** Starts a comment on a line, or with `extend` stretches the one being written to it. */
  pick(path: string, hunk: number, index: number, extend: boolean): void;
  /** What is typed and not yet saved, kept above the rows so a redraw does not lose it: `new` for the composer, an id for that comment's edit. */
  typed(slot: string): string;
  type(slot: string, text: string): void;
  saveDraft(): Promise<void>;
  cancelDraft(): void;
  startEdit(comment: DiffComment): void;
  saveEdit(id: string): Promise<void>;
  cancelEdit(): void;
  setState(id: string, state: DiffComment["state"]): void;
  remove(id: string): void;
}

/** The slot `NoteActions.typed` keeps the composer's text under. */
export const NEW_SLOT = "new";

type Translate = ReturnType<typeof useI18n>["t"];

/** "Line 12", "Lines 12–14", and that it is the old side when it is. */
export const linesLabel = (t: Translate, side: CommentSide, line: number, endLine: number): string => {
  const lines = line === endLine ? t("diff.commentLine", { line }) : t("diff.commentLines", { from: line, to: endLine });
  return side === "old" ? t("diff.commentOldSide", { lines }) : lines;
};

function TextBox({ slot, actions, saveLabel, hint, onSave, onCancel }: { slot: string; actions: NoteActions; saveLabel: string; hint?: string; onSave: () => Promise<void>; onCancel: () => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(() => actions.typed(slot));
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const cancel = useRef(onCancel);
  useEffect(() => {
    cancel.current = onCancel;
  });

  useEffect(() => {
    // A sheet hears Escape on the document before React does; heard here first, it closes this box and not the sheet.
    const onKey = (e: KeyboardEvent) => {
      if (e.target !== box.current || !isCancelKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      cancel.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const save = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      await onSave();
    } catch {
      // The surface says what went wrong; what was typed stays.
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <textarea
        ref={box}
        className="textarea diff__comment-text"
        autoFocus
        rows={3}
        placeholder={t("diff.commentPlaceholder")}
        aria-label={t("diff.commentPlaceholder")}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          actions.type(slot, e.target.value);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && isCommitKey(e)) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="diff__comment-actions">
        <button type="button" className="btn btn-primary btn-xs" disabled={busy || !text.trim()} title={t("diff.commentSaveKeys")} data-testid="diff-comment-save" onClick={() => void save()}>
          {saveLabel}
        </button>
        <button type="button" className="btn btn-ghost btn-xs" onClick={onCancel}>
          {t("diff.commentCancel")}
        </button>
        {hint && <span className="meta-txt">{hint}</span>}
      </div>
    </>
  );
}

/** The comment being written, under the lines it is on. */
export function Composer({ anchor, place, actions }: { anchor: Anchor; place: Place | null; actions: NoteActions }) {
  const { t } = useI18n();
  return (
    <div className="diff__note" data-testid="diff-composer">
      <div className="diff__comment diff__comment--draft">
        <div className="diff__comment-head">
          <span className="meta-txt">{linesLabel(t, anchor.side, place?.line ?? anchor.line, place?.endLine ?? anchor.endLine)}</span>
          {!place && <span className="tag faint">{t("diff.commentOutdated")}</span>}
        </div>
        {!place && <pre className="diff__quote">{anchor.quote}</pre>}
        <TextBox slot={NEW_SLOT} actions={actions} saveLabel={t("diff.commentSave")} hint={t("diff.commentRangeHint")} onSave={actions.saveDraft} onCancel={actions.cancelDraft} />
      </div>
    </div>
  );
}

const SEVERITY: Record<NonNullable<DiffComment["finding"]>["severity"], MessageKey> = { info: "diff.findingInfo", warning: "diff.findingWarning", error: "diff.findingError" };

/** What tells an agent's finding from a person's comment: that it is one, and how much it matters. */
export function FindingTag({ comment }: { comment: DiffComment }) {
  const { t } = useI18n();
  const finding = comment.finding;
  if (!finding) return null;
  return (
    <span className={`tag diff__finding diff__finding--${finding.severity}`} title={finding.reviewer} data-testid="diff-finding">
      {t("diff.finding")} · {t(SEVERITY[finding.severity])}
    </span>
  );
}

/** One comment: under its lines, or with its quote at the top of the file when those lines are gone. Resolved, it folds to a line. */
export function CommentNote({ comment, place, editing, actions }: { comment: DiffComment; place: Place | null; editing: boolean; actions: NoteActions }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const resolved = comment.state === "resolved";
  const folded = resolved && !open && !editing;
  const toggle = () => setOpen((o) => !o);
  return (
    <div className={`diff__note${resolved ? " is-resolved" : ""}`} data-comment-id={comment.id} data-testid="diff-comment">
      {resolved && <FoldChevron open={!folded} label={t("diff.commentToggle")} onToggle={toggle} />}
      <div className="diff__comment">
        <div className="diff__comment-head" onClick={resolved ? toggle : undefined}>
          <span className="meta-txt">{linesLabel(t, comment.side, place?.line ?? comment.line, place?.endLine ?? comment.endLine)}</span>
          {resolved && <span className="tag faint">{t("diff.commentResolved")}</span>}
          {!place && <span className="tag faint">{t("diff.commentOutdated")}</span>}
          {folded ? (
            <span className="diff__comment-brief">{comment.body}</span>
          ) : (
            <>
              <span className="meta-txt">{agoLabel(comment.createdAt)}</span>
              <FindingTag comment={comment} />
              {comment.sent && <span className="tag faint">{t("diff.commentSent")}</span>}
            </>
          )}
          <span className="diff__comment-tools" onClick={(e) => e.stopPropagation()}>
            {actions.canEdit && !resolved && !editing && (
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => actions.startEdit(comment)}>
                {t("diff.commentEdit")}
              </button>
            )}
            {actions.canEdit && !editing && (
              <button type="button" className="btn btn-ghost btn-xs" data-testid="diff-comment-resolve" onClick={() => actions.setState(comment.id, resolved ? "open" : "resolved")}>
                {t(resolved ? "diff.commentReopen" : "diff.commentResolve")}
              </button>
            )}
            {actions.canRemove && !folded && !editing && (
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => actions.remove(comment.id)}>
                {t("diff.commentDelete")}
              </button>
            )}
          </span>
        </div>
        {!place && !folded && <pre className="diff__quote">{comment.quote}</pre>}
        {!folded &&
          (editing ? (
            <TextBox slot={comment.id} actions={actions} saveLabel={t("diff.commentSaveEdit")} onSave={() => actions.saveEdit(comment.id)} onCancel={actions.cancelEdit} />
          ) : (
            <div className="diff__comment-body">{comment.body}</div>
          ))}
      </div>
    </div>
  );
}
