import { Fragment, useEffect, useMemo, useState } from "react";
import { useSearch } from "@tanstack/react-router";
import type { FileReference } from "@tomradex/domain";
import type { FileEntry } from "@tomradex/files";
import { Icon } from "~/components/icons";
import { SyncMark, SyncSelect, describeSync, useSyncActions, type SyncActions } from "./SyncPolicy";
import { AgentSelect, describeListing, useAgentActions, type AgentActions } from "./AgentPolicy";
import { Spacer, Tag } from "~/components/ui/atoms";
import { Menu, MenuActionItem } from "~/components/ui/menu";
import { useWorkspace } from "~/components/workspace/context";
import { agoLabel } from "~/lib/domain";
import {
  formatSize,
  nameOf,
  parentOf,
  useCopyFile,
  useFileConflicts,
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
  useSyncFiles
} from "~/lib/files";
import { useI18n } from "~/lib/i18n";
import { useRevert } from "~/lib/queries";
import { pathForFile, pickFiles, reveal, revealLabel } from "~/lib/shell";
import { errorSpec, readableError, useToast } from "~/lib/toast";
import { useNotesEnabled } from "~/lib/notes";
import { AttachToTicketDialog } from "./AttachToTicketDialog";
import { FileView } from "./FileView";
import { FileViewer } from "./FileViewer";
import { FolderView } from "./FolderView";
import { stateOf } from "./state";
import { useNoteActions } from "./useNoteActions";
import { isCancelKey, isCommitKey } from "~/lib/keys";

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
          if (isCommitKey(e)) commit();
          if (isCancelKey(e)) {
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

/**
 * Both settings for what is open, on one line: where the bytes go, and whether
 * an agent is told this exists. They are different questions, so they sit side
 * by side rather than in one control.
 */
function EntryPolicyLine({ syncActions, agentActions, entry }: { syncActions: SyncActions; agentActions: AgentActions; entry: FileEntry }) {
  const { t } = useI18n();
  if (!entry.sync && !entry.listing) return null;
  return (
    <div className="files-entry-policy files-sync-line">
      <div className="files-entry-policy-grid">
        {entry.sync && (
          <div className="files-policy-card">
            <span className="files-policy-icon"><SyncMark sync={entry.sync} /></span>
            <span className="files-policy-copy">
              <span className="files-policy-label">{t("files.sync")}</span>
              <span className="files-policy-value meta-txt">{describeSync(t, entry.sync)}</span>
            </span>
            <SyncSelect actions={syncActions} paths={[entry.path]} value={entry.sync.source === "explicit" ? entry.sync.mode : "inherit"} label={t("files.syncFor", { name: entry.name })} />
          </div>
        )}
        {entry.listing && (
          <div className="files-policy-card">
            <span className="files-policy-icon">
              <Icon name={entry.listing.mode === "unlisted" || entry.listing.mixed ? "i-eye-off" : "i-eye"} size={13} />
            </span>
            <span className="files-policy-copy">
              <span className="files-policy-label">{t("files.agents")}</span>
              <span className="files-policy-value meta-txt">{describeListing(t, entry.listing)}</span>
            </span>
            <AgentSelect
              actions={agentActions}
              paths={[entry.path]}
              value={entry.listing.source === "explicit" ? entry.listing.mode : "inherit"}
              label={t("files.agentFor", { name: entry.name })}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** A version a ticket pinned: read from the history, never from the working copy, and honest when it is gone. */
function PinnedVersion({ projectId, ref }: { projectId: string; ref: FileReference }) {
  const { t } = useI18n();
  const { openFile } = useWorkspace();
  const version = useFileVersion(projectId, ref);
  const location = useFileLocation(projectId, ref.fileId);
  const actions = useNoteActions();
  const linking = useMemo(() => actions.linking(version.data?.path ?? ""), [actions, version.data?.path]);
  if (version.isLoading) return <div className="files-main" />;
  if (!version.data) {
    return (
      <div className="files-main">
        <div className="dangerbar" data-testid="pinned-missing">
          <Icon className="b-mark" name="i-warn" size={15} />
          <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>{version.error ? readableError(version.error) : t("files.missingVersion")}</p>
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
      <FileViewer content={version.data} linking={linking} />
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
  const agentActions = useAgentActions(projectId);
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
  const [newNote, setNewNote] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const notesOn = useNotesEnabled();
  const noteActions = useNoteActions();
  useEffect(() => {
    setRenaming(false);
    setDeleteTargets(null);
    setNewFolder(false);
    setNewNote(false);
    setAttaching(false);
    setDragOver(false);
  }, [path]);

  const entries = useMemo(() => tree.data ?? [], [tree.data]);
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
      onError: (error) => toast(errorSpec(error))
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
        onError: (error) => toast(errorSpec(error))
      }
    );
  };
  const dropFiles = (dataTransfer: DataTransfer) => {
    const sources = [...dataTransfer.files].map(pathForFile).filter((p): p is string => !!p);
    if (!sources.length) return;
    importFiles.mutate(
      { dir, sources },
      {
        onSuccess: (added) => {
          const one = added.length === 1 ? added[0]! : null;
          toast({ body: one ? t(one.kind === "dir" ? "files.addedFolderToast" : "files.addedOneToast", { name: one.name }) : t("files.addedToast", { n: added.length, dir: dir || t("files.home") }) });
        },
        onError: (error) => toast(errorSpec(error))
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
        onError: (error) => toast(errorSpec(error))
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
      onError: (error) => toast(errorSpec(error))
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
        onUndo: refs.length ? () => void undoAll().catch((error: Error) => toast(errorSpec(error))) : undefined
      });
    } catch (error) {
      toast(errorSpec(error));
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
      .catch((error) => toast(errorSpec(error)));
  };
  const moveInto = (paths: string[], target: string) => {
    pasteFiles({ projectId, mode: "cut", paths }, target, existing)
      .then(({ count, name }) => {
        if (!count) return;
        toast({ body: count === 1 ? t("files.movedOneToast", { name }) : t("files.movedManyToast", { n: count }) });
      })
      .catch((error) => toast(errorSpec(error)));
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
                    if (isCommitKey(e)) {
                      const name = (e.target as HTMLInputElement).value.trim();
                      if (name) rename(name);
                      else setRenaming(false);
                    }
                    if (isCancelKey(e)) setRenaming(false);
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
        <div className="files-dir-actions">
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
              <MenuActionItem icon={<Icon name="i-pen" size={13} />} name={t("notes.newNote")} onSelect={() => setNewNote(true)} />
              {notesOn && <MenuActionItem icon={<Icon name="i-calendar" size={13} />} name={t("notes.today")} onSelect={() => void noteActions.openToday()} />}
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
            <button type="button" className="btn btn-icon" data-tip={t(revealLabel())} data-tip-side="bottom" aria-label={t(revealLabel())} onClick={() => reveal(absPath)}>
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
      {newNote && (
        <NamePrompt
          ariaLabel={t("notes.newNoteAria")}
          placeholder={t("notes.notePlaceholder")}
          busy={busy}
          onCommit={(name) => {
            setNewNote(false);
            void noteActions.createNote(dir, name);
          }}
          onCancel={() => setNewNote(false)}
        />
      )}
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
      {!pinned && stateKey !== "unavailable" && path !== "" && entry && <EntryPolicyLine syncActions={syncActions} agentActions={agentActions} entry={entry} />}
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
            agentActions={agentActions}
          />
        ) : (
          <FileView key={path} projectId={projectId} path={path} conflict={conflicts.data?.find((c) => c.path === path) ?? null} />
        )}
      </div>
      {attaching && !isDir && <AttachToTicketDialog projectId={projectId} path={path} open={attaching} onOpenChange={setAttaching} />}
    </section>
  );
}
