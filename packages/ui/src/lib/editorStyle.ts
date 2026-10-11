import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/** The app's look for a CodeMirror editor: page type, accent caret, tooltips and search in the surface colours. */
export const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "15px", color: "var(--fg)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-body)", lineHeight: "var(--leading-body)", overflow: "visible" },
  ".cm-content": { minHeight: "var(--cm-min-height, 40vh)", padding: "0 0 var(--space-6)", caretColor: "var(--accent)" },
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
export const markdownHighlight = HighlightStyle.define([
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
  { tag: [t.processingInstruction, t.meta, t.contentSeparator, t.labelName], color: "var(--meta)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--accent)" },
  { tag: t.attributeName, color: "var(--fg-2)" },
  { tag: [t.attributeValue, t.string], color: "var(--tag-fg)" },
  { tag: t.comment, color: "var(--meta)", fontStyle: "italic" }
]);
