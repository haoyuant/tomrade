import { useI18n } from "~/lib/i18n";
import type { DiffComment, Place } from "./anchors";
import { FilePath } from "./DiffFile";

/** A comment as the list names it: where it sits now, or why it sits nowhere. */
export interface ListedComment {
  comment: DiffComment;
  /** Null when its lines are gone, or its file is not drawn. */
  place: Place | null;
  /** Its file is in the diff with its hunks read, so a missing place means the lines changed. */
  drawn: boolean;
  /** Its file is in the diff, so choosing it can at least go there. */
  reachable: boolean;
}

/** Every comment of the changes, open ones first; choosing one goes to it. */
export function CommentsList({ rows, onJump }: { rows: ListedComment[]; onJump: (comment: DiffComment) => void }) {
  const { t } = useI18n();
  if (!rows.length) return <div className="diff__comments meta-txt">{t("diff.commentsEmpty")}</div>;
  return (
    <div className="diff__comments" data-testid="diff-comments">
      {rows.map(({ comment, place, drawn, reachable }) => {
        const line = place?.line ?? comment.line;
        const endLine = place?.endLine ?? comment.endLine;
        return (
          <button key={comment.id} type="button" className={`diff__comments-item${comment.state === "resolved" ? " is-resolved" : ""}`} disabled={!reachable} onClick={() => onJump(comment)}>
            <span className="diff__comments-where num" title={comment.path}>
              <FilePath path={comment.path} />:{line === endLine ? line : `${line}–${endLine}`}
            </span>
            {comment.state === "resolved" && <span className="tag faint">{t("diff.commentResolved")}</span>}
            {!place && <span className="tag faint">{t(drawn ? "diff.commentOutdated" : "diff.commentNotInDiff")}</span>}
            {comment.sent && <span className="tag faint">{t("diff.commentSent")}</span>}
            <span className="diff__comment-brief">{comment.body}</span>
          </button>
        );
      })}
    </div>
  );
}
