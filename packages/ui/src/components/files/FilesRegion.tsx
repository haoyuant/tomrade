import { Fragment, useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { useSearch } from "@tanstack/react-router";
import type { FileReference } from "@tomrade/domain";
import type { ConflictChoice, FileConflict, FileEntry, FilesStatus } from "@tomrade/files";
import { Icon } from "~/components/icons";
import { SyncContextActions, SyncLine, SyncMark, SyncScopeSummary, SyncSelect, useSyncActions, type SyncActions } from "./SyncPolicy";
import { Eyebrow, Spacer, Tag } from "~/components/ui/atoms";
import { ContextMenu, ContextMenuActionItem, Menu, MenuActionItem } from "~/components/ui/menu";
import { useWorkspace } from "~/components/workspace/context";
import { agoLabel } from "~/lib/domain";
import {
  FILES_DRAG_MIME,
  formatSize,
  nameOf,
  parentOf,
  useCopyFile,
  useFileConflicts,
  useFileContent,
  useFileHistory,
  useFileLocation,
  useFilesClipboard,
  useFileVersion,
  useFilesInfo,
  useFilesStatus,
  useFilesTree,
  useImportFiles,
  useMakeFolder,
  useMoveFile,
  usePasteFiles,
  useRemoveFile,
  useResolveAllConflicts,
  useResolveConflict,
  useSyncFiles,
  type FilesClipboardEntry
} from "~/lib/files";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useRevert } from "~/lib/queries";
import { pickFiles, reveal } from "~/lib/shell";
import { useToast } from "~/lib/toast";
import { AttachToTicketDialog } from "./AttachToTicketDialog";
import { ConflictPanel } from "./ConflictPanel";
import { FileViewer } from "./FileViewer";
import { stateOf, type StateView } from "./state";

const KIND: Record<FileConflict["kind"], MessageKey> = {
  content: "files.kindContent",
  "add-add": "files.kindAddAdd",
  "modify-delete": "files.kindModifyDelete",
  "delete-modify": "files.kindDeleteModify"
};

/** One line under the head that takes a name: a rename, or a new folder. */
function NamePrompt({ initial = "", ariaLabel, placeholder, busy, onCommit, onCancel }: { initial?: string; ariaLabel: string; placeholder?: string; busy: boolean; onCommit: (name: string) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== initial) onCommit(trimmed);
    else onCancel();
  };
  return (
    <div className="files-prompt row">
      <input
        className="input"
        autoFocus
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <button type="button" className="btn btn-secondary" disabled={busy || !value.trim()} onClick={commit}>
        {t("files.save")}
      </button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>
        {t("files.cancel")}
      </button>
    </div>
  );
}

/** Where the files are shared and how they stand, on the root page; the block in project settings has the controls. */
function SharingCard({ projectId, status, state, onOpenSharing }: { projectId: string; status: FilesStatus | undefined; state: StateView; onOpenSharing: () => void }) {
  const { t } = useI18n();
  return (
    <div className="panel files-sharing-card" data-testid="files-sharing">
      <div className="cfg-row">
        <Icon name={state.warn ? "i-warn" : "i-plug"} size={15} style={{ color: state.warn ? "var(--danger)" : "var(--accent)" }} />
        <span className="cfg-name num" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {status?.location ?? state.label}
        </span>
        {status?.lastSyncAt && <span className="meta-txt">{agoLabel(status.lastSyncAt)}</span>}
        <Tag tone={state.tone}>{state.label}</Tag>
        <button type="button" className="btn btn-ghost files-open-sharing" onClick={onOpenSharing}>
          {t("files.sharing")}
        </button>
      </div>
      <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
        {status?.detail ? t("files.hintWithDetail", { hint: state.hint, detail: status.detail }) : state.hint}
      </p>
      <SyncScopeSummary projectId={projectId} />
    </div>
  );
}

/** Every clash at once, each a link to its file, and the two ways to take them all. */
function ConflictList({ projectId, conflicts }: { projectId: string; conflicts: FileConflict[] }) {
  const { t } = useI18n();
  const { openFile } = useWorkspace();
  const toast = useToast();
  const resolveAll = useResolveAllConflicts(projectId);
  const all = (choice: ConflictChoice) => resolveAll.mutate(choice, { onError: (error) => toast({ body: error.message }) });
  return (
    <div className="stack-3 files-conflict-list" data-testid="conflict-list">
      <div className="dangerbar">
        <Icon className="b-mark" name="i-warn" size={15} />
        <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>{conflicts.length === 1 ? t("files.conflictOne") : t("files.conflictMany", { n: conflicts.length })}</p>
        <button type="button" className="btn btn-ghost" disabled={resolveAll.isPending} onClick={() => all("ours")}>
          {t("files.keepAllMine")}
        </button>
        <button type="button" className="btn btn-ghost" disabled={resolveAll.isPending} onClick={() => all("theirs")}>
          {t("files.keepAllTheirs")}
        </button>
      </div>
      <div className="stack-1">
        {conflicts.map((c) => (
          <button key={c.path} type="button" className="menu-row" data-file={c.path} onClick={() => openFile(c.path)}>
            <span className="m-mark">
              <Icon name="i-warn" size={13} />
            </span>
            <span className="m-stack">
              <span className="m-name num">{c.path}</span>
              <span className="m-sub">{t(KIND[c.kind])}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The bar that replaces the plain toolbar while rows are checked: a count, and the actions that take the whole set. */
function SelectionBar({ count, sync, onCut, onCopy, onDelete, onClear }: { count: number; sync: ReactNode; onCut: () => void; onCopy: () => void; onDelete: () => void; onClear: () => void }) {
  const { t } = useI18n();
  return (
    <div className="lockbar files-selection-bar" role="toolbar" data-testid="files-selection-bar">
      <span className="selection-count">{t("files.selectionCount", { n: count })}</span>
      {sync}
      <button type="button" className="btn btn-ghost sel-cut" onClick={onCut}>
        <Icon name="i-cut" size={13} />
        {t("files.cut")}
      </button>
      <button type="button" className="btn btn-ghost sel-copy" onClick={onCopy}>
        <Icon name="i-copy" size={13} />
        {t("files.copy")}
      </button>
      <button type="button" className="btn btn-ghost sel-delete" onClick={onDelete}>
        <Icon name="i-trash" size={13} />
        {t("files.delete")}
      </button>
      <button type="button" className="btn btn-icon sel-clear" data-tip={t("files.clearSelection")} aria-label={t("files.clearSelection")} onClick={onClear}>
        <Icon name="i-close" size={12} />
      </button>
    </div>
  );
}

function FolderView({
  projectId,
  path,
  entries,
  conflicts,
  status,
  state,
  clipboardEntry,
  onOpenSharing,
  onAddFiles,
  onDropFiles,
  onCut,
  onCopy,
  onPasteInto,
  onDeleteMany,
  onMoveInto,
  dragOver,
  onDragOverChange,
  syncActions
}: {
  projectId: string;
  path: string;
  entries: FileEntry[];
  conflicts: FileConflict[];
  status: FilesStatus | undefined;
  state: StateView;
  clipboardEntry: FilesClipboardEntry | null;
  onOpenSharing: () => void;
  onAddFiles: () => void;
  onDropFiles: (dataTransfer: DataTransfer) => void;
  onCut: (paths: string[]) => void;
  onCopy: (paths: string[]) => void;
  onPasteInto: (dir: string) => void;
  onDeleteMany: (paths: string[]) => void;
  onMoveInto: (paths: string[], dir: string) => void;
  dragOver: boolean;
  onDragOverChange: (over: boolean) => void;
  syncActions: SyncActions;
}) {
  const { t } = useI18n();
  const { openFile } = useWorkspace();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const kids = entries.filter((e) => parentOf(e.path) === path);
  const cutPaths = clipboardEntry?.mode === "cut" ? new Set(clipboardEntry.paths) : null;
  const toggleSelect = (p: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  const selectOnly = (p: string) => setSelected((prev) => (prev.has(p) ? prev : new Set([p])));
  const targetsFor = (p: string) => (selected.has(p) ? [...selected] : [p]);
  const startDrag = (p: string) => (e: DragEvent) => {
    e.dataTransfer.setData(FILES_DRAG_MIME, JSON.stringify(targetsFor(p)));
    e.dataTransfer.effectAllowed = "move";
  };
  return (
    <div
      className={`files-main stack-4${dragOver ? " is-drag-over" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(FILES_DRAG_MIME)) return;
        e.preventDefault();
        onDragOverChange(true);
      }}
      onDragLeave={() => onDragOverChange(false)}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(FILES_DRAG_MIME)) return;
        e.preventDefault();
        onDragOverChange(false);
        onDropFiles(e.dataTransfer);
      }}
    >
      {path === "" && conflicts.length > 0 && <ConflictList projectId={projectId} conflicts={conflicts} />}
      {path === "" && <SharingCard projectId={projectId} status={status} state={state} onOpenSharing={onOpenSharing} />}
      {selected.size > 0 && (
        <SelectionBar
          count={selected.size}
          sync={<SyncSelect actions={syncActions} paths={[...selected]} value="" label={t("files.syncFor", { name: t("files.selectionCount", { n: selected.size }) })} />}
          onCut={() => onCut([...selected])}
          onCopy={() => onCopy([...selected])}
          onDelete={() => onDeleteMany([...selected])}
          onClear={() => setSelected(new Set())}
        />
      )}
      {kids.length > 0 ? (
        <table className="file-table" data-testid="file-table">
          <thead>
            <tr>
              <th className="file-select-col" aria-hidden="true" />
              <th>{t("files.nameCol")}</th>
              <th className="num">{t("files.sizeCol")}</th>
              <th>{t("files.modifiedCol")}</th>
            </tr>
          </thead>
          <tbody>
            {kids.map((e) => (
              <ContextMenu
                key={e.path}
                label={e.name}
                trigger={
                  <tr
                    className={`file-row${selected.has(e.path) ? " is-selected" : ""}${cutPaths?.has(e.path) ? " is-cut" : ""}${dropTarget === e.path ? " is-drag-over" : ""}`}
                    data-file={e.path}
                    draggable
                    onDragStart={startDrag(e.path)}
                    onMouseDown={(ev) => {
                      if (ev.button === 2) selectOnly(e.path);
                    }}
                    onDragOver={
                      e.kind === "dir"
                        ? (ev) => {
                            if (!ev.dataTransfer.types.includes(FILES_DRAG_MIME)) return;
                            ev.preventDefault();
                            ev.stopPropagation();
                            setDropTarget(e.path);
                          }
                        : undefined
                    }
                    onDragLeave={e.kind === "dir" ? () => setDropTarget((cur) => (cur === e.path ? null : cur)) : undefined}
                    onDrop={
                      e.kind === "dir"
                        ? (ev) => {
                            const data = ev.dataTransfer.getData(FILES_DRAG_MIME);
                            if (!data) return;
                            ev.preventDefault();
                            ev.stopPropagation();
                            setDropTarget(null);
                            try {
                              onMoveInto(JSON.parse(data) as string[], e.path);
                            } catch {
                              // not a path payload
                            }
                          }
                        : undefined
                    }
                  >
                    <td className="file-select-col">
                      <input type="checkbox" aria-label={t("files.selectRow", { name: e.name })} checked={selected.has(e.path)} onChange={() => toggleSelect(e.path)} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="file-link"
                        onClick={(ev) => {
                          if (ev.metaKey || ev.ctrlKey) {
                            ev.preventDefault();
                            toggleSelect(e.path);
                            return;
                          }
                          openFile(e.path);
                        }}
                      >
                        <Icon name={e.kind === "dir" ? "i-folder" : "i-file"} size={14} />
                        <span>{e.name}</span>
                        <SyncMark sync={e.sync} />
                        {e.change && <span className={`side-mark is-${e.change}`} title={e.change} />}
                      </button>
                    </td>
                    <td className="num meta-txt">{e.kind === "dir" ? "—" : formatSize(e.size)}</td>
                    <td className="meta-txt">{agoLabel(e.modifiedAt)}</td>
                  </tr>
                }
              >
                <ContextMenuActionItem icon={<Icon name="i-cut" size={13} />} name={t("files.cut")} onSelect={() => onCut(targetsFor(e.path))} />
                <ContextMenuActionItem icon={<Icon name="i-copy" size={13} />} name={t("files.copy")} onSelect={() => onCopy(targetsFor(e.path))} />
                {e.kind === "dir" && clipboardEntry && <ContextMenuActionItem icon={<Icon name="i-paste" size={13} />} name={t("files.paste")} onSelect={() => onPasteInto(e.path)} />}
                <SyncContextActions actions={syncActions} paths={targetsFor(e.path)} entry={e} />
                <ContextMenuActionItem icon={<Icon name="i-trash" size={13} />} name={t("files.delete")} onSelect={() => onDeleteMany(targetsFor(e.path))} />
              </ContextMenu>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="files-empty">
          <p className="meta-txt">{t("files.folderEmpty")}</p>
          <div className="row">
            <button type="button" className="btn btn-secondary" onClick={onAddFiles}>
              <Icon name="i-upload" size={13} />
              {t("files.addFiles")}
            </button>
            {clipboardEntry && (
              <button type="button" className="btn btn-secondary" onClick={() => onPasteInto(path)}>
                <Icon name="i-paste" size={13} />
                {t("files.paste")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FileView({ projectId, path, conflict }: { projectId: string; path: string; conflict: FileConflict | null }) {
  const { t } = useI18n();
  const toast = useToast();
  const content = useFileContent(projectId, path);
  const history = useFileHistory(projectId, path);
  const resolve = useResolveConflict(projectId);
  const [versionId, setVersionId] = useState<string | null>(null);
  useEffect(() => setVersionId(null), [path]);
  const fileId = content.data?.fileId ?? null;
  const older = useFileVersion(projectId, versionId && fileId ? { fileId, versionId } : null);
  const versions = history.data ?? [];
  // The rail's own newest row, so a click compares against what is drawn, not a content fetch still in flight.
  const latest = versions[0]?.versionId ?? content.data?.versionId ?? null;
  const shown = versionId ? (older.data ?? null) : (content.data ?? null);
  const choose = (choice: ConflictChoice) =>
    resolve.mutate(
      { path, choice },
      {
        onSuccess: () => toast({ body: t("files.resolvedToast", { choice: t(choice === "ours" ? "files.sideMine" : choice === "theirs" ? "files.sideTheirs" : "files.sideBoth"), name: nameOf(path) }) }),
        onError: (error) => toast({ body: error.message })
      }
    );
  return (
    <>
      <div className="files-main">
        {conflict ? (
          <ConflictPanel conflict={conflict} busy={resolve.isPending} onChoose={choose} />
        ) : (
          <>
            {versionId && (
              <div className="banner files-version-banner" role="status">
                <Icon className="b-mark" name="i-clock" size={15} />
                <span>{t("files.olderVersion", { when: agoLabel(versions.find((v) => v.versionId === versionId)?.at ?? Date.now()) })}</span>
                <button type="button" className="btn btn-ghost" style={{ marginLeft: "auto", padding: "3px 8px" }} onClick={() => setVersionId(null)}>
                  {t("files.backToLatest")}
                </button>
              </div>
            )}
            {content.isLoading || (versionId && older.isLoading) ? null : shown ? <FileViewer content={shown} /> : <p className="meta-txt">{t("files.fileGone", { path })}</p>}
          </>
        )}
      </div>
      <aside className="files-rail" aria-label={t("files.versions")} data-testid="files-versions">
        <Eyebrow>{t("files.versions")}</Eyebrow>
        {versions.length === 0 && !history.isLoading && <p className="meta-txt dense">{t("files.noVersions")}</p>}
        <div className="version-list">
          {versions.map((v) => (
            <button key={v.versionId} type="button" className="version-row" data-version={v.versionId} aria-current={v.versionId === (versionId ?? latest)} onClick={() => setVersionId(v.versionId === latest ? null : v.versionId)}>
              <span className="v-msg">{v.message}</span>
              <span className="meta-txt">
                {agoLabel(v.at)} · {v.author}
              </span>
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}

/** A version a ticket pinned: read from the history, never from the working copy, and honest when it is gone. */
function PinnedVersion({ projectId, ref }: { projectId: string; ref: FileReference }) {
  const { t } = useI18n();
  const { openFile } = useWorkspace();
  const version = useFileVersion(projectId, ref);
  const location = useFileLocation(projectId, ref.fileId);
  if (version.isLoading) return <div className="files-main" />;
  if (!version.data) {
    return (
      <div className="files-main">
        <div className="dangerbar" data-testid="pinned-missing">
          <Icon className="b-mark" name="i-warn" size={15} />
          <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>{version.error ? version.error.message : t("files.missingVersion")}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="files-main">
      <div className="banner files-pinned-banner" role="status" data-testid="pinned-banner">
        <Icon className="b-mark" name="i-lock" size={15} />
        <span>{t("files.pinnedBanner", { path: version.data.path, version: ref.versionId.slice(0, 7) })}</span>
        {location.data && (
          <button type="button" className="btn btn-ghost" style={{ marginLeft: "auto", padding: "3px 8px" }} onClick={() => openFile(location.data!)}>
            {t("files.openCurrent")}
          </button>
        )}
      </div>
      <FileViewer content={version.data} />
    </div>
  );
}

/**
 * The Files screen: a path in the project's files takes the board's place.
 * The head is the path itself, the state and the actions; the body is a
 * folder's listing, a file with its versions, a clash waiting for a choice,
 * or a version a ticket pinned.
 */
export function FilesRegion({ path, onOpenSharing }: { path: string; onOpenSharing: () => void }) {
  const ws = useWorkspace();
  const projectId = ws.project.id;
  const { t } = useI18n();
  const toast = useToast();
  const STATE = stateOf(t);
  const search = useSearch({ strict: false }) as { id?: string; v?: string };
  const pinned = search.id && search.v ? { fileId: search.id, versionId: search.v } : null;
  const tree = useFilesTree(projectId);
  const status = useFilesStatus(projectId);
  const syncActions = useSyncActions(projectId);
  const info = useFilesInfo(projectId);
  const sync = useSyncFiles(projectId);
  const remove = useRemoveFile(projectId);
  const revert = useRevert(projectId);
  const move = useMoveFile(projectId);
  const copy = useCopyFile(projectId);
  const mkdir = useMakeFolder(projectId);
  const importFiles = useImportFiles(projectId);
  const clipboard = useFilesClipboard(projectId);
  const pasteFiles = usePasteFiles(projectId);
  const [renaming, setRenaming] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<string[] | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    setRenaming(false);
    setDeleteTargets(null);
    setNewFolder(false);
    setAttaching(false);
    setDragOver(false);
  }, [path]);

  const entries = tree.data ?? [];
  const entry = entries.find((e) => e.path === path) ?? null;
  const isDir = path === "" || entry?.kind === "dir";
  const dir = isDir ? path : parentOf(path);
  const stateKey = status.data?.state ?? "local";
  const state = STATE[stateKey];
  const conflictCount = status.data?.conflicts ?? 0;
  const conflicts = useFileConflicts(projectId, conflictCount > 0);
  const segments = path ? path.split("/") : [];
  const absPath = info.data?.dir ? `${info.data.dir}/${path}`.replace(/\/$/, "") : null;
  const busy = deletingBusy || move.isPending || mkdir.isPending || copy.isPending;
  const existing = useMemo(() => new Set(entries.map((e) => e.path)), [entries]);

  const syncNow = () =>
    sync.mutate(undefined, {
      onSuccess: (next) => toast({ body: t("files.syncedToast", { label: STATE[next.state].label.toLowerCase() }) }),
      onError: (error) => toast({ body: error.message })
    });
  const addFiles = async (kind: "files" | "folders" = "files") => {
    const chosen = await pickFiles(t(kind === "folders" ? "files.pickFolderTitle" : "files.pickFilesTitle"), t("files.pickFilesButton"), kind);
    if (!chosen?.length) return;
    importFiles.mutate(
      { dir, sources: chosen },
      {
        onSuccess: (added) => {
          const one = added.length === 1 ? added[0]! : null;
          toast({ body: one ? t(one.kind === "dir" ? "files.addedFolderToast" : "files.addedOneToast", { name: one.name }) : t("files.addedToast", { n: added.length, dir: dir || t("files.home") }) });
        },
        onError: (error) => toast({ body: error.message })
      }
    );
  };
  const dropFiles = (dataTransfer: DataTransfer) => {
    const sources = [...dataTransfer.files].map((f) => (f as File & { path?: string }).path).filter((p): p is string => !!p);
    if (!sources.length) return;
    importFiles.mutate(
      { dir, sources },
      {
        onSuccess: (added) => {
          const one = added.length === 1 ? added[0]! : null;
          toast({ body: one ? t(one.kind === "dir" ? "files.addedFolderToast" : "files.addedOneToast", { name: one.name }) : t("files.addedToast", { n: added.length, dir: dir || t("files.home") }) });
        },
        onError: (error) => toast({ body: error.message })
      }
    );
  };
  const rename = (name: string) => {
    const to = parentOf(path) ? `${parentOf(path)}/${name}` : name;
    move.mutate(
      { from: path, to },
      {
        onSuccess: () => {
          setRenaming(false);
          ws.openFile(to);
          toast({ body: t("files.renamedToast", { name }) });
        },
        onError: (error) => toast({ body: error.message })
      }
    );
  };
  const createFolder = (name: string) => {
    const target = dir ? `${dir}/${name}` : name;
    mkdir.mutate(target, {
      onSuccess: () => {
        setNewFolder(false);
        ws.openFile(target);
        toast({ body: t("files.createdFolderToast", { name }) });
      },
      onError: (error) => toast({ body: error.message })
    });
  };
  const del = async () => {
    if (!deleteTargets) return;
    setDeletingBusy(true);
    try {
      const refs: string[] = [];
      for (const target of deleteTargets) {
        const ref = await remove.mutateAsync(target);
        if (ref) refs.push(ref);
      }
      const n = deleteTargets.length;
      const name = n === 1 ? nameOf(deleteTargets[0]!) : "";
      const wasOpen = deleteTargets.includes(path);
      setDeleteTargets(null);
      if (wasOpen) ws.openFile(parentOf(path));
      // Undo takes back exactly these records, newest first, whatever else has happened since.
      const undoAll = async () => {
        for (const ref of [...refs].reverse()) await revert.mutateAsync(ref);
        toast({ body: n === 1 ? t("files.restoredToast", { name }) : t("files.restoredManyToast", { n }) });
      };
      toast({
        body: n === 1 ? t("files.deletedToast", { name }) : t("files.deletedManyToast", { n }),
        onUndo: refs.length ? () => void undoAll().catch((error: Error) => toast({ body: error.message })) : undefined
      });
    } catch (error) {
      toast({ body: (error as Error).message });
    } finally {
      setDeletingBusy(false);
    }
  };
  const runPaste = (target: string) => {
    const clip = clipboard.entry;
    if (!clip) return;
    pasteFiles(clip, target, existing)
      .then(({ count, name }) => {
        // Nothing moved because it was already there — a no-op, not a paste to announce.
        if (!count) return;
        if (clip.mode === "cut") clipboard.clear();
        toast({ body: count === 1 ? t("files.pastedOneToast", { name }) : t("files.pastedManyToast", { n: count }) });
      })
      .catch((error) => toast({ body: error.message }));
  };
  const moveInto = (paths: string[], target: string) => {
    pasteFiles({ projectId, mode: "cut", paths }, target, existing)
      .then(({ count, name }) => {
        if (!count) return;
        toast({ body: count === 1 ? t("files.movedOneToast", { name }) : t("files.movedManyToast", { n: count }) });
      })
      .catch((error) => toast({ body: error.message }));
  };

  return (
    <section className="board-region files-region" data-testid="files-region" data-path={path}>
      <div className="board-head files-head">
        <Icon className="view-ico" name={isDir ? "i-folder" : "i-file"} size={16} />
        <nav className="files-crumbs" aria-label={t("files.home")}>
          <button type="button" className="crumb" aria-current={path === ""} onClick={() => ws.openFile("")}>
            {t("files.home")}
          </button>
          {segments.map((segment, i) =>
            renaming && i === segments.length - 1 ? (
              <Fragment key={i}>
                <span className="crumb-sep">/</span>
                <input
                  className="crumb crumb-edit"
                  autoFocus
                  type="text"
                  aria-label={t("files.renameAria")}
                  defaultValue={segment}
                  disabled={busy}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const name = (e.target as HTMLInputElement).value.trim();
                      if (name) rename(name);
                      else setRenaming(false);
                    }
                    if (e.key === "Escape") setRenaming(false);
                  }}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== segment) rename(name);
                    else setRenaming(false);
                  }}
                />
              </Fragment>
            ) : (
              <Fragment key={i}>
                <span className="crumb-sep">/</span>
                <button type="button" className="crumb" aria-current={i === segments.length - 1} onClick={() => ws.openFile(segments.slice(0, i + 1).join("/"))}>
                  {segment}
                </button>
              </Fragment>
            )
          )}
          {path && !renaming && (
            <button type="button" className="btn btn-icon crumb-rename" data-tip={t("files.rename")} data-tip-side="bottom" aria-label={t("files.rename")} onClick={() => setRenaming(true)}>
              <Icon name="i-pen" size={12} />
            </button>
          )}
        </nav>
        <div className="board-facts">
          {entry && !isDir && <span className="tag faint num">{formatSize(entry.size)}</span>}
          {entry && <span className="meta-txt">{agoLabel(entry.modifiedAt)}</span>}
        </div>
        <Spacer />
        <Tag tone={state.tone} title={status.data?.detail ?? state.hint}>
          {state.label}
        </Tag>
        <button type="button" className="btn btn-ghost files-sync" title={t("files.sync")} aria-label={t("files.sync")} disabled={sync.isPending || stateKey === "unavailable"} onClick={syncNow}>
          <Icon name="i-sync" size={13} />
          {sync.isPending || stateKey === "syncing" ? t("files.syncing") : t("files.sync")}
        </button>
        <div className="files-dir-actions" style={{ display: "flex", gap: "var(--space-1)", alignItems: "center" }}>
          {isDir && (
            <Menu
              label={t("files.addMenu")}
              align="end"
              trigger={
                <button type="button" className="btn btn-icon files-add" data-tip={t("files.addMenu")} data-tip-side="bottom" aria-label={t("files.addMenu")}>
                  <Icon name="i-plus" size={14} />
                </button>
              }
            >
              <MenuActionItem icon={<Icon name="i-plus" size={13} />} name={t("files.newFolder")} onSelect={() => setNewFolder(true)} />
              <MenuActionItem icon={<Icon name="i-file" size={13} />} name={t("files.addFiles")} onSelect={() => void addFiles("files")} />
              <MenuActionItem icon={<Icon name="i-folder" size={13} />} name={t("files.addFolder")} onSelect={() => void addFiles("folders")} />
            </Menu>
          )}
          {isDir && clipboard.entry && (
            <button type="button" className="btn btn-icon files-paste" data-tip={t("files.paste")} data-tip-side="bottom" aria-label={t("files.pasteAria")} onClick={() => runPaste(dir)}>
              <Icon name="i-paste" size={14} />
            </button>
          )}
          {!isDir && (
            <>
              <button type="button" className="btn btn-icon files-cut" data-tip={t("files.cut")} data-tip-side="bottom" aria-label={t("files.cut")} onClick={() => clipboard.cut([path])}>
                <Icon name="i-cut" size={14} />
              </button>
              <button type="button" className="btn btn-icon files-copy" data-tip={t("files.copy")} data-tip-side="bottom" aria-label={t("files.copy")} onClick={() => clipboard.copy([path])}>
                <Icon name="i-copy" size={14} />
              </button>
              <button type="button" className="btn btn-icon" data-tip={t("files.attachToTicket")} data-tip-side="bottom" aria-label={t("files.attachToTicket")} onClick={() => setAttaching(true)}>
                <Icon name="i-tag" size={14} />
              </button>
            </>
          )}
          {absPath && (
            <button type="button" className="btn btn-icon" data-tip={t("files.reveal")} data-tip-side="bottom" aria-label={t("files.reveal")} onClick={() => reveal(absPath)}>
              <Icon name="i-folder" size={14} />
            </button>
          )}
          <button type="button" className="btn btn-icon" data-tip={t("files.sharing")} data-tip-side="bottom" aria-label={t("files.sharing")} onClick={onOpenSharing}>
            <Icon name="i-plug" size={14} />
          </button>
          {path && (
            <button type="button" className="btn btn-icon" data-tip={t("files.delete")} data-tip-side="bottom" aria-label={t("files.delete")} onClick={() => setDeleteTargets([path])}>
              <Icon name="i-trash" size={14} />
            </button>
          )}
        </div>
      </div>

      {conflictCount > 0 && path !== "" && (
        <div className="banner files-conflict-banner" role="alert">
          <Icon className="b-mark" name="i-warn" size={15} />
          <span>{conflictCount === 1 ? t("files.conflictOne") : t("files.conflictMany", { n: conflictCount })}</span>
          <button type="button" className="btn btn-ghost" style={{ marginLeft: "auto", padding: "3px 8px" }} onClick={() => ws.openFile("")}>
            {t("files.review")}
          </button>
        </div>
      )}
      {newFolder && <NamePrompt ariaLabel={t("files.newFolderNameAria")} placeholder={t("files.folderNamePlaceholder")} busy={busy} onCommit={createFolder} onCancel={() => setNewFolder(false)} />}
      {deleteTargets && (
        <div className="dangerbar files-delete" role="alertdialog">
          <Icon className="b-mark" name="i-warn" size={15} />
          <p style={{ flex: 1, fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>
            {deleteTargets.length === 1 ? t("files.deleteConfirm", { name: nameOf(deleteTargets[0]!) }) : t("files.deleteConfirmMany", { n: deleteTargets.length })}
          </p>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void del()}>
            {t("files.deleteYes")}
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setDeleteTargets(null)}>
            {t("files.cancel")}
          </button>
        </div>
      )}

      {syncActions.confirmation}
      {!pinned && stateKey !== "unavailable" && path !== "" && entry && <SyncLine actions={syncActions} entry={entry} />}
      <div className="files-body">
        {stateKey === "unavailable" ? (
          <div className="files-main">
            <div className="dangerbar">
              <Icon className="b-mark" name="i-warn" size={15} />
              <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>{status.data?.detail ?? t("files.unavailable")}</p>
              <button type="button" className="btn btn-ghost" onClick={onOpenSharing}>
                {t("files.sharing")}
              </button>
            </div>
          </div>
        ) : pinned ? (
          <PinnedVersion projectId={projectId} ref={pinned} />
        ) : isDir ? (
          <FolderView
            key={path}
            projectId={projectId}
            path={path}
            entries={entries}
            conflicts={conflicts.data ?? []}
            status={status.data}
            state={state}
            clipboardEntry={clipboard.entry}
            onOpenSharing={onOpenSharing}
            onAddFiles={() => void addFiles()}
            onDropFiles={dropFiles}
            onCut={(paths) => clipboard.cut(paths)}
            onCopy={(paths) => clipboard.copy(paths)}
            onPasteInto={runPaste}
            onDeleteMany={setDeleteTargets}
            onMoveInto={moveInto}
            dragOver={dragOver}
            onDragOverChange={setDragOver}
            syncActions={syncActions}
          />
        ) : (
          <FileView projectId={projectId} path={path} conflict={conflicts.data?.find((c) => c.path === path) ?? null} />
        )}
      </div>
      {attaching && !isDir && <AttachToTicketDialog projectId={projectId} path={path} open={attaching} onOpenChange={setAttaching} />}
    </section>
  );
}
