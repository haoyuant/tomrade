import { useEffect, useState } from "react";
import type { ItemStatus, Priority } from "@tomrade/domain";
import { Dialog, DialogClose } from "~/components/ui/dialog";
import { PRIORITIES, PRIORITY_LABEL, STATUS, STATUS_KEYS } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useCreateItem, useUndo } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { useWorkspace } from "~/components/workspace/context";

export function NewIssueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tx } = useI18n();
  const ws = useWorkspace();
  const create = useCreateItem(ws.project.id);
  const undo = useUndo(ws.project.id);
  const toast = useToast();

  // Whatever the view is filtering on becomes the default, so the issue you just made is still on screen.
  const pinned = (fieldId: string): string[] =>
    ws.query.filter.filter((c) => c.field === fieldId && c.op === "in").flatMap((c) => c.values.filter((v): v is string | number => v !== null).map(String));
  const columnStatuses = (ws.query.columnBy ?? "status") === "status" ? (ws.columnKeys as ItemStatus[]) : STATUS_KEYS;
  const defaults = () => ({
    boardId: pinned("board")[0] ?? ws.boards[0]?.id ?? "",
    status: (pinned("status")[0] ?? (columnStatuses.includes("todo") ? "todo" : columnStatuses[0]) ?? "todo") as ItemStatus,
    priority: (pinned("priority").length ? Math.max(...pinned("priority").map(Number)) : 2) as Priority,
    parentId: pinned("epic")[0] ?? ""
  });
  const workstreams = ws.boards;
  const [title, setTitle] = useState("");
  const [boardId, setBoardId] = useState(defaults().boardId);
  const [status, setStatus] = useState<ItemStatus>(defaults().status);
  const [priority, setPriority] = useState<Priority>(defaults().priority);
  const [parentId, setParentId] = useState(defaults().parentId);

  const statusOptions = columnStatuses;

  // The sheet outlives its own open/close, so it reseeds from whatever the view
  // is showing now rather than from whatever it showed when the workspace mounted.
  useEffect(() => {
    if (!open) return;
    const d = defaults();
    setTitle("");
    setBoardId(d.boardId);
    setStatus(d.status);
    setPriority(d.priority);
    setParentId(d.parentId);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    create.mutate(
      { title: trimmed, boardId, status, priority, parentId: parentId || null, labels: pinned("labels").slice(0, 1) },
      {
        onSuccess: (item) => {
          onOpenChange(false);
          setTitle("");
          toast({ body: <>{tx("newIssueDialog.createdToast", { key: <span className="num">{item.key}</span> })}</>, onUndo: () => undo.mutate(item.id) });
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("newIssueDialog.dialogLabel")} className="sheet-md">
      <div style={{ padding: "var(--space-4)", borderBottom: "1px solid var(--border)" }}>
        <h2 className="dlg-title">{t("newIssueDialog.title")}</h2>
      </div>
      <div style={{ padding: "var(--space-4)" }} className="stack-3">
        <div className="field">
          <label htmlFor="niTitle">{t("newIssueDialog.titleFieldLabel")}</label>
          <input
            id="niTitle"
            autoFocus
            className="input"
            placeholder={t("newIssueDialog.titlePlaceholder")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="niStatus">{t("newIssueDialog.statusLabel")}</label>
            <select id="niStatus" className="select" value={status} onChange={(e) => setStatus(e.target.value as ItemStatus)}>
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {STATUS[s].label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="niPrio">{t("newIssueDialog.priorityLabel")}</label>
            <select id="niPrio" className="select" value={priority} onChange={(e) => setPriority(Number(e.target.value) as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="niBoard">{t("newIssueDialog.boardLabel")}</label>
            <select id="niBoard" className="select" value={boardId} onChange={(e) => setBoardId(e.target.value)}>
              {workstreams.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="niEpic">{t("newIssueDialog.parentEpicLabel")}</label>
            <select id="niEpic" className="select" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">{t("newIssueDialog.noneOption")}</option>
              {ws.epics.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: "var(--space-2)" }}>
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost">
              {t("newIssueDialog.cancel")}
            </button>
          </DialogClose>
          <button type="button" className="btn btn-primary" onClick={submit}>
            {t("newIssueDialog.createIssue")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
