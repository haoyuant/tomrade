// cordis FIRST, and not for show: a `declare module "cordis"` in a package
// loaded before cordis itself declares a NEW module instead of augmenting it.
import type {} from "cordis";
export { Notes, NotesConfig, NOTES_SECTION, type Mention, type NoteLinks, type NotesSettings, type OutgoingLink, type RetargetResult } from "./service.js";
export { MIGRATIONS, NotesStore, TABLES } from "./store.js";
export { parseQuery, searchNotes, snippetOf, type NoteHit, type NoteSearchInput, type NoteSearchResult, type ParsedQuery } from "./search.js";
export * from "./syntax.js";
export type {} from "./channels.js";
export { Notes as default } from "./service.js";
