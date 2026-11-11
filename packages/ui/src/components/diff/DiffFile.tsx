import { Fragment, memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { ChangedFile, ChangeHunk, ChangeLine, ChangeStatus } from "@tomradex/code-link";
import { FoldChevron } from "~/components/ui/atoms";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { sideOf, type CommentSide, type Place } from "./anchors";
import { CommentNote, Composer, type FileNotes, type NoteActions } from "./DiffComments";
import { highlightHunk, parserFor, segments, type Token } from "./highlight";
import { gapBefore, gutterDigits, lineCount, pieces, splitRows, type Piece, type SplitRow } from "./rows";
import { pairedSpans, type Span } from "./words";

export type DiffLayout = "unified" | "split";
/** Where a file's hunks stand when they are read apart from the list. */
export type FileLoad = "idle" | "loading" | "failed";

const STATUS: Record<ChangeStatus, { letter: string; label: MessageKey }> = {
  added: { letter: "A", label: "diff.statusAdded" },
  modified: { letter: "M", label: "diff.statusModified" },
  deleted: { letter: "D", label: "diff.statusDeleted" },
  renamed: { letter: "R", label: "diff.statusRenamed" }
};
const QUIET: Record<"generated" | "binary" | "large", MessageKey> = { generated: "diff.generatedFolded", binary: "diff.binaryFile", large: "diff.largeFolded" };
const SIGN: Record<ChangeLine["kind"], string> = { add: "+", del: "-", context: " " };

/** Files drawn at once before any scrolling; the rest wait until they come near the viewport. */
const EAGER_FILES = 2;
/** Past this many lines a file is drawn without colours. */
const HIGHLIGHT_MAX = 6000;
/** A row's height, for the space a file not yet drawn holds open. */
const ROW_PX = 20;

const NO_TOKENS = new Map<number, Token[]>();

export const fileCounts = (file: ChangedFile): ReactNode =>
  file.additions === null ? null : (
    <span className="diff__counts num">
      <span className="diff__count diff__count--add">+{file.additions}</span> <span className="diff__count diff__count--del">−{file.deletions ?? 0}</span>
    </span>
  );

export const FileStatus = ({ status }: { status: ChangeStatus }) => {
  const { t } = useI18n();
  return (
    <span className={`diff__status diff__status--${status}`} title={t(STATUS[status].label)} aria-label={t(STATUS[status].label)}>
      {STATUS[status].letter}
    </span>
  );
};

/** A path with its folders stepped back, so the name reads first. */
export const FilePath = ({ path }: { path: string }) => {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <>
      {cut > 0 && <span className="diff__dir">{path.slice(0, cut)}</span>}
      <span className="diff__name">{path.slice(cut)}</span>
    </>
  );
};

function Code({ line, tokens, spans }: { line: ChangeLine; tokens?: Token[]; spans?: Span[] }) {
  const { t } = useI18n();
  return (
    <>
      {segments(line.text, tokens, spans).map((part, i) =>
        part.kind || part.changed ? (
          <span key={i} className={[part.kind && `diff__tok diff__tok--${part.kind}`, part.changed && "diff__word"].filter(Boolean).join(" ")}>
            {part.text}
          </span>
        ) : (
          part.text
        )
      )}
      {line.noEol && (
        <span className="diff__noeol" title={t("diff.noNewline")} aria-label={t("diff.noNewline")}>
          ⏎
        </span>
      )}
    </>
  );
}

/** A hunk's comments: what sits under its lines, and what its lines can start. */
interface HunkNotes {
  canAdd: boolean;
  /** By the index of the line they sit under, each with the side it is on. */
  under: Map<number, { side: CommentSide; node: ReactNode }[]>;
  /** The lines the comment being written is on. */
  picked: { side: CommentSide; first: number; last: number } | null;
  onPick: (index: number, extend: boolean) => void;
}

interface HunkProps {
  hunk: ChangeHunk;
  parts: Piece[];
  tokens: Map<number, Token[]>;
  spans: Map<number, Span[]>;
  onUnfold: (oldLine: number) => void;
  /** Absent where the view takes no comments: the rows are then phase 1's, to the letter. */
  notes?: HunkNotes;
}

const AddComment = ({ line, onPick }: { line: number; onPick: (extend: boolean) => void }) => {
  const { t } = useI18n();
  const label = t("diff.addComment", { line });
  return (
    <button type="button" className="diff__add" aria-label={label} title={label} onClick={(e) => onPick(e.shiftKey)}>
      +
    </button>
  );
};

const isPicked = (notes: HunkNotes | undefined, hunk: ChangeHunk, index: number | null, side: CommentSide) =>
  !!notes?.picked && index !== null && notes.picked.side === side && index >= notes.picked.first && index <= notes.picked.last && hunk.lines[index][side] !== null;

const FoldRow = ({ part, onUnfold }: { part: Extract<Piece, { kind: "fold" }>; onUnfold: (oldLine: number) => void }) => {
  const { t } = useI18n();
  return (
    <button type="button" className="diff__fold" onClick={() => onUnfold(part.oldFrom)}>
      {t("diff.expandLines", { count: part.to - part.from })}
    </button>
  );
};

/** A row the keys stop at: the first of a run of changed lines. */
const stopHere = (first: boolean) => (first ? { "data-diff-stop": true } : undefined);

function UnifiedHunk({ hunk, parts, tokens, spans, onUnfold, notes }: HunkProps) {
  return parts.map((part, i) => {
    if (part.kind === "fold") return <FoldRow key={`f${part.from}`} part={part} onUnfold={onUnfold} />;
    const line = hunk.lines[part.index];
    const before = parts[i - 1];
    const first = line.kind !== "context" && (before?.kind !== "line" || hunk.lines[before.index].kind === "context");
    const side = sideOf(line);
    const row = (
      <div key={part.index} className={`diff__row${isPicked(notes, hunk, part.index, side) ? " is-picked" : ""}`} {...stopHere(first)}>
        <span className={`diff__num diff__num--${line.kind}`}>{line.old}</span>
        <span className={`diff__num diff__num--${line.kind}`}>
          {line.new}
          {notes?.canAdd && <AddComment line={line[side]!} onPick={(extend) => notes.onPick(part.index, extend)} />}
        </span>
        <span className={`diff__code diff__code--${line.kind}`}>
          <span className="diff__sign" aria-hidden>
            {SIGN[line.kind]}
          </span>
          <Code line={line} tokens={tokens.get(part.index)} spans={spans.get(part.index)} />
        </span>
      </div>
    );
    const under = notes?.under.get(part.index);
    if (!under) return row;
    return (
      <Fragment key={part.index}>
        {row}
        <div className="diff__thread">{under.map((note) => note.node)}</div>
      </Fragment>
    );
  });
}

function SplitHunk({ hunk, parts, tokens, spans, onUnfold, notes }: HunkProps) {
  const side = (index: number | null, number: "old" | "new") => {
    const line = index === null ? null : hunk.lines[index];
    const kind = line?.kind ?? "none";
    return (
      <>
        <span className={`diff__num diff__num--${kind}`}>
          {line?.[number]}
          {notes?.canAdd && line && index !== null && sideOf(line) === number && <AddComment line={line[number]!} onPick={(extend) => notes.onPick(index, extend)} />}
        </span>
        <span className={`diff__code diff__code--${kind}`}>
          {line && index !== null && (
            <>
              <span className="diff__sign" aria-hidden>
                {SIGN[line.kind]}
              </span>
              <Code line={line} tokens={tokens.get(index)} spans={spans.get(index)} />
            </>
          )}
        </span>
      </>
    );
  };
  // A row of unchanged text shows the same line on both sides.
  const changed = (row: SplitRow | undefined) => row?.kind === "pair" && row.left !== row.right;
  /** What sits under one side of a row: the old side's under the left half, the new side's under the right. */
  const under = (index: number | null, number: CommentSide) => (index === null ? [] : (notes?.under.get(index) ?? []).filter((note) => note.side === number).map((note) => note.node));
  return splitRows(hunk, parts).map((row, i, rows) => {
    if (row.kind === "fold") return <FoldRow key={`f${row.from}`} part={row} onUnfold={onUnfold} />;
    const picked = isPicked(notes, hunk, row.left, "old") || isPicked(notes, hunk, row.right, "new");
    const line = (
      <div key={i} className={`diff__row diff__row--split${picked ? " is-picked" : ""}`} {...stopHere(changed(row) && !changed(rows[i - 1]))}>
        {side(row.left, "old")}
        {side(row.right, "new")}
      </div>
    );
    const left = under(row.left, "old");
    const right = under(row.right, "new");
    if (!left.length && !right.length) return line;
    return (
      <Fragment key={i}>
        {line}
        {left.length > 0 && <div className="diff__thread diff__thread--old">{left}</div>}
        {right.length > 0 && <div className="diff__thread diff__thread--new">{right}</div>}
      </Fragment>
    );
  });
}

interface BodyProps {
  file: ChangedFile;
  layout: DiffLayout;
  /** Old line numbers whose folds are open. */
  opened: readonly number[];
  load: FileLoad;
  /** The surface can read one file's hunks, and its whole text around them. */
  canLoad: boolean;
  onLoad: (path: string, full: boolean) => void;
  onUnfold: (path: string, oldLine: number, full: boolean) => void;
  /** The file's comments, when it has any, and what its rows can do about them; without `noteActions` the view takes none. */
  notes?: FileNotes;
  noteActions?: NoteActions;
}

/** A file's hunks. Memoized: one file folding or loading must not redraw the others' lines. */
const DiffBody = memo(function DiffBody({ file, layout, opened, load, canLoad, onLoad, onUnfold, notes, noteActions }: BodyProps) {
  const { t } = useI18n();
  const hunks = file.hunks;
  const marks = useMemo(() => {
    const parser = hunks && lineCount(file) <= HIGHLIGHT_MAX ? parserFor(file.path) : null;
    return (hunks ?? []).map((hunk) => ({ tokens: parser ? highlightHunk(parser, hunk) : NO_TOKENS, spans: pairedSpans(hunk.lines) }));
  }, [file, hunks]);

  // A commented line stays in view: the fold it would sit in is opened.
  const shown = useMemo(() => {
    const places = [...(notes?.placed ?? []), ...(notes?.draft ? [notes.draft] : [])].flatMap((note) => (note.place ? [note.place] : []));
    const pinned = places.flatMap((place) => (hunks?.[place.hunk]?.lines.slice(place.first, place.last + 1) ?? []).flatMap((line) => (line.old === null ? [] : [line.old])));
    return pinned.length ? [...opened, ...pinned] : opened;
  }, [notes, hunks, opened]);

  const fetching = load === "loading";
  const more = (label: MessageKey, note: MessageKey) => (
    <div className="diff__more">
      <span className="meta-txt">{t(load === "failed" ? "diff.loadFailed" : note)}</span>
      {canLoad && (
        <button type="button" className="btn btn-ghost" disabled={fetching} onClick={() => onLoad(file.path, false)}>
          {t(fetching ? "diff.loadingFile" : label)}
        </button>
      )}
    </div>
  );

  if (file.binary) return <div className="diff__more meta-txt">{t("diff.binaryFile")}</div>;
  if (!hunks) return more("diff.loadFile", "diff.notLoaded");
  if (!hunks.length) return <div className="diff__more meta-txt">{t("diff.noContent")}</div>;

  const Hunk = layout === "split" ? SplitHunk : UnifiedHunk;
  const hunkNotes = (h: number): HunkNotes | undefined => {
    if (!noteActions) return undefined;
    const under: HunkNotes["under"] = new Map();
    const put = (place: Place, side: CommentSide, node: ReactNode) => under.set(place.last, [...(under.get(place.last) ?? []), { side, node }]);
    for (const { comment, place } of notes?.placed ?? []) {
      if (place.hunk === h) put(place, comment.side, <CommentNote key={comment.id} comment={comment} place={place} editing={notes?.editing === comment.id} actions={noteActions} />);
    }
    const draft = notes?.draft;
    const at = draft?.place?.hunk === h ? draft.place : null;
    if (draft && at) put(at, draft.anchor.side, <Composer key="new" anchor={draft.anchor} place={at} actions={noteActions} />);
    return { canAdd: noteActions.canAdd, under, picked: draft && at ? { side: draft.anchor.side, first: at.first, last: at.last } : null, onPick: (index, extend) => noteActions.pick(file.path, h, index, extend) };
  };
  const adrift = !!notes && (notes.outdated.length > 0 || (!!notes.draft && !notes.draft.place));
  return (
    <div className="diff__body" style={{ "--diff-gutter": `${gutterDigits(file) + 1}ch` } as CSSProperties}>
      {adrift && noteActions && (
        <div className="diff__thread diff__thread--outdated" data-testid="diff-outdated">
          <div className="meta-txt">{t("diff.commentOutdatedNote")}</div>
          {notes.outdated.map((comment) => (
            <CommentNote key={comment.id} comment={comment} place={null} editing={notes.editing === comment.id} actions={noteActions} />
          ))}
          {notes.draft && !notes.draft.place && <Composer anchor={notes.draft.anchor} place={null} actions={noteActions} />}
        </div>
      )}
      {hunks.map((hunk, i) => {
        const gap = gapBefore(hunks, i);
        const label = gap.count ? t("diff.unchangedLines", { count: gap.count }) : null;
        return (
          <div key={`${hunk.oldStart}:${hunk.newStart}`} className="diff__hunk">
            <div className={`diff__hunk-head${label || hunk.header ? "" : " diff__hunk-head--bare"}`}>
              {label &&
                (canLoad ? (
                  <button type="button" className="diff__gap" disabled={fetching} title={t("diff.expandLines", { count: gap.count })} onClick={() => onUnfold(file.path, gap.oldFrom, true)}>
                    {label}
                  </button>
                ) : (
                  <span className="diff__gap">{label}</span>
                ))}
              {hunk.header && <span className="diff__hunk-name">{hunk.header}</span>}
            </div>
            <Hunk hunk={hunk} parts={pieces(hunk, shown)} tokens={marks[i].tokens} spans={marks[i].spans} onUnfold={(line) => onUnfold(file.path, line, false)} notes={hunkNotes(i)} />
          </div>
        );
      })}
      {file.truncated && more("diff.loadRest", "diff.truncatedNote")}
    </div>
  );
});

export interface DiffFileProps extends BodyProps {
  index: number;
  open: boolean;
  viewed: boolean;
  /** Why it started folded, shown beside the path while it is. */
  quiet: "generated" | "binary" | "large" | null;
  /** The scrolling box the files sit in: a file is drawn once it comes near it. */
  scroller: RefObject<HTMLElement | null>;
  actions?: ReactNode;
  onToggle: (path: string, open: boolean) => void;
  onViewed: (file: ChangedFile, viewed: boolean) => void;
}

export function DiffFile({ index, open, viewed, quiet, scroller, actions, onToggle, onViewed, ...body }: DiffFileProps) {
  const { t } = useI18n();
  const { file } = body;
  const section = useRef<HTMLElement>(null);
  const [near, setNear] = useState(index < EAGER_FILES || typeof IntersectionObserver === "undefined");

  useEffect(() => {
    const el = section.current;
    if (near || !el) return;
    const watch = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { root: scroller.current, rootMargin: "800px 0px" });
    watch.observe(el);
    return () => watch.disconnect();
  }, [near, scroller]);

  return (
    <section ref={section} className="diff__file" data-diff-index={index} data-path={file.path} data-open={open || undefined}>
      <header className="diff__file-head" onClick={() => onToggle(file.path, !open)}>
        <FoldChevron open={open} label={t("diff.fileToggle", { path: file.path })} onToggle={() => onToggle(file.path, !open)} />
        <FileStatus status={file.status} />
        <span className="diff__path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath && (
            <>
              <span className="diff__dir">{file.oldPath}</span>
              <span className="diff__arrow" aria-hidden>
                →
              </span>
            </>
          )}
          <FilePath path={file.path} />
        </span>
        {!open && quiet && <span className="meta-txt diff__note">{t(QUIET[quiet])}</span>}
        <span className="diff__file-tools" onClick={(e) => e.stopPropagation()}>
          {fileCounts(file)}
          {actions}
          <label className="diff__viewed">
            <input type="checkbox" checked={viewed} onChange={(e) => onViewed(file, e.target.checked)} />
            {t("diff.viewed")}
          </label>
        </span>
      </header>
      {open && (near ? <DiffBody {...body} /> : <div className="diff__pending" data-diff-stop style={{ minHeight: Math.min(lineCount(file), 400) * ROW_PX }} />)}
    </section>
  );
}
