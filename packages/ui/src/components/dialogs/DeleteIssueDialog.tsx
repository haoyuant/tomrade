import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { linkedFileIds, type Item } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Num, Tag } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { filesKeys } from "~/lib/files";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { usePurgeItem } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";
import { keyLabel } from "~/lib/keybindings";

/** The plain-English list of what goes with the issue, and what does not. */
function consequences(item: Item, items: Item[], t: (key: MessageKey, vars?: Record<string, string | number>) => string): string[] {
  const out = [t("deleteIssueDialog.activityTrail")];
  if (item.labels.length) out.push(t(item.labels.length === 1 ? "deleteIssueDialog.labelLinkOne" : "deleteIssueDialog.labelLinkMany", { n: item.labels.length }));

  const blockedBy = items.filter((i) => i.id !== item.id && i.blocks.includes(item.id)).length;
  const edges = item.blocks.length + blockedBy;
  if (edges) out.push(t(edges === 1 ? "deleteIssueDialog.blocksRelationOne" : "deleteIssueDialog.blocksRelationMany", { n: edges }));

  out.push(t("deleteIssueDialog.manualOrder"));
  return out;
}

/**
 * The ticket's attachment folders that hold anything: its workstream's
 * `attachments/<KEY>/`, and the one its links point into if it changed
 * workstream since.
 */
async function attachmentFolders(projectId: string, item: Item): Promise<{ path: string; files: number }[]> {
  const folders = new Set<string>();
  const tail = `/attachments/${item.key}`;
  const home = await invoke("files.folderFor", projectId, item.id).catch(() => null);
  if (home) folders.add(`${home}${tail}`);
  for (const fileId of linkedFileIds(item.body)) {
    const at = await invoke("files.locate", projectId, fileId).catch(() => null);
    const dir = at?.slice(0, at.lastIndexOf("/"));
    if (dir?.endsWith(tail)) folders.add(dir);
  }
  const found = await Promise.all(
    [...folders].map(async (path) => ({ path, files: (await invoke("files.list", projectId, path).catch(() => [])).filter((e) => e.kind === "file").length }))
  );
  return found.filter((f) => f.files > 0);
}

/**
 * The one irreversible write in the app, so it is the one write that asks first.
 *
 * Everything else in Tomrade is undoable — that is the point of the oplog — and
 * this is deliberately not: the purge takes the issue's history with it, so no
 * snapshot is left anywhere for `⌘Z` to restore from. The sheet says so in the
 * words the user will judge it by, and Cancel holds the focus, not the button
 * that destroys.
 *
 * The confirmation asserts the version it was rendered from. An agent sharing
 * this repository can rewrite the issue while the sheet is open, and a promise
 * about a title the human never read is not a confirmation.
 */
export function DeleteIssueDialog({
  item,
  items,
  projectId,
  onOpenChange,
  onDeleted
}: {
  /** The issue to destroy; `null` closes the sheet. */
  item: Item | null;
  /** The project's issues — incoming `blocks` edges live on the other row. */
  items: Item[];
  projectId: string;
  onOpenChange: (open: boolean) => void;
  /** Ran after the purge lands: drop the selection, or leave a dead route. */
  onDeleted?: () => void;
}) {
  const { t, tx } = useI18n();
  const purge = usePurgeItem(projectId);
  const toast = useToast();

  // Any issue can be a parent — `parent_id` carries no kind constraint, and an
  // agent may set it over MCP — so this never asks whether the target is an epic.
  const children = item ? items.filter((i) => i.parentId === item.id) : [];
  const lost = item ? consequences(item, items, t) : [];
  // Files keeps its own history, so these are offered rather than taken: left alone unless ticked.
  const attachments = useQuery({
    queryKey: [...filesKeys.all(projectId), "attachmentsOf", item?.id ?? ""],
    queryFn: () => attachmentFolders(projectId, item!),
    enabled: !!item,
    retry: false
  });
  const [alsoFiles, setAlsoFiles] = useState(false);
  useEffect(() => setAlsoFiles(false), [item?.id]);
  const folders = attachments.data ?? [];

  const destroy = () => {
    if (!item) return;
    purge.mutate(
      { id: item.id, baseVersion: item.version },
      {
        // No `onUndo` here, ever. A toast that offers an undo the write path
        // cannot honour is worse than no toast at all.
        onSuccess: () => {
          if (alsoFiles) {
            for (const folder of folders) void invoke("files.remove", projectId, folder.path).catch((err: Error) => toast(errorSpec(err)));
          }
          onOpenChange(false);
          onDeleted?.();
          toast({ body: <>{tx("deleteIssueDialog.deletedToast", { key: <span className="num">{item.key}</span>, cmdz: <span className="num">{keyLabel("undo")}</span> })}</> });
        },
        onError: (err) =>
          toast({
            body: /conflict/i.test(err.message) ? tx("deleteIssueDialog.conflictToast", { key: <span className="num">{item.key}</span> }) : err.message
          })
      }
    );
  };

  // `open`, not a `null` return: the shared Dialog hands focus back to whatever
  // opened it on the open → false transition, and a sheet that closes by
  // unmounting never gives it one. Radix cannot cover for that either — these
  // dialogs render no Trigger for its own restore to aim at.
  return (
    <Dialog
      open={!!item}
      onOpenChange={onOpenChange}
      label={item ? t("deleteIssueDialog.dialogLabelWithKey", { key: item.key }) : t("deleteIssueDialog.dialogLabelEmpty")}
      className="sheet-md"
    >
      {item && (
        <>
          <DialogHead title={t("deleteIssueDialog.headTitle")} aside={<Tag tone="neutral">{item.key}</Tag>} />
          <DialogBody className="stack-4">
            <p className="dlg-sub">{item.title}</p>

            <div className="dangerbar">
              <Icon className="b-mark" name="i-warn" size={15} />
              <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>
                {tx("deleteIssueDialog.notUndoable", {
                  strong: <strong>{t("deleteIssueDialog.notUndoableStrong")}</strong>,
                  cmdz: <span className="num">{keyLabel("undo")}</span>
                })}
              </p>
            </div>

            <div>
              <p className="meta-txt dense">{tx("deleteIssueDialog.alsoTakes", { key: <Num>{item.key}</Num> })}</p>
              <ul className="del-list">
                {lost.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>

            {children.length > 0 && (
              <p className="meta-txt dense">
                {tx(children.length === 1 ? "deleteIssueDialog.childrenNoteOne" : "deleteIssueDialog.childrenNoteMany", {
                  n: <Num>{children.length}</Num>
                })}
              </p>
            )}

            <p className="meta-txt dense">{tx("deleteIssueDialog.keyRetired", { key: <Num>{item.key}</Num> })}</p>

            {folders.length > 0 && (
              <label className="cfg-row del-attachments" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={alsoFiles} onChange={(e) => setAlsoFiles(e.target.checked)} />
                <span className="cfg-name">
                  {t("deleteIssueDialog.alsoDeleteAttachments", { n: folders.reduce((sum, f) => sum + f.files, 0) })}
                </span>
                <span className="meta-txt num" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }} title={folders.map((f) => f.path).join("\n")}>
                  {folders.map((f) => `${f.path}/`).join(", ")}
                </span>
              </label>
            )}
          </DialogBody>
          <DialogFoot>
            {/* Cancel takes the focus: Enter on an irreversible sheet must not destroy. */}
            <button type="button" autoFocus className="btn btn-secondary" onClick={() => onOpenChange(false)}>
              {t("deleteIssueDialog.cancel")}
            </button>
            <button type="button" className="btn btn-danger" disabled={purge.isPending} onClick={destroy}>
              <Icon name="i-trash" size={13} />
              {purge.isPending ? t("deleteIssueDialog.deleting") : t("deleteIssueDialog.deleteForever", { key: item.key })}
            </button>
          </DialogFoot>
        </>
      )}
    </Dialog>
  );
}
