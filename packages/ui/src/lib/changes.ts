import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ChangedFile, ChangeFileOptions, ChangeScope, ChangesOptions, ChangesView, Editor } from "@tomradex/code-link";
import { invoke } from "./api";
import { keys } from "./queries";

/** Where a changed file went: an editor, the system's own opener, or nowhere (it is not on this machine). */
export type OpenedIn = Editor | "system" | null;

/** Where a ticket's changes are read from: the app window asks over IPC, the Terminal window over its bridge. */
export interface ChangesSource {
  /** What this source's reads are kept under. */
  key: readonly unknown[];
  changes(opts: ChangesOptions): Promise<ChangesView | null>;
  file(opts: ChangesOptions & ChangeFileOptions): Promise<ChangedFile | null>;
  open(opts: { linkId?: string; path: string }): Promise<OpenedIn>;
}

/** A ticket's changes in the app window. Kept under code link's keys, so its events ask again. */
export const ticketChanges = (projectId: string, itemId: string): ChangesSource => ({
  key: keys.codeLink.changes(projectId, itemId),
  changes: (opts) => invoke("codeLink.changes", projectId, itemId, opts),
  file: (opts) => invoke("codeLink.changeFile", projectId, itemId, opts),
  open: async (opts) => {
    const opened = await invoke("codeLink.openInEditor", projectId, itemId, opts);
    if (!opened) return null;
    if (opened.editor) return opened.editor;
    return (await invoke("shell.openPath", opened.file)) ? "system" : null;
  }
});

export const scopeValue = (scope: ChangeScope): string => (scope.kind === "commit" ? `commit:${scope.sha}` : scope.kind);
export const scopeOf = (value: string): ChangeScope => (value.startsWith("commit:") ? { kind: "commit", sha: value.slice(7) } : value === "uncommitted" ? { kind: "uncommitted" } : { kind: "branch" });

/**
 * One read of a ticket's changes. The last answer stays up while the next is read, so the view keeps its place and
 * its viewed marks; it is read again when the window is looked at again, the nearest thing to hearing a working tree change.
 */
export const useChanges = (source: ChangesSource, opts: { linkId?: string; scope: ChangeScope; ignoreWhitespace: boolean }) =>
  useQuery({
    queryKey: [...source.key, opts.linkId ?? "", scopeValue(opts.scope), opts.ignoreWhitespace],
    queryFn: () => source.changes(opts),
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: "always",
    staleTime: 0
  });

/** How much the ticket's branch changes; null when it has no branch git can show here. */
export const useChangesSummary = (projectId: string, itemId: string, enabled: boolean) =>
  useQuery({ queryKey: keys.codeLink.changesSummary(projectId, itemId), queryFn: () => invoke("codeLink.changesSummary", projectId, itemId), enabled, refetchOnWindowFocus: "always" });
