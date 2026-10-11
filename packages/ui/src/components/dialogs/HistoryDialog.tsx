import type { UndoRecord } from "@tomradex/domain";
import { Icon, type IconId } from "~/components/icons";
import { Dialog, DialogBody, DialogHead } from "~/components/ui/dialog";
import { Kbd, Num } from "~/components/ui/atoms";
import { agoLabel, authorLabel } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useRedo, useRollback, useTimeline, useUndo } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";
import { cn } from "~/lib/utils";

const OP_KEY: Record<string, MessageKey> = {
  create: "history.opCreate",
  update: "history.opUpdate",
  delete: "history.opDelete",
  purge: "history.opPurge",
  rank: "history.opRank",
  merge: "history.opMerge",
  write: "history.opWrite",
  mkdir: "history.opMkdir",
  move: "history.opMove",
  copy: "history.opCopy",
  remove: "history.opRemove",
  import: "history.opImport",
  set: "history.opSet"
};

const ENTITY_ICON: Record<string, IconId> = { item: "i-stack", board: "i-board", view: "i-board", file: "i-file", setting: "i-sliders" };

const iconOf = (r: UndoRecord): IconId => (r.op === "mkdir" ? "i-folder" : (ENTITY_ICON[r.entity] ?? "i-clock"));

/**
 * Every record the project's history holds — backlog writes, file operations
 * and settings an agent changed alike — newest first, with the undone ones greyed. Any row can
 * become "the latest thing done": rolling back undoes everything above a live
 * row, redoing to an undone row replays the stack down to it.
 */
export function HistoryDialog({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tx } = useI18n();
  const toast = useToast();
  const timeline = useTimeline(projectId, open);
  const undo = useUndo(projectId);
  const redo = useRedo(projectId);
  const rollback = useRollback(projectId);
  const records = timeline.data ?? [];
  const latest = records.find((r) => r.undoable && r.undoneAt === null) ?? null;
  const canUndo = latest !== null;
  const canRedo = records.some((r) => r.undoneAt !== null);
  const busy = undo.isPending || redo.isPending || rollback.isPending;

  const report = (error: Error) => toast(errorSpec(error));
  const moveTo = (record: UndoRecord) =>
    rollback.mutate(record.ref, {
      onSuccess: (result) => {
        const n = result.steps.length;
        if (result.stopped) toast({ body: t("history.stopped", { n, reason: result.stopped }) });
        else if (!n) toast({ body: t("history.nothingToDo") });
        else if (n === 1) toast({ body: result.steps[0]!.summary });
        else toast({ body: t(record.undoneAt !== null ? "history.rolledForward" : "history.rolledBack", { n }) });
      },
      onError: report
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("history.title")} className="sheet-history">
      <DialogHead
        title={t("history.title")}
        aside={
          <>
            <button
              type="button"
              className="btn btn-secondary hist-undo"
              disabled={busy || !canUndo}
              onClick={() => undo.mutate(undefined, { onSuccess: (step) => step && toast({ body: step.summary }), onError: report })}
            >
              <Icon name="i-undo" size={13} /> {t("history.undo")} <Kbd>⌘Z</Kbd>
            </button>
            <button
              type="button"
              className="btn btn-secondary hist-redo"
              disabled={busy || !canRedo}
              onClick={() => redo.mutate(undefined, { onSuccess: (step) => step && toast({ body: step.summary }), onError: report })}
            >
              <Icon name="i-redo" size={13} /> {t("history.redo")} <Kbd>⇧⌘Z</Kbd>
            </button>
          </>
        }
      />
      <DialogBody>
        <p className="hist-lede">{t("history.lede")}</p>
        {busy && (
          <p className="meta-txt hist-busy" role="status">
            <Icon name="i-sync" size={12} className="is-spinning" /> {t("history.working")}
          </p>
        )}
        {timeline.isLoading && <p className="meta-txt">{t("history.loading")}</p>}
        {!timeline.isLoading && records.length === 0 && <p className="meta-txt">{t("history.empty")}</p>}
        <div className="hist-list" data-testid="history-list">
          {records.map((r) => {
            const undone = r.undoneAt !== null;
            const isLatest = latest?.ref === r.ref;
            // A live row can be rolled back to while something undoable sits above it.
            const canRollBack = !undone && !isLatest && latest !== null && records.indexOf(latest) < records.indexOf(r);
            const sync = r.by === "ai:sync";
            const elsewhere = !r.undoable && !undone && r.op !== "purge" && r.op !== "merge";
            const target = r.op === "import" && !r.label ? t("history.importRoot") : r.target ?? "";
            return (
              <div key={r.ref} className={cn("hist-row", undone && "is-undone", !r.undoable && "is-fixed")} data-ref={r.ref} data-undone={undone} data-latest={isLatest}>
                <Icon className="hist-ico" name={iconOf(r)} size={14} />
                <div className="hist-main">
                  <span className="hist-text">
                    {tx(OP_KEY[r.op] ?? "history.opOther", { label: <Num>{r.label}</Num>, target: <Num>{target}</Num>, op: r.op })}
                  </span>
                  <span className="meta-txt">
                    {sync ? t("history.sync") : authorLabel(r.by)} · {agoLabel(r.at)}
                    {elsewhere && <> · {t("history.fromElsewhere")}</>}
                  </span>
                </div>
                <span className="hist-state">{isLatest ? t("history.current") : undone ? t("history.undone") : !r.undoable ? t("history.notUndoable") : ""}</span>
                {(undone || canRollBack) && (
                  <button type="button" className="btn btn-ghost hist-act" disabled={busy} onClick={() => moveTo(r)}>
                    <Icon name={undone ? "i-redo" : "i-undo"} size={12} /> {t(undone ? "history.redoToHere" : "history.rollBackHere")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </DialogBody>
    </Dialog>
  );
}
