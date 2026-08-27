import type { Item } from "@tomrade/core";
import { Icon } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Num, Tag } from "~/components/ui/atoms";
import { usePurgeItem } from "~/lib/queries";
import { useToast } from "~/lib/toast";

/** The plain-English list of what goes with the issue, and what does not. */
function consequences(item: Item, items: Item[]): string[] {
  const out = ["its whole activity trail — every oplog row this issue ever wrote"];
  if (item.labels.length) out.push(`${item.labels.length} label link${item.labels.length === 1 ? "" : "s"}`);

  const blockedBy = items.filter((i) => i.id !== item.id && i.blocks.includes(item.id)).length;
  const edges = item.blocks.length + blockedBy;
  if (edges) out.push(`${edges} blocks relation${edges === 1 ? "" : "s"}, cut in both directions`);

  out.push("its place in every saved view's manual order");
  return out;
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
  const purge = usePurgeItem(projectId);
  const toast = useToast();

  // Any issue can be a parent — `parent_id` carries no kind constraint, and an
  // agent may set it over MCP — so this never asks whether the target is an epic.
  const children = item ? items.filter((i) => i.parentId === item.id) : [];
  const lost = item ? consequences(item, items) : [];

  const destroy = () => {
    if (!item) return;
    purge.mutate(
      { id: item.id, baseVersion: item.version },
      {
        // No `onUndo` here, ever. A toast that offers an undo the write path
        // cannot honour is worse than no toast at all.
        onSuccess: () => {
          onOpenChange(false);
          onDeleted?.();
          toast({ body: <>Permanently deleted <span className="num">{item.key}</span> — <span className="num">⌘Z</span> cannot bring it back</> });
        },
        onError: (err) =>
          toast({
            body: /conflict/i.test(err.message) ? (
              <>
                An agent rewrote <span className="num">{item.key}</span> while this was open — it re-read, so check it still deserves deleting.
              </>
            ) : (
              err.message
            )
          })
      }
    );
  };

  // `open`, not a `null` return: the shared Dialog hands focus back to whatever
  // opened it on the open → false transition, and a sheet that closes by
  // unmounting never gives it one. Radix cannot cover for that either — these
  // dialogs render no Trigger for its own restore to aim at.
  return (
    <Dialog open={!!item} onOpenChange={onOpenChange} label={item ? `Delete ${item.key} permanently` : "Delete issue"} className="sheet-md">
      {item && (
        <>
          <DialogHead title="Delete permanently" aside={<Tag tone="neutral">{item.key}</Tag>} />
          <DialogBody className="stack-4">
            <p className="dlg-sub">{item.title}</p>

            <div className="dangerbar">
              <Icon className="b-mark" name="i-warn" size={15} />
              <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>
                This is <strong>not undoable</strong>. Every other write in Tomrade can be walked back with <span className="num">⌘Z</span>, because
                the oplog keeps a snapshot — this one deletes that history too, so there is nothing left to restore from.
              </p>
            </div>

            <div>
              <p className="meta-txt dense">Deleting <Num>{item.key}</Num> also takes:</p>
              <ul className="del-list">
                {lost.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>

            {children.length > 0 && (
              <p className="meta-txt dense">
                <Num>{children.length}</Num> issue{children.length === 1 ? "" : "s"} sit{children.length === 1 ? "s" : ""} under it.{" "}
                {children.length === 1 ? "It is" : "They are"} released to “No epic”, not deleted — and that reparenting is not undoable either.
              </p>
            )}

            <p className="meta-txt dense">
              The key <Num>{item.key}</Num> is retired with it — the project counter never rewinds, so nothing is ever handed that number again.
            </p>
          </DialogBody>
          <DialogFoot>
            {/* Cancel takes the focus: Enter on an irreversible sheet must not destroy. */}
            <button type="button" autoFocus className="btn btn-secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" disabled={purge.isPending} onClick={destroy}>
              <Icon name="i-trash" size={13} />
              {purge.isPending ? "Deleting…" : `Delete ${item.key} for ever`}
            </button>
          </DialogFoot>
        </>
      )}
    </Dialog>
  );
}
