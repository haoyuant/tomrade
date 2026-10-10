import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, MatchDecorator, ViewPlugin, keymap, placeholder, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import type { FileContent, SaveResult } from "@tomradex/files";
import { isNotePath, linkTarget, noteName } from "@tomradex/notes/syntax";
import { Icon } from "~/components/icons";
import { invoke } from "~/lib/api";
import { nameOf, parentOf } from "~/lib/files";
import { useI18n } from "~/lib/i18n";
import { freeNoteName } from "~/lib/notes";
import { useToast } from "~/lib/toast";

/** A pause this long after the last keystroke is a save — each one a version, so not every key. */
const SAVE_AFTER_MS = 1_500;

export type SaveState = "saved" | "dirty" | "saving";

const WIKI_SPAN = /!?\[\[([^[\]\n|#]*)(?:#[^[\]\n|]*)?(?:\|[^[\]\n]*)?\]\]/g;
const MD_SPAN = /!?\[[^\]\n]*\]\(<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\)/g;
const TAG_SPAN = /(?<=^|[\s(,;])#[\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*/gu;

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "15px", color: "var(--fg)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-body)", lineHeight: "var(--leading-body)", overflow: "visible" },
  ".cm-content": { maxWidth: "72ch", minHeight: "40vh", padding: "0 0 var(--space-6)", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--tag-bg-strong)" },
  ".cm-selectionMatch": { backgroundColor: "var(--tag-bg-faint)" },
  ".cm-placeholder": { color: "var(--meta)" },
  ".cm-tooltip": { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", boxShadow: "var(--elev-raised)", overflow: "hidden" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-display)", maxHeight: "16em" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "4px 10px", color: "var(--fg-2)" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--surface-warm)", color: "var(--fg)" },
  ".cm-completionDetail": { color: "var(--meta)", fontStyle: "normal", marginLeft: "0.8em" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "var(--accent)" },
  ".cm-panels": { background: "var(--surface)", color: "var(--fg)", borderColor: "var(--border)" },
  ".cm-panels .cm-textfield": { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--fg)" },
  ".cm-panels .cm-button": { backgroundImage: "none", background: "var(--surface-warm)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--fg-2)" },
  ".cm-searchMatch": { backgroundColor: "var(--tag-bg-base)", outline: "1px solid var(--tag-bg-strong)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--tag-bg-strong)" }
});

/** The markup stays visible, as in Obsidian's source mode, but it is set back so the prose reads first. */
const highlight = HighlightStyle.define([
  { tag: t.heading1, fontFamily: "var(--font-display)", fontSize: "1.6em", fontWeight: "600", color: "var(--fg)" },
  { tag: t.heading2, fontFamily: "var(--font-display)", fontSize: "1.35em", fontWeight: "600", color: "var(--fg)" },
  { tag: t.heading3, fontFamily: "var(--font-display)", fontSize: "1.15em", fontWeight: "600", color: "var(--fg)" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "600", color: "var(--fg)" },
  { tag: t.strong, fontWeight: "650" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--muted)" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--meta)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.9em" },
  { tag: t.quote, color: "var(--muted)" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator, t.labelName], color: "var(--meta)" }
]);

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
      let decoded = target.split("#")[0]!;
      try {
        decoded = decodeURI(decoded);
      } catch {
        // as written
      }
      return { target: kind === "markdown" ? decoded : target, kind };
    }
  }
  return null;
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
}

/**
 * Writes a text file in place. A pause, leaving the editor, ⌘S or closing the
 * file saves it as a version — guarded by the hash it was read at, so a save
 * that would land over somebody else's (an agent, a sync, Finder) stops and
 * asks instead. A change from elsewhere while nothing is unsaved just shows up.
 */
export function NoteEditor({ projectId, content, paths, tags, resolve, onOpenLink, onState, autoFocus }: NoteEditorProps) {
  const { t: tr } = useI18n();
  const toast = useToast();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const base = useRef<{ hash: string | null; text: string }>({ hash: content.hash ?? null, text: content.body });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const [conflict, setConflict] = useState<{ current: FileContent | null } | null>(null);
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const latest = useRef({ paths, tags, resolve, onOpenLink, onState });
  latest.current = { paths, tags, resolve, onOpenLink, onState };
  const marks = useRef(new Compartment());
  const path = content.path;

  const report = (state: SaveState) => latest.current.onState(state);

  const save = async (force = false): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const editor = view.current;
    if (!editor || conflictRef.current) return;
    if (inFlight.current) {
      await inFlight.current;
      return save(force);
    }
    const text = editor.state.doc.toString();
    if (text === base.current.text && !force) return report("saved");
    report("saving");
    const run = (async () => {
      try {
        const result: SaveResult = await invoke("files.save", projectId, path, text, { expect: base.current.hash });
        if (result.ok) {
          base.current = { hash: result.content.hash ?? null, text };
          report(editor.state.doc.toString() === text ? "saved" : "dirty");
        } else {
          setConflict({ current: result.current });
          report("dirty");
        }
      } catch (error) {
        report("dirty");
        toast({ body: (error as Error).message });
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
      doc: content.body,
      extensions: [
        history(),
        search({ top: true }),
        highlightSelectionMatches(),
        closeBrackets(),
        autocompletion({ override: [completions], icons: false }),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(highlight),
        EditorView.lineWrapping,
        placeholder(tr("notes.placeholder")),
        theme,
        marks.current.of(linkMarks((target) => !!latest.current.resolve(target, "wiki"))),
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
            if (!(event.metaKey || event.ctrlKey)) return false;
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
          const dirty = update.state.doc.toString() !== base.current.text;
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
      // Closing the file is a save, not a loss.
      void saveRef.current().finally(() => editor.destroy());
      view.current = null;
    };
    // One editor per file; the parent keys it by path.
  }, []);

  // Links that start or stop resolving as files come and go.
  useEffect(() => {
    view.current?.dispatch({ effects: marks.current.reconfigure(linkMarks((target) => !!latest.current.resolve(target, "wiki"))) });
  }, [paths]);

  // A save from elsewhere: shown at once when nothing here is unsaved, checked at the next save otherwise.
  useEffect(() => {
    const editor = view.current;
    if (!editor || content.hash === base.current.hash) return;
    if (editor.state.doc.toString() !== base.current.text) return;
    base.current = { hash: content.hash ?? null, text: content.body };
    const head = Math.min(editor.state.selection.main.head, content.body.length);
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: content.body }, selection: { anchor: head } });
    report("saved");
  }, [content.hash, content.body]);

  const resolveConflict = async (choice: "mine" | "theirs" | "both") => {
    const editor = view.current;
    if (!editor || !conflict) return;
    const current = conflict.current;
    const mine = editor.state.doc.toString();
    if (choice === "theirs") {
      base.current = { hash: current?.hash ?? null, text: current?.body ?? "" };
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: current?.body ?? "" } });
      setConflict(null);
      report("saved");
      return;
    }
    if (choice === "both") {
      const taken = new Set(latest.current.paths);
      const copy = freeNoteName(parentOf(path), `${noteName(path)} (mine)`, taken);
      const saved = await invoke("files.save", projectId, copy, mine, { expect: null, message: `Kept a copy of ${nameOf(path)}` });
      if (!saved.ok) return toast({ body: tr("notes.copyTaken", { name: nameOf(copy) }) });
      toast({ body: tr("notes.keptBothToast", { name: nameOf(copy) }) });
      base.current = { hash: current?.hash ?? null, text: current?.body ?? "" };
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: current?.body ?? "" } });
      setConflict(null);
      report("saved");
      return;
    }
    // Mine wins, knowingly: against exactly what is there now.
    base.current = { hash: current?.hash ?? null, text: current?.body ?? "" };
    setConflict(null);
    conflictRef.current = null;
    await saveRef.current(true);
  };

  return (
    <div className="note-editor" data-testid="note-editor">
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
  );
}
