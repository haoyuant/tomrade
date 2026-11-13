import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ChangedFile, ChangeScope, ChangesView } from "@tomradex/code-link";
import { Icon } from "~/components/icons";
import { FoldChevron } from "~/components/ui/atoms";
import { useI18n } from "~/lib/i18n";
import { pickAnchor, placeAnchor, type Anchor, type DiffComment, type DiffCommentDraft } from "./anchors";
import { CommentsList, type ListedComment } from "./CommentsList";
import { NEW_SLOT, type FileNotes, type NoteActions } from "./DiffComments";
import { DiffFile, fileCounts, FilePath, FileStatus, type DiffLayout, type FileLoad } from "./DiffFile";
import { quietReason } from "./rows";
import { fileVersion, isViewed, markViewed, readViewed, writeViewed, type ViewedMarks } from "./viewed";

export type { DiffComment, DiffCommentDraft } from "./anchors";

export interface DiffViewProps {
  /** What to draw; null or undefined while there is nothing (yet). */
  changes: ChangesView | null | undefined;
  /** The changes are being read: alone it shows the loading state, over earlier changes it only marks the view busy. */
  loading?: boolean;
  ignoreWhitespace: boolean;
  onIgnoreWhitespace: (next: boolean) => void;
  /**
   * Reads one file apart from the list: its hunks when they were left out or cut short, or with `full` the whole
   * file around them (one hunk holding every line), for unfolding the lines between hunks. Without it those stay shut.
   */
  onLoadFile?: (path: string, opts?: { full?: boolean }) => Promise<ChangedFile | null>;
  /** Where viewed marks are remembered (a ticket's id, say); without it they last as long as the view. */
  viewedKey?: string;
  /** Extra controls in a file's header, such as opening it in an editor. */
  fileActions?: (file: ChangedFile) => ReactNode;
  /** The surface's own controls (scope, commit, code link), ahead of the view's. */
  toolbar?: ReactNode;
  /** The comments on these changes. The view pins each to its lines; it keeps none itself. */
  comments?: DiffComment[];
  /** Lets a line, or a range of lines, be commented on. A rejection keeps what was typed. */
  onAddComment?: (comment: DiffCommentDraft) => Promise<void> | void;
  onEditComment?: (id: string, patch: { body?: string; state?: DiffComment["state"] }) => Promise<void> | void;
  onRemoveComment?: (id: string) => Promise<void> | void;
  /** The surface's control for the comments as a whole (sending them, say), beside their count. */
  commentsAction?: ReactNode;
}

const LAYOUT_KEY = "tomrade.diff.layout";
/** Narrower than this, two columns of code are too short to read. */
const SPLIT_MIN = 880;
/** Narrower than this, the file list folds above the files instead of sitting beside them. */
const LIST_MIN = 720;
/** The space above a file in the scrolling box (`--space-3`), and what a change keeps above it when the keys scroll to it. */
const FILE_MARGIN = 12;
const STOP_LEAD = 44;
const NO_LINES: readonly number[] = [];
/** How long a chosen comment is looked for while its file opens and draws: this many tries, this far apart. */
const SEEK_TRIES = 20;
const SEEK_MS = 50;

function storedLayout(): DiffLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

const scopeKey = (scope: ChangeScope): string => (scope.kind === "commit" ? `commit:${scope.sha}` : scope.kind === "run" ? `run:${scope.id}` : scope.kind);

/** What was read for single files, for one set of changes; another set starts empty. */
interface Fetched {
  of: string;
  files: Record<string, ChangedFile | "loading" | "failed">;
}

/** A ticket's changes, read-only: the files beside their diffs, unified or side by side. It reads nothing itself. */
export function DiffView({ changes, loading, ignoreWhitespace, onIgnoreWhitespace, onLoadFile, viewedKey, fileActions, toolbar, comments, onAddComment, onEditComment, onRemoveComment, commentsAction }: DiffViewProps) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [choice, setChoice] = useState<DiffLayout>(storedLayout);
  const [listOpen, setListOpen] = useState(false);
  const [marks, setMarks] = useState<ViewedMarks>(() => readViewed(viewedKey));
  const [marksOf, setMarksOf] = useState(viewedKey);
  const [opens, setOpens] = useState<Record<string, boolean>>({});
  const [unfolded, setUnfolded] = useState<Record<string, number[]>>({});
  const [fetched, setFetched] = useState<Fetched>({ of: "", files: {} });
  /** The comment being written: where, not what. What is typed is kept in `typed`, so typing redraws no file. */
  const [draft, setDraft] = useState<(Anchor & { path: string }) | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const typed = useRef<Record<string, string>>({});
  const seeking = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(seeking.current), []);

  const shown = !!changes;

  if (marksOf !== viewedKey) {
    setMarksOf(viewedKey);
    setMarks(readViewed(viewedKey));
  }

  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    watch.observe(el);
    return () => watch.disconnect();
    // The root is only there once there are changes to draw.
  }, [shown]);

  const narrow = width !== null && width < SPLIT_MIN;
  const layout: DiffLayout = narrow ? "unified" : choice;
  const stacked = width !== null && width < LIST_MIN;
  const pick = (next: DiffLayout) => {
    setChoice(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // the choice lasts for this view
    }
  };

  const identity = changes ? [changes.linkId, scopeKey(changes.scope), changes.base, changes.head, ignoreWhitespace].join("|") : "";
  const listed = changes?.files;
  const keyOf = useCallback((file: ChangedFile, full: boolean) => `${file.path}\0${fileVersion(file)}\0${full ? "full" : "part"}`, []);
  const read = fetched.of === identity ? fetched.files : undefined;

  /** Each listed file as it is drawn: with the hunks, or the picture, read for it apart, when there are any. A file nothing was read for stays the same object. */
  const drawn = useMemo(
    () =>
      (listed ?? []).map((file) => {
        const full = read?.[keyOf(file, true)];
        const part = read?.[keyOf(file, false)];
        const got = typeof full === "object" ? full : typeof part === "object" ? part : null;
        const state = [full, part].includes("loading") ? "loading" : [full, part].includes("failed") ? "failed" : "idle";
        return { listed: file, file: got ? { ...file, hunks: got.hunks, truncated: got.truncated, ...(got.image !== undefined ? { image: got.image } : {}) } : file, load: state as FileLoad };
      }),
    [listed, read, keyOf]
  );

  /** Each file's comments pinned to its lines as they are now. A file with none has no entry, so its body is left alone. */
  const notes = useMemo(() => {
    const out = new Map<string, FileNotes>();
    if (!comments?.length && !draft) return out;
    const byAge = [...(comments ?? [])].sort((a, b) => a.createdAt - b.createdAt);
    for (const { file } of drawn) {
      const mine = byAge.filter((comment) => comment.path === file.path);
      const writing = draft?.path === file.path ? draft : null;
      const hunks = file.hunks;
      if (!hunks || (!mine.length && !writing)) continue;
      const pinned = mine.map((comment) => ({ comment, place: placeAnchor(comment, hunks) }));
      out.set(file.path, {
        placed: pinned.flatMap(({ comment, place }) => (place ? [{ comment, place }] : [])),
        outdated: pinned.flatMap(({ comment, place }) => (place ? [] : [comment])),
        draft: writing ? { anchor: writing, place: placeAnchor(writing, hunks) } : null,
        editing
      });
    }
    return out;
  }, [comments, draft, editing, drawn]);

  const listedComments = useMemo<ListedComment[]>(() => {
    const rows = (comments ?? []).map((comment) => {
      const at = drawn.findIndex((d) => d.listed.path === comment.path);
      const place = notes.get(comment.path)?.placed.find((p) => p.comment.id === comment.id)?.place ?? null;
      return { comment, place, drawn: !!drawn[at]?.file.hunks, reachable: at >= 0, at: at < 0 ? Infinity : at };
    });
    const resolved = (row: ListedComment) => Number(row.comment.state === "resolved");
    return rows.sort((a, b) => resolved(a) - resolved(b) || a.at - b.at || a.comment.path.localeCompare(b.comment.path) || (a.place?.line ?? a.comment.line) - (b.place?.line ?? b.comment.line));
  }, [comments, drawn, notes]);

  const openNotes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of comments ?? []) if (comment.state === "open") counts.set(comment.path, (counts.get(comment.path) ?? 0) + 1);
    return counts;
  }, [comments]);

  // The handlers below are handed to memoized file bodies, so they read what is current from here instead of changing with it.
  const live = useRef({ identity, listed, onLoadFile, read, drawn, draft, editing, onAddComment, onEditComment, onRemoveComment });
  useEffect(() => {
    live.current = { identity, listed, onLoadFile, read, drawn, draft, editing, onAddComment, onEditComment, onRemoveComment };
  });

  const canAdd = !!onAddComment;
  const canEdit = !!onEditComment;
  const canRemove = !!onRemoveComment;
  const noteActions = useMemo<NoteActions>(
    () => ({
      canAdd,
      canEdit,
      canRemove,
      pick(path, h, index, extend) {
        const now = live.current;
        const hunks = now.drawn.find((d) => d.listed.path === path)?.file.hunks;
        const anchor = hunks ? pickAnchor(hunks, h, index, extend && now.draft?.path === path ? now.draft : null) : null;
        if (anchor) setDraft({ path, ...anchor });
      },
      typed: (slot) => typed.current[slot] ?? "",
      type(slot, text) {
        typed.current[slot] = text;
      },
      async saveDraft() {
        const now = live.current;
        const body = (typed.current[NEW_SLOT] ?? "").trim();
        if (!now.draft || !body || !now.onAddComment) return;
        const { path, ...anchor } = now.draft;
        const hunks = now.drawn.find((d) => d.listed.path === path)?.file.hunks;
        // Saved where its lines are now, which is where the person sees it.
        const place = hunks ? placeAnchor(anchor, hunks) : null;
        await now.onAddComment({ path, side: anchor.side, line: place?.line ?? anchor.line, endLine: place?.endLine ?? anchor.endLine, quote: anchor.quote, body });
        delete typed.current[NEW_SLOT];
        setDraft(null);
      },
      cancelDraft() {
        delete typed.current[NEW_SLOT];
        setDraft(null);
      },
      startEdit(comment) {
        typed.current[comment.id] = comment.body;
        setEditing(comment.id);
      },
      async saveEdit(id) {
        const body = (typed.current[id] ?? "").trim();
        if (!body) return;
        await live.current.onEditComment?.(id, { body });
        delete typed.current[id];
        setEditing(null);
      },
      cancelEdit() {
        const id = live.current.editing;
        if (id) delete typed.current[id];
        setEditing(null);
      },
      // The surface says what went wrong; here a refusal only leaves the comment as it was.
      setState: (id, state) => void Promise.resolve(live.current.onEditComment?.(id, { state })).catch(() => {}),
      remove: (id) => void Promise.resolve(live.current.onRemoveComment?.(id)).catch(() => {})
    }),
    [canAdd, canEdit, canRemove]
  );
  /** Without comments or a way to make one, the files are drawn as if there were no such thing. */
  const taking = comments !== undefined || canAdd;

  const load = useCallback(
    (path: string, full: boolean) => {
      const now = live.current;
      const file = now.listed?.find((f) => f.path === path);
      if (!file || !now.onLoadFile) return;
      const key = keyOf(file, full);
      if (now.read?.[key] && now.read[key] !== "failed") return;
      const put = (value: ChangedFile | "loading" | "failed") =>
        setFetched((prev) => (value !== "loading" && prev.of !== now.identity ? prev : { of: now.identity, files: { ...(prev.of === now.identity ? prev.files : {}), [key]: value } }));
      put("loading");
      now.onLoadFile(path, full ? { full: true } : undefined).then(
        (got) => put(got && (got.hunks || got.binary) ? got : "failed"),
        () => put("failed")
      );
    },
    [keyOf]
  );

  const unfold = useCallback(
    (path: string, oldLine: number, full: boolean) => {
      setUnfolded((prev) => ({ ...prev, [path]: [...(prev[path] ?? []), oldLine] }));
      if (full) load(path, true);
    },
    [load]
  );

  const toggle = (path: string, open: boolean) => setOpens((prev) => ({ ...prev, [path]: open }));
  const setViewed = (file: ChangedFile, viewed: boolean) => {
    const next = markViewed(marks, file, viewed);
    setMarks(next);
    writeViewed(viewedKey, next);
    // Marking a file viewed folds it, even one opened by hand.
    setOpens(({ [file.path]: _was, ...rest }) => rest);
  };

  /** Scrolls the next or previous stop that matches to `under` pixels below the top of the scrolling box: a file's own margin, or its sticky head. */
  const step = (selector: string, dir: 1 | -1, under: number) => {
    const box = scroller.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top + under;
    const offsets = [...box.querySelectorAll<HTMLElement>(selector)].map((el) => el.getBoundingClientRect().top - top);
    const ahead = dir === 1 ? offsets.find((o) => o > 4) : offsets.reverse().find((o) => o < -4);
    if (ahead !== undefined) box.scrollTop += ahead;
  };
  const stepFile = (dir: 1 | -1) => step("[data-diff-index]", dir, FILE_MARGIN);
  // A changed line lands a few rows under the file's head, with the lines before it in view.
  const stepChange = (dir: 1 | -1) => step("[data-diff-stop]", dir, (scroller.current?.querySelector<HTMLElement>(".diff__file-head")?.offsetHeight ?? 0) + STOP_LEAD);
  const showFile = (index: number) => {
    const box = scroller.current;
    const el = box?.querySelector<HTMLElement>(`[data-diff-index="${index}"]`);
    if (box && el) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - FILE_MARGIN;
  };

  /** Goes to a comment: its file is opened, and drawn by being scrolled to, before the comment itself can be found. */
  const jump = (comment: DiffComment) => {
    const index = drawn.findIndex((d) => d.listed.path === comment.path);
    if (index < 0) return;
    setOpens((prev) => ({ ...prev, [comment.path]: true }));
    clearTimeout(seeking.current);
    let tries = 0;
    const seek = () => {
      const box = scroller.current;
      if (!box) return;
      const note = [...box.querySelectorAll<HTMLElement>("[data-comment-id]")].find((el) => el.dataset.commentId === comment.id);
      if (note) {
        const head = box.querySelector<HTMLElement>(".diff__file-head")?.offsetHeight ?? 0;
        box.scrollTop += note.getBoundingClientRect().top - box.getBoundingClientRect().top - head - STOP_LEAD;
        return;
      }
      if (tries === 0) showFile(index);
      if (++tries < SEEK_TRIES) seeking.current = setTimeout(seek, SEEK_MS);
    };
    seeking.current = setTimeout(seek, 0);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
    const moves: Record<string, () => void> = { n: () => stepChange(1), p: () => stepChange(-1), "]": () => stepFile(1), "[": () => stepFile(-1) };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    move();
  };

  if (!changes) return <div className="diff diff--blank meta-txt">{t(loading ? "diff.loading" : "diff.empty")}</div>;

  const viewedCount = drawn.filter((d) => isViewed(marks, d.listed)).length;
  const additions = drawn.reduce((sum, d) => sum + (d.listed.additions ?? 0), 0);
  const deletions = drawn.reduce((sum, d) => sum + (d.listed.deletions ?? 0), 0);
  const openTotal = (comments ?? []).filter((comment) => comment.state === "open").length;

  const list = (
    <nav className="diff__list" aria-label={t("diff.filesTitle", { count: drawn.length })}>
      {drawn.map(({ listed: file }, i) => (
        <button key={file.path} type="button" className={`diff__item${isViewed(marks, file) ? " is-viewed" : ""}`} title={file.path} onClick={() => showFile(i)}>
          <FileStatus status={file.status} />
          <span className="diff__path">
            <FilePath path={file.path} />
          </span>
          {openNotes.has(file.path) && (
            <span className="diff__item-notes num" title={t("diff.commentsOnFile", { count: openNotes.get(file.path)! })} aria-label={t("diff.commentsOnFile", { count: openNotes.get(file.path)! })}>
              {openNotes.get(file.path)}
            </span>
          )}
          {isViewed(marks, file) ? <Icon name="i-check" size={12} className="diff__item-check" aria-label={t("diff.viewed")} /> : fileCounts(file)}
        </button>
      ))}
    </nav>
  );

  return (
    <div ref={root} className={`diff${stacked ? " diff--stacked" : ""}`} tabIndex={0} aria-busy={loading || undefined} onKeyDown={onKeyDown} data-testid="diff-view" data-layout={layout}>
      <div className="diff__bar">
        {toolbar}
        <span className="diff__summary num">{t("diff.summary", { count: drawn.length, additions, deletions })}</span>
        {drawn.length > 0 && <span className="meta-txt num">{t("diff.viewedCount", { viewed: viewedCount, count: drawn.length })}</span>}
        {taking && (
          <span className="diff__comments-head" data-testid="diff-comments-toggle" onClick={() => setNotesOpen((o) => !o)}>
            <FoldChevron open={notesOpen} label={t("diff.commentsToggle")} onToggle={() => setNotesOpen((o) => !o)} />
            <span className="num">{t("diff.commentsCount", { count: openTotal })}</span>
          </span>
        )}
        {taking && commentsAction}
        <span className="spacer" />
        <label className="diff__option">
          <input type="checkbox" checked={ignoreWhitespace} onChange={(e) => onIgnoreWhitespace(e.target.checked)} />
          {t("diff.ignoreWhitespace")}
        </label>
        <span className="diff__steps" title={t("diff.keysHint")}>
          <button type="button" className="btn btn-icon" aria-label={t("diff.prevChange")} title={t("diff.prevChange")} onClick={() => stepChange(-1)}>
            <Icon name="i-chevdown" size={14} style={{ transform: "rotate(180deg)" }} />
          </button>
          <button type="button" className="btn btn-icon" aria-label={t("diff.nextChange")} title={t("diff.nextChange")} onClick={() => stepChange(1)}>
            <Icon name="i-chevdown" size={14} />
          </button>
        </span>
        <div className="seg quiet" role="group" aria-label={t("diff.layoutLabel")}>
          <button type="button" aria-pressed={layout === "unified"} onClick={() => pick("unified")}>
            {t("diff.unified")}
          </button>
          <button type="button" aria-pressed={layout === "split"} disabled={narrow} title={narrow ? t("diff.splitNarrow") : undefined} onClick={() => pick("split")}>
            {t("diff.split")}
          </button>
        </div>
      </div>
      {taking && notesOpen && <CommentsList rows={listedComments} onJump={jump} />}
      {drawn.length === 0 ? (
        <div className="diff__blank meta-txt">{t(changes.unavailable ? "diff.runUnavailable" : ignoreWhitespace ? "diff.emptyWhitespace" : "diff.empty")}</div>
      ) : (
        <div className="diff__panes">
          {stacked ? (
            <div className="diff__list-fold">
              <div className="diff__list-head" onClick={() => setListOpen((o) => !o)}>
                <FoldChevron open={listOpen} label={t("diff.filesToggle")} onToggle={() => setListOpen((o) => !o)} />
                {t("diff.filesTitle", { count: drawn.length })}
              </div>
              {listOpen && list}
            </div>
          ) : (
            list
          )}
          <div ref={scroller} className="diff__files">
            {drawn.map(({ listed: file, file: shown, load: state }, i) => {
              const viewed = isViewed(marks, file);
              const quiet = quietReason(file);
              return (
                <DiffFile
                  key={file.path}
                  index={i}
                  file={shown}
                  layout={layout}
                  open={opens[file.path] ?? !(viewed || quiet)}
                  viewed={viewed}
                  quiet={quiet}
                  load={state}
                  canLoad={!!onLoadFile}
                  opened={unfolded[file.path] ?? NO_LINES}
                  scroller={scroller}
                  actions={fileActions?.(shown)}
                  onToggle={toggle}
                  onViewed={(_shown, next) => setViewed(file, next)}
                  onLoad={load}
                  onUnfold={unfold}
                  notes={notes.get(file.path)}
                  noteActions={taking ? noteActions : undefined}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
