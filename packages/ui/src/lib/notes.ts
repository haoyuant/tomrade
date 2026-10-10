import { useCallback, useState, useSyncExternalStore } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type {} from "@tomradex/notes";
import type { FileEntry } from "@tomradex/files";
import { isNotePath } from "@tomradex/notes/syntax";
import { invoke } from "./api";
import { usePlugins } from "./queries";

export const notesKeys = {
  all: (projectId: string) => ["notes", projectId] as const,
  search: (projectId: string, query: string) => ["notes", projectId, "search", query] as const,
  links: (projectId: string, path: string) => ["notes", projectId, "links", path] as const,
  tags: (projectId: string) => ["notes", projectId, "tags"] as const
};

/** Whether a plugin fills the Notes module; without one the screens leave out search, backlinks and the journal. */
export function useNotesEnabled(): boolean {
  const plugins = usePlugins();
  return !!plugins.data?.modules.find((m) => m.id === "notes")?.providers.length;
}

export const useNoteSearch = (projectId: string, query: string, enabled: boolean) =>
  useQuery({
    queryKey: notesKeys.search(projectId, query.trim()),
    queryFn: () => invoke("notes.search", projectId, { query: query.trim(), limit: 50 }),
    enabled: enabled && query.trim().length > 0,
    placeholderData: keepPreviousData,
    retry: false
  });

export const useNoteLinks = (projectId: string, path: string, enabled: boolean) =>
  useQuery({ queryKey: notesKeys.links(projectId, path), queryFn: () => invoke("notes.links", projectId, path), enabled, retry: false });

export const useNoteTags = (projectId: string, enabled: boolean) =>
  useQuery({ queryKey: notesKeys.tags(projectId), queryFn: () => invoke("notes.tags", projectId), enabled, retry: false, staleTime: 30_000 });

/** The person's calendar day, not UTC's: a journal written at 1 a.m. belongs to the day they are living. */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The store's file paths, for link resolution and completion. */
export const filePaths = (entries: FileEntry[] | undefined): string[] => (entries ?? []).filter((e) => e.kind === "file").map((e) => e.path);

export const notePaths = (entries: FileEntry[] | undefined): string[] => filePaths(entries).filter(isNotePath);

/** `Untitled.md`, then `Untitled 1.md`…: the first name not taken in `dir`. */
export function freeNoteName(dir: string, base: string, taken: Set<string>): string {
  const clean = base.trim().replace(/[\\/]+/g, "-") || "Untitled";
  const stem = clean.replace(/\.(md|markdown|mdx)$/i, "");
  for (let i = 0; ; i++) {
    const name = `${i ? `${stem} ${i}` : stem}.md`;
    const path = dir ? `${dir}/${name}` : name;
    if (![...taken].some((p) => p.toLowerCase() === path.toLowerCase())) return path;
  }
}

/** `plan (mine).md`, then `plan (mine 2).md`…: a sibling for a copy, keeping the file's own extension. */
export function freeCopyName(path: string, taken: Set<string>): string {
  const slash = path.lastIndexOf("/");
  const dir = slash < 0 ? "" : path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const lower = new Set([...taken].map((p) => p.toLowerCase()));
  for (let i = 1; ; i++) {
    const candidate = `${dir}${stem} (mine${i > 1 ? ` ${i}` : ""})${ext}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

// ── which files open for editing ─────────────────────────────────────────────

const editNext = new Set<string>();

/** The next time this path opens, it opens to write in: a note just made, a link just followed into nothing. */
export const requestEdit = (path: string): void => void editNext.add(path);
export const takeEditRequest = (path: string): boolean => editNext.delete(path);

export type FileMode = "read" | "edit";
const MODE_KEY = "tomrade.files.mode";

/** Reading or writing, remembered per machine the way the last choice was left. */
export function useFileMode(): [FileMode, (mode: FileMode) => void] {
  const [mode, setMode] = useState<FileMode>(() => {
    try {
      return localStorage.getItem(MODE_KEY) === "edit" ? "edit" : "read";
    } catch {
      return "read";
    }
  });
  const set = useCallback((next: FileMode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // the choice just is not remembered
    }
  }, []);
  return [mode, set];
}

// ── the search pane in the sidebar ───────────────────────────────────────────

interface SearchState {
  open: boolean;
  query: string;
  /** Bumped on every open, so the field takes focus again when it is already showing. */
  focus: number;
}

let searchState: SearchState = { open: false, query: "", focus: 0 };
const searchListeners = new Set<() => void>();
const emit = (next: SearchState) => {
  searchState = next;
  for (const l of searchListeners) l();
};

/** One search per window, shared by the sidebar, a tag clicked in a note and ⌘⇧F. */
export const notesSearch = {
  open: (query?: string) => emit({ open: true, query: query ?? searchState.query, focus: searchState.focus + 1 }),
  close: () => emit({ ...searchState, open: false }),
  setQuery: (query: string) => emit({ ...searchState, query })
};

export const useNotesSearchState = (): SearchState =>
  useSyncExternalStore(
    (listener) => {
      searchListeners.add(listener);
      return () => searchListeners.delete(listener);
    },
    () => searchState
  );
