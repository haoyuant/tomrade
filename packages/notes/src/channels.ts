import type {} from "cordis";
import type {} from "@tomradex/ipc";
import type { NoteSearchInput, NoteSearchResult } from "./search.js";
import type { NoteLinks } from "./service.js";

declare module "@tomradex/ipc" {
  interface Channels {
    "notes.search": (projectId: string, input: NoteSearchInput) => NoteSearchResult;
    /** What a note links to, what links back, and who names it without a link. */
    "notes.links": (projectId: string, path: string) => NoteLinks;
    "notes.tags": (projectId: string) => { tag: string; count: number }[];
    /** The file a link written in `from` means, or null. */
    "notes.resolve": (projectId: string, target: string, from: string) => string | null;
    /** Today's journal note — `date` is the person's local YYYY-MM-DD — made when it does not exist yet. */
    "notes.journal": (projectId: string, date: string) => string;
  }
  interface Broadcasts {
    /** The index caught up with a change: search results, backlinks and tags may read differently. */
    "notes.changed": (projectId: string) => void;
  }
}
