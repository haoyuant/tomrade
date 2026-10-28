import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FileChange, FileEntry } from "@tomradex/files";
import { Icon } from "~/components/icons";
import { Eyebrow, Spacer } from "~/components/ui/atoms";
import { ContextMenu, ContextMenuActionItem, Menu, MenuActionItem } from "~/components/ui/menu";
import { InlineNameRow } from "~/components/workspace/InlineNameRow";
import { useWorkspace } from "~/components/workspace/context";
import { FILES_DRAG_MIME, parentOf, useFilesClipboard, useFilesStatus, useFilesTree, useImportFiles, useMakeFolder, usePasteFiles, useRemoveFile } from "~/lib/files";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useRevert } from "~/lib/queries";
import { pathForFile, pickFiles } from "~/lib/shell";
import { errorSpec, useToast } from "~/lib/toast";
import { notesSearch, useNotesEnabled, useNotesSearchState } from "~/lib/notes";
import { stateOf } from "./state";
import { NotesSearch } from "./NotesSearch";
import { useNoteActions } from "./useNoteActions";
import { SyncContextActions, SyncMark, useSyncActions } from "./SyncPolicy";
import { AgentContextActions, AgentMark, useAgentActions } from "./AgentPolicy";

const CHANGE_LETTER: Record<FileChange, string> = { added: "A", modified: "M", deleted: "D", renamed: "R", conflicted: "!" };
const CHANGE_KEY: Record<FileChange, MessageKey> = {
  added: "files.change_added",
  modified: "files.change_modified",
  deleted: "files.change_deleted",
  renamed: "files.change_renamed",
  conflicted: "files.change_conflicted"
};

const expandedKey = (projectId: string) => `tomrade.files.expanded.${projectId}`;

/** Which folders are open, per project and per machine; the open file's ancestors are opened for it. */
function useExpanded(projectId: string, current: string | null) {
  const key = expandedKey(projectId);
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const persist = (next: Set<string>) => {
    localStorage.setItem(key, JSON.stringify([...next]));
    return next;
  };
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    if (!current) return;
    const parts = current.split("/");
    setOpen((prev) => {
      const next = new Set(prev);
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next.size === prev.size ? prev : persistRef.current(next);
    });
  }, [current]);
  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return persist(next);
    });
  const show = (path: string) => setOpen((prev) => (prev.has(path) ? prev : persist(new Set(prev).add(path))));
  return { open, toggle, show };
}

/**
 * The project's files as a tree above the views: folders fold, a file opens in
 * the region, and the label row carries the sync state and the two ways files
 * come in — a native picker, or a new folder.
 */
/** Hands its head and its tree to the sidebar's module shell, which owns folding and order. */
export function FilesTree({ children: frame }: { children: (head: ReactNode, body: ReactNode) => ReactNode }) {
  const { t } = useI18n();
  const { project, filePath, openFile } = useWorkspace();
  const toast = useToast();
  const tree = useFilesTree(project.id);
  const syncActions = useSyncActions(project.id);
  const agentActions = useAgentActions(project.id);
  const status = useFilesStatus(project.id);
  const mkdir = useMakeFolder(project.id);
  const importFiles = useImportFiles(project.id);
  const remove = useRemoveFile(project.id);
  const revert = useRevert(project.id);
  const clipboard = useFilesClipboard(project.id);
  const pasteFiles = usePasteFiles(project.id);
  const { open, toggle, show } = useExpanded(project.id, filePath);
  const [creating, setCreating] = useState(false);
  const [creatingNote, setCreatingNote] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const notesOn = useNotesEnabled();
  const noteActions = useNoteActions();
  const searching = useNotesSearchState().open && notesOn;

  const entries = useMemo(() => tree.data ?? [], [tree.data]);
  const existing = useMemo(() => new Set(entries.map((e) => e.path)), [entries]);
  const children = useMemo(() => {
    const map = new Map<string, FileEntry[]>();
    for (const entry of entries) {
      const list = map.get(parentOf(entry.path)) ?? [];
      list.push(entry);
      map.set(parentOf(entry.path), list);
    }
    return map;
  }, [entries]);
  const currentDir = filePath === null ? "" : entries.find((e) => e.path === filePath)?.kind === "dir" ? filePath : parentOf(filePath);
  const stateKey = status.data?.state ?? "local";
  const state = stateOf(t)[stateKey];
  const unavailable = stateKey === "unavailable";

  const addFiles = async (kind: "files" | "folders" = "files") => {
    const dir = currentDir;
    const chosen = await pickFiles(t(kind === "folders" ? "files.pickFolderTitle" : "files.pickFilesTitle"), t("files.pickFilesButton"), kind);
    if (!chosen?.length) return;
    importFiles.mutate(
      { dir, sources: chosen },
      {
        onSuccess: (added) => {
          show(dir);
          const one = added.length === 1 ? added[0]! : null;
          toast({ body: one ? t(one.kind === "dir" ? "files.addedFolderToast" : "files.addedOneToast", { name: one.name }) : t("files.addedToast", { n: added.length, dir: dir || t("files.home") }) });
        },
        onError: (error) => toast(errorSpec(error))
      }
    );
  };

  const createFolder = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return setCreating(false);
    const path = currentDir ? `${currentDir}/${trimmed}` : trimmed;
    mkdir.mutate(path, {
      onSuccess: () => {
        setCreating(false);
        openFile(path);
        toast({ body: t("files.createdFolderToast", { name: trimmed }) });
      },
      onError: (error) => toast(errorSpec(error))
    });
  };

  const moveInto = (paths: string[], target: string) => {
    pasteFiles({ projectId: project.id, mode: "cut", paths }, target, existing)
      .then(({ count, name }) => {
        // Nothing moved because it was already there — a no-op, not a move to announce.
        if (!count) return;
        show(target);
        toast({ body: count === 1 ? t("files.movedOneToast", { name }) : t("files.movedManyToast", { n: count }) });
      })
      .catch((error) => toast(errorSpec(error)));
  };

  const dropFiles = (dir: string, dataTransfer: DataTransfer) => {
    const internal = dataTransfer.getData(FILES_DRAG_MIME);
    if (internal) {
      try {
        moveInto(JSON.parse(internal) as string[], dir);
      } catch {
        // not a path payload
      }
      return;
    }
    const sources = [...dataTransfer.files].map(pathForFile).filter((p): p is string => !!p);
    if (!sources.length) return;
    importFiles.mutate(
      { dir, sources },
      {
        onSuccess: (added) => {
          show(dir);
          const one = added.length === 1 ? added[0]! : null;
          toast({ body: one ? t(one.kind === "dir" ? "files.addedFolderToast" : "files.addedOneToast", { name: one.name }) : t("files.addedToast", { n: added.length, dir: dir || t("files.home") }) });
        },
        onError: (error) => toast(errorSpec(error))
      }
    );
  };

  const runPaste = (target: string) => {
    const clip = clipboard.entry;
    if (!clip) return;
    pasteFiles(clip, target, existing)
      .then(({ count, name }) => {
        if (!count) return;
        if (clip.mode === "cut") clipboard.clear();
        show(target);
        toast({ body: count === 1 ? t("files.pastedOneToast", { name }) : t("files.pastedManyToast", { n: count }) });
      })
      .catch((error) => toast(errorSpec(error)));
  };

  // The record the delete made is what its Undo takes back — not whatever happens to be newest by then. Undo
  // stands in for asking first.
  const deleteEntry = (entry: FileEntry) => {
    remove.mutate(entry.path, {
      onSuccess: (ref) =>
        toast({
          body: t("files.deletedToast", { name: entry.name }),
          onUndo: ref
            ? () => revert.mutate(ref, { onSuccess: () => toast({ body: t("files.restoredToast", { name: entry.name }) }), onError: (error) => toast(errorSpec(error)) })
            : undefined
        }),
      onError: (error) => toast(errorSpec(error))
    });
  };

  const rows = (parent: string, depth: number): ReactNode[] =>
    (children.get(parent) ?? []).flatMap((entry) => {
      const dir = entry.kind === "dir";
      const expanded = dir && open.has(entry.path);
      const current = filePath === entry.path;
      return [
        <ContextMenu
          key={entry.path}
          label={entry.name}
          trigger={
            <div
              className={`side-file-row-container${dir && dragOver === entry.path ? " is-drag-over" : ""}`}
              data-file={entry.path}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(FILES_DRAG_MIME, JSON.stringify([entry.path]));
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={dir ? (e) => { if (!e.dataTransfer.types.includes(FILES_DRAG_MIME) && !e.dataTransfer.types.includes("Files")) return; e.preventDefault(); e.stopPropagation(); setDragOver(entry.path); } : undefined}
              onDragLeave={dir ? () => setDragOver((cur) => (cur === entry.path ? null : cur)) : undefined}
              onDrop={
                dir
                  ? (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOver(null);
                      dropFiles(entry.path, e.dataTransfer);
                    }
                  : undefined
              }
            >
              <button
                type="button"
                className={`side-row is-file${dir ? " is-dir" : ""}`}
                data-file={entry.path}
                data-depth={depth}
                style={{ ["--depth" as string]: depth }}
                aria-current={current}
                aria-expanded={dir ? expanded : undefined}
                title={entry.path}
                onClick={() => {
                  if (dir) show(entry.path);
                  if (!current) openFile(entry.path);
                }}
                // a folder opens with → and folds with ←, the way a tree does
                onKeyDown={
                  dir
                    ? (e) => {
                        if (e.key === "ArrowRight" && !expanded) {
                          e.preventDefault();
                          show(entry.path);
                        } else if (e.key === "ArrowLeft" && expanded) {
                          e.preventDefault();
                          toggle(entry.path);
                        }
                      }
                    : undefined
                }
              >
                {dir ? (
                  <span
                    className="ico chev"
                    role="presentation"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(entry.path);
                    }}
                  >
                    <Icon name={expanded ? "i-chevdown" : "i-chev"} size={12} />
                  </span>
                ) : (
                  <Icon className="ico" name="i-file" size={14} />
                )}
                <span className="side-name">{entry.name}</span>
                <SyncMark sync={entry.sync} />
                <AgentMark listing={entry.listing} />
                {entry.change && (
                  // a letter as well as a colour, and a name for anyone not seeing either
                  <span className={`side-change is-${entry.change}`} title={t(CHANGE_KEY[entry.change])} aria-label={t(CHANGE_KEY[entry.change])}>
                    {CHANGE_LETTER[entry.change]}
                  </span>
                )}
              </button>
            </div>
          }
        >
          <ContextMenuActionItem icon={<Icon name="i-cut" size={13} />} name={t("files.cut")} onSelect={() => clipboard.cut([entry.path])} />
          <ContextMenuActionItem icon={<Icon name="i-copy" size={13} />} name={t("files.copy")} onSelect={() => clipboard.copy([entry.path])} />
          {dir && clipboard.entry && <ContextMenuActionItem icon={<Icon name="i-paste" size={13} />} name={t("files.paste")} onSelect={() => runPaste(entry.path)} />}
          <SyncContextActions actions={syncActions} paths={[entry.path]} entry={entry} />
          <AgentContextActions actions={agentActions} paths={[entry.path]} entry={entry} />
          <ContextMenuActionItem icon={<Icon name="i-trash" size={13} />} name={t("files.delete")} onSelect={() => deleteEntry(entry)} />
        </ContextMenu>,
        ...(expanded ? rows(entry.path, depth + 1) : [])
      ];
    });

  const head = (
      <>
        {syncActions.confirmation}
        <button type="button" className="side-label-btn side-module-btn side-files-home" aria-current={filePath === ""} onClick={() => openFile("")}>
          <Icon name="i-folder" size={14} />
          <Eyebrow className="side-label side-module-title">{t("files.eyebrow")}</Eyebrow>
        </button>
        {state.warn && !unavailable && <span className={`side-mark is-state is-${stateKey}`} title={state.label} data-state={stateKey} />}
        <Spacer />
        {notesOn && (
          <button
            type="button"
            className="btn btn-icon side-files-search"
            data-tip={t("notes.search")}
            data-tip-side="bottom"
            aria-label={t("notes.search")}
            aria-pressed={searching}
            disabled={unavailable}
            onClick={() => (searching ? notesSearch.close() : notesSearch.open())}
          >
            <Icon name="i-search" size={13} />
          </button>
        )}
        <Menu
          label={t("files.addMenu")}
          align="end"
          trigger={
            <button type="button" className="btn btn-icon side-files-add" data-tip={t("files.addMenu")} data-tip-side="bottom" aria-label={t("files.addMenu")} disabled={unavailable || importFiles.isPending}>
              <Icon name="i-plus" size={13} />
            </button>
          }
        >
          <MenuActionItem icon={<Icon name="i-pen" size={13} />} name={t("notes.newNote")} onSelect={() => setCreatingNote(true)} />
          {notesOn && <MenuActionItem icon={<Icon name="i-calendar" size={13} />} name={t("notes.today")} onSelect={() => void noteActions.openToday()} />}
          <MenuActionItem icon={<Icon name="i-plus" size={13} />} name={t("files.newFolder")} onSelect={() => setCreating(true)} />
          <MenuActionItem icon={<Icon name="i-file" size={13} />} name={t("files.addFiles")} onSelect={() => void addFiles("files")} />
          <MenuActionItem icon={<Icon name="i-folder" size={13} />} name={t("files.addFolder")} onSelect={() => void addFiles("folders")} />
        </Menu>
        {!unavailable && clipboard.entry && (
          <button type="button" className="btn btn-icon side-files-paste" data-tip={t("files.paste")} data-tip-side="bottom" aria-label={t("files.pasteAria")} onClick={() => runPaste(currentDir)}>
            <Icon name="i-paste" size={13} />
          </button>
        )}
      </>
  );
  const body = searching ? (
        <NotesSearch />
      ) : (
      <div
        className={`side-list side-files-list${dragOver === "" ? " is-drag-over" : ""}`}
        style={{ display: "flex", flexDirection: "column", gap: 1 }}
        onDragOver={unavailable ? undefined : (e) => { e.preventDefault(); setDragOver(""); }}
        onDragLeave={unavailable ? undefined : () => setDragOver((cur) => (cur === "" ? null : cur))}
        onDrop={
          unavailable
            ? undefined
            : (e) => {
                e.preventDefault();
                setDragOver(null);
                dropFiles("", e.dataTransfer);
              }
        }
      >
        {rows("", 0)}
        {creating && <InlineNameRow icon="i-folder" ariaLabel={t("files.newFolderNameAria")} placeholder={t("files.folderNamePlaceholder")} onCommit={createFolder} onCancel={() => setCreating(false)} />}
        {creatingNote && (
          <InlineNameRow
            icon="i-pen"
            ariaLabel={t("notes.newNoteAria")}
            placeholder={t("notes.notePlaceholder")}
            onCommit={(name) => {
              setCreatingNote(false);
              if (name.trim()) {
                show(currentDir);
                void noteActions.createNote(currentDir, name);
              }
            }}
            onCancel={() => setCreatingNote(false)}
          />
        )}
        {!entries.length && !creating && !creatingNote && !tree.isLoading && (
          <div className="side-files-empty-placeholder">
            <Icon className="ico" name="i-upload" size={14} />
            <span className="side-name">{unavailable ? t("files.unavailable") : t("files.dropHint")}</span>
          </div>
        )}
      </div>
      );
  return frame(head, body);
}
