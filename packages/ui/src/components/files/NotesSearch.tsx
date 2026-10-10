import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { NoteHit } from "@tomradex/notes";
import { noteName } from "@tomradex/notes/syntax";
import { Icon } from "~/components/icons";
import { useWorkspace } from "~/components/workspace/context";
import { useI18n } from "~/lib/i18n";
import { notesSearch, useNoteSearch, useNoteTags, useNotesSearchState } from "~/lib/notes";

function Marked({ text, marks }: { text: string; marks: [number, number][] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of marks) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  parts.push(text.slice(at));
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>;
}

function HitRow({ hit, current, onOpen }: { hit: NoteHit; current: boolean; onOpen: () => void }) {
  return (
    <button type="button" className="side-row search-hit" data-file={hit.path} aria-current={current} title={hit.path} onClick={onOpen}>
      <span className="search-hit-name">{hit.title ?? noteName(hit.path)}</span>
      <span className="search-hit-path meta-txt">{hit.path}</span>
      {hit.snippet && (
        <span className="search-hit-snippet">
          <Marked text={hit.snippet} marks={hit.marks} />
        </span>
      )}
    </button>
  );
}

/**
 * The sidebar's search over the project's notes: words in any order, ranked,
 * each hit with the line it was found on. Results stay while hits are opened,
 * the way a search pane does; an empty field lists the tags to start from.
 */
export function NotesSearch() {
  const { t } = useI18n();
  const { project, filePath, openFile } = useWorkspace();
  const state = useNotesSearchState();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(state.query);
  const [query, setQuery] = useState(state.query);
  // Every open — the button, ⌘⇧F, a tag clicked in a note — puts its query in the field and the caret after it.
  useEffect(() => {
    setDraft(state.query);
    setQuery(state.query);
    input.current?.focus();
    input.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.focus]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(draft);
      notesSearch.setQuery(draft);
    }, 150);
    return () => clearTimeout(timer);
  }, [draft]);
  const results = useNoteSearch(project.id, query, true);
  const tags = useNoteTags(project.id, !query.trim());
  const data = query.trim() ? results.data : undefined;
  return (
    <div className="notes-search" data-testid="notes-search">
      <div className="notes-search-field">
        <Icon className="ico" name="i-search" size={13} />
        <input
          ref={input}
          className="notes-search-input"
          type="search"
          value={draft}
          placeholder={t("notes.searchPlaceholder")}
          aria-label={t("notes.search")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              notesSearch.close();
            }
            if (e.key === "Enter") {
              setQuery(draft);
              const first = results.data?.hits[0];
              if (first) openFile(first.path);
            }
          }}
        />
        <button type="button" className="btn btn-icon notes-search-close" aria-label={t("notes.searchClose")} data-tip={t("notes.searchClose")} onClick={() => notesSearch.close()}>
          <Icon name="i-close" size={11} />
        </button>
      </div>
      {!query.trim() ? (
        <div className="notes-search-idle">
          <p className="meta-txt dense">{t("notes.searchHint")}</p>
          {!!tags.data?.length && (
            <div className="notes-tag-cloud">
              {tags.data.slice(0, 40).map(({ tag, count }) => (
                <button key={tag} type="button" className="tag-chip" data-tag={tag} onClick={() => notesSearch.open(`#${tag}`)}>
                  #{tag}
                  <span className="num">{count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : results.isError ? (
        <p className="meta-txt dense notes-search-note">{results.error.message}</p>
      ) : data ? (
        <>
          <p className="meta-txt dense notes-search-note" data-testid="notes-search-count">
            {data.total === 0 ? t("notes.searchNone") : data.total === 1 ? t("notes.searchOne") : t("notes.searchCount", { n: data.total })}
          </p>
          <div className="notes-search-hits">
            {data.hits.map((hit) => (
              <HitRow key={hit.path} hit={hit} current={filePath === hit.path} onOpen={() => openFile(hit.path)} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
