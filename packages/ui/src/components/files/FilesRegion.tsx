import { Fragment, useEffect, useState } from "react";
import { useSearch } from "@tanstack/react-router";
import type { FileReference } from "@tomrade/domain";
import type { ConflictChoice, FileConflict, FileEntry, FilesStatus } from "@tomrade/files";
import { Icon } from "~/components/icons";
import { Eyebrow, Spacer, Tag } from "~/components/ui/atoms";
import { Menu, MenuActionItem } from "~/components/ui/menu";
import { useWorkspace } from "~/components/workspace/context";
import { agoLabel } from "~/lib/domain";
import {
  formatSize,
  nameOf,
  parentOf,
  useFileConflicts,
  useFileContent,
  useFileHistory,
  useFileLocation,
  useFileVersion,
  useFilesInfo,
  useFilesStatus,
  useFilesTree,
  useImportFiles,
  useMakeFolder,
  useMoveFile,
  useRemoveFile,
  useResolveAllConflicts,
  useResolveConflict,
  useSyncFiles
} from "~/lib/files";
import { useI18n, type MessageKey } from "~/lib/i18n";
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
function SharingCard({ status, state, onOpenSharing }: { status: FilesStatus | undefined; state: StateView; onOpenSharing: () => void }) {
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

function FolderView({ projectId, path, entries, conflicts, status, state, onOpenSharing, onAddFiles }: { projectId: string; path: string; entries: FileEntry[]; conflicts: FileConflict[]; status: FilesStatus | undefined; state: StateView; onOpenSharing: () => void; onAddFiles: () => void }) {
  const { t } = useI18n();
  const { openFile } = useWorkspace();
  const kids = entries.filter((e) => parentOf(e.path) === path);
  return (
    <div className="files-main stack-4">
      {path === "" && conflicts.length > 0 && <ConflictList projectId={projectId} conflicts={conflicts} />}
      {path === "" && <SharingCard status={status} state={state} onOpenSharing={onOpenSharing} />}
      {kids.length > 0 ? (
        <table className="file-table" data-testid="file-table">
          <thead>
            <tr>
              <th>{t("files.nameCol")}</th>
              <th className="num">{t("files.sizeCol")}</th>
              <th>{t("files.modifiedCol")}</th>
            </tr>
          </thead>
          <tbody>
            {kids.map((e) => (
              <tr key={e.path} className="file-row" data-file={e.path}>
                <td>
                  <button type="button" className="file-link" onClick={() => openFile(e.path)}>
                    <Icon name={e.kind === "dir" ? "i-folder" : "i-file"} size={14} />
                    <span>{e.name}</span>
                    {e.change && <span className={`side-mark is-${e.change}`} title={e.change} />}
                  </button>
                </td>
                <td className="num meta-txt">{e.kind === "dir" ? "—" : formatSize(e.size)}</td>
                <td className="meta-txt">{agoLabel(e.modifiedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="files-empty">
          <p className="meta-txt">{t("files.folderEmpty")}</p>
          <button type="button" className="btn btn-secondary" onClick={onAddFiles}>
            <Icon name="i-upload" size={13} />
            {t("files.addFiles")}
          </button>
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
  const info = useFilesInfo(projectId);
  const sync = useSyncFiles(projectId);
  const remove = useRemoveFile(projectId);
  const move = useMoveFile(projectId);
  const mkdir = useMakeFolder(projectId);
  const importFiles = useImportFiles(projectId);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const [attaching, setAttaching] = useState(false);
  useEffect(() => {
    setRenaming(false);
    setDeleting(false);
    setNewFolder(false);
    setAttaching(false);
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
  const busy = remove.isPending || move.isPending || mkdir.isPending;

  const syncNow = () =>
    sync.mutate(undefined, {
      onSuccess: (next) => toast({ body: t("files.syncedToast", { label: STATE[next.state].label.toLowerCase() }) }),
      onError: (error) => toast({ body: error.message })
    });
  const addFiles = async () => {
    const chosen = await pickFiles(t("files.pickFilesTitle"), t("files.pickFilesButton"));
    if (!chosen?.length) return;
    importFiles.mutate(
      { dir, sources: chosen },
      {
        onSuccess: (added) => toast({ body: added.length === 1 ? t("files.addedOneToast", { name: added[0]!.name }) : t("files.addedToast", { n: added.length, dir: dir || t("files.home") }) }),
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
  const del = () =>
    remove.mutate(path, {
      onSuccess: () => {
        setDeleting(false);
        ws.openFile(parentOf(path));
        toast({ body: t("files.deletedToast", { name: nameOf(path) }) });
      },
      onError: (error) => toast({ body: error.message })
    });

  return (
    <section className="board-region files-region" data-testid="files-region" data-path={path}>
      <div className="board-head files-head">
        <Icon className="view-ico" name={isDir ? "i-folder" : "i-file"} size={16} />
        <nav className="files-crumbs" aria-label={t("files.home")}>
          <button type="button" className="crumb" aria-current={path === ""} onClick={() => ws.openFile("")}>
            {t("files.home")}
          </button>
          {segments.map((segment, i) => (
            <Fragment key={i}>
              <span className="crumb-sep">/</span>
              <button type="button" className="crumb" aria-current={i === segments.length - 1} onClick={() => ws.openFile(segments.slice(0, i + 1).join("/"))}>
                {segment}
              </button>
            </Fragment>
          ))}
        </nav>
        <div className="board-facts">
          {entry && !isDir && <span className="tag faint num">{formatSize(entry.size)}</span>}
          {entry && <span className="meta-txt">{agoLabel(entry.modifiedAt)}</span>}
        </div>
        <Spacer />
        <Tag tone={state.tone} title={status.data?.detail ?? state.hint}>
          {state.label}
        </Tag>
        <button type="button" className="btn btn-ghost files-sync" disabled={sync.isPending || stateKey === "unavailable"} onClick={syncNow}>
          <Icon name="i-undo" size={13} />
          {sync.isPending || stateKey === "syncing" ? t("files.syncing") : t("files.sync")}
        </button>
        <Menu
          label={t("files.actions")}
          align="end"
          trigger={
            <button type="button" className="btn btn-icon files-actions" aria-label={t("files.actions")} title={t("files.actions")}>
              <Icon name="i-bars" size={15} />
            </button>
          }
        >
          <MenuActionItem icon={<Icon name="i-upload" size={13} />} name={t("files.addFiles")} onSelect={() => void addFiles()} />
          <MenuActionItem icon={<Icon name="i-plus" size={13} />} name={t("files.newFolder")} onSelect={() => setNewFolder(true)} />
          {!isDir && <MenuActionItem icon={<Icon name="i-tag" size={13} />} name={t("files.attachToTicket")} onSelect={() => setAttaching(true)} />}
          {path && <MenuActionItem icon={<Icon name="i-pen" size={13} />} name={t("files.rename")} onSelect={() => setRenaming(true)} />}
          {absPath && <MenuActionItem icon={<Icon name="i-folder" size={13} />} name={t("files.reveal")} onSelect={() => reveal(absPath)} />}
          <MenuActionItem icon={<Icon name="i-plug" size={13} />} name={t("files.sharing")} onSelect={onOpenSharing} />
          {path && <MenuActionItem icon={<Icon name="i-trash" size={13} />} name={t("files.delete")} onSelect={() => setDeleting(true)} />}
        </Menu>
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
      {renaming && <NamePrompt initial={nameOf(path)} ariaLabel={t("files.renameAria")} busy={busy} onCommit={rename} onCancel={() => setRenaming(false)} />}
      {newFolder && <NamePrompt ariaLabel={t("files.newFolderNameAria")} placeholder={t("files.folderNamePlaceholder")} busy={busy} onCommit={createFolder} onCancel={() => setNewFolder(false)} />}
      {deleting && (
        <div className="dangerbar files-delete" role="alertdialog">
          <Icon className="b-mark" name="i-warn" size={15} />
          <p style={{ flex: 1, fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>{t("files.deleteConfirm", { name: nameOf(path) })}</p>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={del}>
            {t("files.deleteYes")}
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setDeleting(false)}>
            {t("files.cancel")}
          </button>
        </div>
      )}

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
          <FolderView projectId={projectId} path={path} entries={entries} conflicts={conflicts.data ?? []} status={status.data} state={state} onOpenSharing={onOpenSharing} onAddFiles={() => void addFiles()} />
        ) : (
          <FileView projectId={projectId} path={path} conflict={conflicts.data?.find((c) => c.path === path) ?? null} />
        )}
      </div>
      {attaching && !isDir && <AttachToTicketDialog projectId={projectId} path={path} open={attaching} onOpenChange={setAttaching} />}
    </section>
  );
}
