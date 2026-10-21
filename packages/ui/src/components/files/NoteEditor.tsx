import { useDeferredValue, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, MatchDecorator, ViewPlugin, keymap, placeholder, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import type { FileContent, SaveResult } from "@tomradex/files";
import { decodeHref, isNotePath, linkTarget, noteName } from "@tomradex/notes/syntax";
import { Icon } from "~/components/icons";
import { invoke } from "~/lib/api";
import { editorTheme, markdownHighlight } from "~/lib/editorStyle";
import { nameOf, parentOf } from "~/lib/files";
import { useI18n } from "~/lib/i18n";
import { freeCopyName } from "~/lib/notes";
import { errorSpec, useToast } from "~/lib/toast";

/** A pause this long after the last keystroke is a save — each one a version, so not every key. */
const SAVE_AFTER_MS = 1_500;

/** How long a rendered page beside the editor waits after typing before it reloads. */
const REDRAW_PAGE_MS = 400;

export type SaveState = "saved" | "dirty" | "saving";

/** The editor works in \n; a file written with \r\n is saved back the way it came. */
const normalize = (text: string): string => text.replace(/\r\n?/g, "\n");
const eolOf = (text: string): "\n" | "\r\n" => (/\r\n/.test(text) ? "\r\n" : "\n");

const WIKI_SPAN = /!?\[\[([^[\]\n|#]*)(?:#[^[\]\n|]*)?(?:\|[^[\]\n]*)?\]\]/g;
const MD_SPAN = /!?\[[^\]\n]*\]\(<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\)/g;
const TAG_SPAN = /(?<=^|[\s(,;])#[\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*/gu;

/** Wiki links and tags as marks the stylesheet draws; a link to nothing reads as one. */
function linkMarks(resolve: (target: string) => boolean): Extension {
  const wiki = new MatchDecorator({
    regexp: WIKI_SPAN,
    decoration: (m) => Decoration.mark({ class: `cm-wikilink${m[1]!.trim() && !resolve(m[1]!.trim()) ? " is-unresolved" : ""}` })
  });
  const tag = new MatchDecorator({ regexp: TAG_SPAN, decoration: () => Decoration.mark({ class: "cm-hashtag" }) });
  const plugin = (decorator: MatchDecorator) =>
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = decorator.createDeco(view);
        }
        update(update: ViewUpdate) {
          this.decorations = decorator.updateDeco(update, this.decorations);
        }
      },
      { decorations: (v) => v.decorations }
    );
  return [plugin(wiki), plugin(tag)];
}

/** The link under a position, if any: what ⌘-click follows. */
function linkAt(view: EditorView, pos: number): { target: string; kind: "wiki" | "markdown" } | null {
  const line = view.state.doc.lineAt(pos);
  const at = pos - line.from;
  for (const [regexp, kind] of [[WIKI_SPAN, "wiki"], [MD_SPAN, "markdown"]] as const) {
    for (const m of line.text.matchAll(new RegExp(regexp.source, "g"))) {
      if (at < m.index || at > m.index + m[0].length) continue;
      const target = m[1]!.trim();
      if (kind === "markdown" && (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#"))) return null;
      return { target: kind === "markdown" ? decodeHref(target.split("#")[0]!) : target, kind };
    }
  }
  return null;
}

/** Where each block of a preview starts, in its pane's scroll space, closed off by the end of the rendering. */
function previewBlocks(pane: HTMLElement, lines: number): { line: number; top: number }[] {
  const origin = pane.getBoundingClientRect().top - pane.scrollTop;
  const blocks = [{ line: 1, top: 0 }];
  for (const el of pane.querySelectorAll<HTMLElement>("[data-line]")) blocks.push({ line: Number(el.dataset.line), top: el.getBoundingClientRect().top - origin });
  const end = pane.querySelector(".md-view");
  if (end && blocks.length > 1) blocks.push({ line: lines + 1, top: end.getBoundingClientRect().bottom - origin });
  return blocks;
}

/** `x` read along a rising line through `points`, straight between each pair. */
function along(points: [number, number][], x: number): number {
  let i = 0;
  while (i < points.length - 2 && points[i + 1]![0] <= x) i++;
  const [x0, y0] = points[i]!;
  const [x1, y1] = points[i + 1]!;
  return y0 + (y1 - y0) * Math.min(1, Math.max(0, (x - x0) / Math.max(1e-6, x1 - x0)));
}

export interface NoteEditorProps {
  projectId: string;
  content: FileContent;
  /** Every file of the store, for completion and for telling a dangling link apart. */
  paths: string[];
  tags: string[];
  resolve: (target: string, kind: "wiki" | "markdown") => string | null;
  onOpenLink: (target: string, kind: "wiki" | "markdown") => void;
  onState: (state: SaveState) => void;
  autoFocus?: boolean;
  /** The file rendered from the text being written, shown beside the editor; the two keep each other's place. */
  preview?: (text: string) => ReactNode;
}

/**
 * Writes a text file in place. A pause, leaving the editor, ⌘S or closing the
 * file saves it as a version — guarded by the hash it was read at, so a save
 * that would land over somebody else's (an agent, a sync, Finder) stops and
 * asks instead. A change from elsewhere while nothing is unsaved just shows up.
 */
export function NoteEditor({ projectId, content, paths, tags, resolve, onOpenLink, onState, autoFocus, preview }: NoteEditorProps) {
  const { t: tr } = useI18n();
  const toast = useToast();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // What the file held when last read or saved, normalized: the editor is dirty when its text differs.
  const base = useRef<{ hash: string | null; text: string; eol: "\n" | "\r\n" }>({ hash: content.hash ?? null, text: normalize(content.body), eol: eolOf(content.body) });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const [conflict, setConflict] = useState<{ current: FileContent | null } | null>(null);
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const split = !!preview;
  const latest = useRef({ paths, tags, resolve, onOpenLink, onState, split });
  latest.current = { paths, tags, resolve, onOpenLink, onState, split };
  const marks = useRef(new Compartment());
  const path = content.path;
  // Links, tags and their completion are a note's; any other text is just text.
  const note = isNotePath(path);
  const editPane = useRef<HTMLDivElement>(null);
  const previewPane = useRef<HTMLDivElement>(null);
  // The text as the preview draws it; deferred, so typing never waits on rendering.
  const [draft, setDraft] = useState(base.current.text);
  const drawn = useDeferredValue(draft);
  // The pane last scrolled, clicked or typed in leads; the other follows it.
  const lead = useRef<"edit" | "preview">("edit");
  // A page in a frame reloads whole on every change, so it waits for a pause; a note redraws as it is typed.
  const redrawTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const redraw = (text: string) => {
    if (redrawTimer.current) clearTimeout(redrawTimer.current);
    if (note) setDraft(text);
    else redrawTimer.current = setTimeout(() => setDraft(text), REDRAW_PAGE_MS);
  };

  const report = (state: SaveState) => latest.current.onState(state);

  const bodyOf = (text: string) => (base.current.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text);

  /** Yours, beside the file, when the file itself can no longer take it — the editor is closing. */
  const keepCopy = async (text: string) => {
    const copy = freeCopyName(path, new Set(latest.current.paths));
    const saved = await invoke("files.save", projectId, copy, bodyOf(text), { expect: null, message: `Kept unsaved edits to ${nameOf(path)}` });
    toast({ body: saved.ok ? tr("notes.keptBothToast", { name: nameOf(copy) }) : tr("notes.copyTaken", { name: nameOf(copy) }) });
    return saved.ok ? copy : null;
  };

  /**
   * `final` is the save on the way out: nothing is left to ask with, so what
   * cannot land on the file lands beside it. The editor is passed along, not
   * read again, because closing clears the ref before a queued save runs.
   */
  const save = async (opts: { force?: boolean; final?: boolean } = {}, editor = view.current): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!editor) return;
    if (inFlight.current) {
      await inFlight.current;
      return save(opts, editor);
    }
    const text = editor.state.doc.toString();
    if (conflictRef.current) {
      if (opts.final && text !== base.current.text) await keepCopy(text).catch(() => undefined);
      return;
    }
    if (text === base.current.text && !opts.force) return report("saved");
    report("saving");
    const run = (async () => {
      try {
        const result: SaveResult = await invoke("files.save", projectId, path, bodyOf(text), { expect: base.current.hash });
        if (result.ok) {
          base.current = { ...base.current, hash: result.content.hash ?? null, text };
          report(editor.state.doc.toString() === text ? "saved" : "dirty");
        } else if (opts.final) {
          await keepCopy(text);
        } else {
          setConflict({ current: result.current });
          report("dirty");
        }
      } catch (error) {
        report("dirty");
        toast(errorSpec(error));
      }
    })();
    inFlight.current = run;
    await run;
    inFlight.current = null;
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const completions = (context: CompletionContext): CompletionResult | null => {
      const wiki = context.matchBefore(/\[\[[^[\]\n|#]*$/);
      if (wiki) {
        const after = context.state.sliceDoc(context.pos, context.pos + 2);
        const { paths: all } = latest.current;
        const options: Completion[] = all.filter(isNotePath).map((p) => ({
          label: noteName(p),
          detail: parentOf(p) || undefined,
          apply: (v, _c, from, to) => {
            const insert = `${linkTarget(p, path, all)}${after === "]]" ? "" : "]]"}`;
            v.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length + (after === "]]" ? 2 : 0) } });
          }
        }));
        return { from: wiki.from + 2, options, validFor: /^[^[\]\n|#]*$/ };
      }
      const tag = context.matchBefore(/(?:^|[\s(,;])#[\p{L}\p{N}_\-/]*$/u);
      if (tag && (tag.text.length > 1 || context.explicit)) {
        const from = tag.from + tag.text.indexOf("#") + 1;
        return { from, options: latest.current.tags.map((name) => ({ label: name, type: "keyword" })), validFor: /^[\p{L}\p{N}_\-/]*$/u };
      }
      return null;
    };
    const state = EditorState.create({
      doc: base.current.text,
      extensions: [
        history(),
        search({ top: true }),
        highlightSelectionMatches(),
        closeBrackets(),
        autocompletion(note ? { override: [completions], icons: false } : { icons: false }),
        note ? markdown({ base: markdownLanguage }) : /\.(html?|svg)$/i.test(path) ? html() : [],
        syntaxHighlighting(markdownHighlight),
        EditorView.lineWrapping,
        note ? placeholder(tr("notes.placeholder")) : [],
        editorTheme,
        marks.current.of(note ? linkMarks((target) => !!latest.current.resolve(target, "wiki")) : []),
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (void saveRef.current(), true) },
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
          ...defaultKeymap
        ]),
        EditorView.domEventHandlers({
          mousedown: (event, v) => {
            if (!note || !(event.metaKey || event.ctrlKey)) return false;
            const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
            const link = pos === null ? null : linkAt(v, pos);
            if (!link) return false;
            event.preventDefault();
            void saveRef.current().then(() => latest.current.onOpenLink(link.target, link.kind));
            return true;
          },
          blur: () => void saveRef.current()
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const text = update.state.doc.toString();
          if (latest.current.split) redraw(text);
          const dirty = text !== base.current.text;
          report(dirty ? "dirty" : "saved");
          if (timer.current) clearTimeout(timer.current);
          timer.current = dirty ? setTimeout(() => void saveRef.current(), SAVE_AFTER_MS) : null;
        })
      ]
    });
    const editor = new EditorView({ state, parent: host.current! });
    view.current = editor;
    if (autoFocus) editor.focus();
    const flush = () => void saveRef.current();
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      if (redrawTimer.current) clearTimeout(redrawTimer.current);
      // Closing the file is a save, not a loss.
      void saveRef.current({ final: true }, editor).finally(() => editor.destroy());
      view.current = null;
    };
    // One editor per file; the parent keys it by path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Links that start or stop resolving as files come and go.
  useEffect(() => {
    if (note) view.current?.dispatch({ effects: marks.current.reconfigure(linkMarks((target) => !!latest.current.resolve(target, "wiki"))) });
  }, [paths, note]);

  /** Brings the other pane to the place `from` shows: by source line where the preview marks its blocks, by proportion where it cannot. */
  const follow = (from: "edit" | "preview") => {
    const editor = view.current;
    const edit = editPane.current;
    const shown = previewPane.current;
    if (!editor || !edit || !shown) return;
    const [source, target] = from === "edit" ? [edit, shown] : [shown, edit];
    // The ends meet the ends, whatever lies between.
    if (source.scrollTop <= 0) return void (target.scrollTop = 0);
    if (source.scrollTop + source.clientHeight >= source.scrollHeight - 1) return void (target.scrollTop = target.scrollHeight);
    const blocks = previewBlocks(shown, editor.state.doc.lines);
    if (blocks.length < 3) {
      const ratio = source.scrollTop / Math.max(1, source.scrollHeight - source.clientHeight);
      target.scrollTop = ratio * (target.scrollHeight - target.clientHeight);
      return;
    }
    if (from === "edit") {
      const y = Math.max(0, edit.getBoundingClientRect().top - editor.documentTop);
      const block = editor.lineBlockAtHeight(y);
      const line = editor.state.doc.lineAt(block.from).number + Math.min(1, (y - block.top) / Math.max(1, block.height));
      shown.scrollTop = along(blocks.map((b) => [b.line, b.top]), line);
    } else {
      const line = along(blocks.map((b) => [b.top, b.line]), shown.scrollTop);
      const at = editor.state.doc.line(Math.min(editor.state.doc.lines, Math.floor(line)));
      // The editor places it itself: lines it has not drawn yet only have estimated heights.
      const pos = at.from + Math.round(at.length * Math.min(1, line - at.number));
      editor.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start" }) });
    }
  };
  const followRef = useRef(follow);
  followRef.current = follow;

  useEffect(() => {
    const edit = editPane.current;
    const shown = previewPane.current;
    if (!split || !edit || !shown) return;
    if (view.current) setDraft(view.current.state.doc.toString());
    const panes = [[edit, "edit"], [shown, "preview"]] as const;
    const off: (() => void)[] = [];
    for (const [pane, side] of panes) {
      const take = () => void (lead.current = side);
      const scrolled = () => lead.current === side && followRef.current(side);
      for (const type of ["wheel", "pointerdown", "keydown", "touchstart"]) {
        pane.addEventListener(type, take, { passive: true });
        off.push(() => pane.removeEventListener(type, take));
      }
      pane.addEventListener("scroll", scrolled, { passive: true });
      off.push(() => pane.removeEventListener("scroll", scrolled));
    }
    return () => off.forEach((f) => f());
  }, [split]);

  // A fresh rendering moves the preview's blocks; put it back where the editor is.
  useLayoutEffect(() => {
    if (split && lead.current === "edit") followRef.current("edit");
  }, [drawn, split]);

  // A save from elsewhere: shown at once when nothing here is unsaved, checked at the next save otherwise.
  useEffect(() => {
    const editor = view.current;
    if (!editor || content.hash === base.current.hash) return;
    if (editor.state.doc.toString() !== base.current.text) return;
    base.current = { hash: content.hash ?? null, text: normalize(content.body), eol: eolOf(content.body) };
    const head = Math.min(editor.state.selection.main.head, base.current.text.length);
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: base.current.text }, selection: { anchor: head } });
    report("saved");
  }, [content.hash, content.body]);

  const take = (current: FileContent | null) => {
    const editor = view.current;
    if (!editor) return;
    base.current = { hash: current?.hash ?? null, text: normalize(current?.body ?? ""), eol: current ? eolOf(current.body) : base.current.eol };
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: base.current.text } });
    setConflict(null);
    report("saved");
  };

  const resolveConflict = async (choice: "mine" | "theirs" | "both") => {
    const editor = view.current;
    if (!editor || !conflict) return;
    const current = conflict.current;
    if (choice === "theirs") return take(current);
    if (choice === "both") {
      if (await keepCopy(editor.state.doc.toString())) take(current);
      return;
    }
    // Mine wins, knowingly: against exactly what is there now.
    base.current = { hash: current?.hash ?? null, text: normalize(current?.body ?? ""), eol: base.current.eol };
    setConflict(null);
    conflictRef.current = null;
    await saveRef.current({ force: true });
  };

  return (
    <div className="note-editor" data-testid="note-editor" data-split={split || undefined}>
      <div ref={editPane} className="note-pane note-pane-edit">
        {conflict && (
          <div className="dangerbar files-edit-conflict" role="alert" data-testid="edit-conflict">
            <Icon className="b-mark" name="i-warn" size={15} />
            <p style={{ flex: 1, fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>
              {conflict.current ? tr("notes.conflictChanged", { name: nameOf(path) }) : tr("notes.conflictGone", { name: nameOf(path) })}
            </p>
            <button type="button" className="btn btn-ghost edit-keep-mine" onClick={() => void resolveConflict("mine")}>
              {tr("notes.keepMine")}
            </button>
            {conflict.current && (
              <>
                <button type="button" className="btn btn-ghost edit-take-theirs" onClick={() => void resolveConflict("theirs")}>
                  {tr("notes.takeTheirs")}
                </button>
                <button type="button" className="btn btn-ghost edit-keep-both" onClick={() => void resolveConflict("both")}>
                  {tr("notes.keepBoth")}
                </button>
              </>
            )}
          </div>
        )}
        <div ref={host} className="note-editor-host" />
      </div>
      {preview && (
        <div ref={previewPane} className="note-pane note-pane-preview" data-testid="note-preview">
          {preview(drawn)}
        </div>
      )}
    </div>
  );
}
