import { useState, type DragEvent, type ReactNode } from "react";
import type { ConflictChoice, FileConflict, FileEntry, FilesStatus } from "@tomradex/files";
import { Icon } from "~/components/icons";
import { SyncContextActions, SyncMark, SyncScopeSummary, SyncSelect, type SyncActions } from "./SyncPolicy";
import { AgentContextActions, AgentMark, AgentSelect, type AgentActions } from "./AgentPolicy";
import { Tag } from "~/components/ui/atoms";
import { ContextMenu, ContextMenuActionItem } from "~/components/ui/menu";
import { useWorkspace } from "~/components/workspace/context";
import { agoLabel } from "~/lib/domain";
import { FILES_DRAG_MIME, formatSize, parentOf, useResolveAllConflicts, type FilesClipboardEntry } from "~/lib/files";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { errorSpec, useToast } from "~/lib/toast";
import type { StateView } from "./state";

const KIND: Record<FileConflict["kind"], MessageKey> = {
  content: "files.kindContent",
  "add-add": "files.kindAddAdd",
  "modify-delete": "files.kindModifyDelete",
  "delete-modify": "files.kindDeleteModify"
};

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
  // every file at once, and synced straight away: said out loud before it happens
  const [confirming, setConfirming] = useState<ConflictChoice | null>(null);
  const all = (choice: ConflictChoice) => resolveAll.mutate(choice, { onSuccess: () => setConfirming(null), onError: (error) => toast(errorSpec(error)) });
  return (
    <div className="stack-3 files-conflict-list" data-testid="conflict-list">
      <div className="dangerbar">
        <Icon className="b-mark" name="i-warn" size={15} />
        <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>{conflicts.length === 1 ? t("files.conflictOne") : t("files.conflictMany", { n: conflicts.length })}</p>
        <button type="button" className="btn btn-ghost" disabled={resolveAll.isPending} aria-expanded={confirming === "ours"} onClick={() => setConfirming("ours")}>
          {t("files.keepAllMine")}
        </button>
        <button type="button" className="btn btn-ghost" disabled={resolveAll.isPending} aria-expanded={confirming === "theirs"} onClick={() => setConfirming("theirs")}>
          {t("files.keepAllTheirs")}
        </button>
      </div>
      {confirming && (
        <div className="row files-conflict-confirm" role="alert" style={{ gap: "var(--space-2)", flexWrap: "wrap" }}>
          <p className="meta-txt" style={{ margin: 0, flex: 1 }}>{t(confirming === "ours" ? "files.keepAllMineConfirm" : "files.keepAllTheirsConfirm", { n: conflicts.length })}</p>
          <button type="button" className="btn btn-danger" disabled={resolveAll.isPending} onClick={() => all(confirming)}>
            {t(confirming === "ours" ? "files.keepAllMine" : "files.keepAllTheirs")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>
            {t("common.cancel")}
          </button>
        </div>
      )}
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
function SelectionBar({ count, sync, listing, onCut, onCopy, onDelete, onClear }: { count: number; sync: ReactNode; listing: ReactNode; onCut: () => void; onCopy: () => void; onDelete: () => void; onClear: () => void }) {
  const { t } = useI18n();
  return (
    <div className="lockbar files-selection-bar" role="toolbar" data-testid="files-selection-bar">
      <span className="selection-count">{t("files.selectionCount", { n: count })}</span>
      {sync}
      {listing}
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

export function FolderView({
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
  syncActions,
  agentActions
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
  agentActions: AgentActions;
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
          listing={<AgentSelect actions={agentActions} paths={[...selected]} value="" label={t("files.agentFor", { name: t("files.selectionCount", { n: selected.size }) })} />}
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
                        <AgentMark listing={e.listing} />
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
                <AgentContextActions actions={agentActions} paths={targetsFor(e.path)} entry={e} />
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
