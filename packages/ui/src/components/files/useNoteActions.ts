import { useCallback, useMemo } from "react";
import { isNotePath, newNotePath, resolveLink } from "@tomradex/notes/syntax";
import { useWorkspace } from "~/components/workspace/context";
import { invoke } from "~/lib/api";
import { nameOf, useFilesTree } from "~/lib/files";
import { useI18n } from "~/lib/i18n";
import { filePaths, freeNoteName, notesSearch, requestEdit, today } from "~/lib/notes";
import { useToast } from "~/lib/toast";
import type { NoteLinking } from "./FileViewer";

/** Making notes and following links, the same from the tree, the region, the palette and a note's own text. */
export function useNoteActions() {
  const { project, openFile } = useWorkspace();
  const { t } = useI18n();
  const toast = useToast();
  const tree = useFilesTree(project.id);
  const paths = useMemo(() => filePaths(tree.data), [tree.data]);

  const openNew = useCallback(
    async (path: string, body: string) => {
      const saved = await invoke("files.save", project.id, path, body, { expect: null, message: `Created ${nameOf(path)}` });
      // Somebody made it first: open theirs rather than writing over it.
      if (saved.ok) toast({ body: t("notes.createdToast", { name: nameOf(path) }) });
      requestEdit(path);
      openFile(path);
    },
    [openFile, project.id, t, toast]
  );

  const createNote = useCallback(
    (dir: string, name?: string) => openNew(freeNoteName(dir, name ?? t("notes.untitled"), new Set(paths)), "").catch((error: Error) => toast({ body: error.message })),
    [openNew, paths, t, toast]
  );

  const openToday = useCallback(
    () =>
      invoke("notes.journal", project.id, today())
        .then((path) => {
          requestEdit(path);
          openFile(path);
        })
        .catch((error: Error) => toast({ body: error.message })),
    [openFile, project.id, toast]
  );

  /** How a note at `from` links: resolve against the store, open what is there, start what is not. */
  const linking = useCallback(
    (from: string): NoteLinking => ({
      resolve: (target, kind) => resolveLink({ target, kind }, from, paths),
      open: (target, kind) => {
        if (!target) return;
        const hit = resolveLink({ target, kind }, from, paths);
        if (hit) return openFile(hit);
        const fresh = kind === "wiki" ? newNotePath(target, from) : null;
        if (!fresh || !isNotePath(fresh)) return toast({ body: t("notes.noSuchFile", { name: target }) });
        void openNew(fresh, "").catch((error: Error) => toast({ body: error.message }));
      },
      tag: (tag) => notesSearch.open(`#${tag}`)
    }),
    [openFile, openNew, paths, t, toast]
  );

  return useMemo(() => ({ paths, createNote, openToday, linking }), [paths, createNote, openToday, linking]);
}
