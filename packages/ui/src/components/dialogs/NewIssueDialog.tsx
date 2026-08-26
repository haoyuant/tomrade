import { useEffect, useState } from "react";
import type { ItemStatus, Priority } from "@tomrade/core";
import { Dialog, DialogClose } from "~/components/ui/dialog";
import { PRIORITIES, PRIORITY_LABEL, STATUS, STATUS_KEYS } from "~/lib/domain";
import { useCreateItem, useUndo } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { useWorkspace } from "~/components/workspace/context";

export function NewIssueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const create = useCreateItem(ws.project.id);
  const undo = useUndo(ws.project.id);
  const toast = useToast();

  // An issue belongs to exactly one board, so a cross-board space has to ask.
  const workstreams = ws.boards.filter((b) => !b.across);
  const [title, setTitle] = useState("");
  const [boardId, setBoardId] = useState(ws.board.across ? (workstreams[0]?.id ?? "") : ws.board.id);
  const [status, setStatus] = useState<ItemStatus>((ws.query.group === "status" ? ws.query.columns[0] : "todo") as ItemStatus);
  // whatever the query bar is filtering on becomes the default, so the issue you just made is still on screen
  const [priority, setPriority] = useState<Priority>(ws.query.priorities.length ? (Math.max(...ws.query.priorities) as Priority) : 2);
  const [parentId, setParentId] = useState(ws.query.epics.find((e) => e !== "none") ?? "");

  const statusOptions = ws.query.group === "status" ? (ws.query.columns as ItemStatus[]) : STATUS_KEYS;

  // The sheet outlives its own open/close, so it reseeds from whatever the board
  // is showing now rather than from whatever it showed when the workspace mounted.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setBoardId(ws.board.across ? (workstreams[0]?.id ?? "") : ws.board.id);
    setStatus((ws.query.group === "status" ? ws.query.columns[0] : "todo") as ItemStatus);
    setPriority(ws.query.priorities.length ? (Math.max(...ws.query.priorities) as Priority) : 2);
    setParentId(ws.query.epics.find((e) => e !== "none") ?? "");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    create.mutate(
      { title: trimmed, boardId, status, priority, parentId: parentId || null, labels: ws.query.labels.slice(0, 1) },
      {
        onSuccess: (item) => {
          onOpenChange(false);
          setTitle("");
          toast({ body: <>Created <span className="num">{item.key}</span></>, onUndo: () => undo.mutate(item.id) });
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label="New issue" className="sheet-md">
      <div style={{ padding: "var(--space-4)", borderBottom: "1px solid var(--border)" }}>
        <h2 className="dlg-title">New issue</h2>
      </div>
      <div style={{ padding: "var(--space-4)" }} className="stack-3">
        <div className="field">
          <label htmlFor="niTitle">Title</label>
          <input
            id="niTitle"
            autoFocus
            className="input"
            placeholder="Something sized for one PR…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="niStatus">Status</label>
            <select id="niStatus" className="select" value={status} onChange={(e) => setStatus(e.target.value as ItemStatus)}>
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {STATUS[s].label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="niPrio">Priority</label>
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
            <label htmlFor="niBoard">Board</label>
            <select id="niBoard" className="select" value={boardId} onChange={(e) => setBoardId(e.target.value)}>
              {workstreams.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="niEpic">Parent epic</label>
            <select id="niEpic" className="select" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">None</option>
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
              Cancel
            </button>
          </DialogClose>
          <button type="button" className="btn btn-primary" onClick={submit}>
            Create issue
          </button>
        </div>
      </div>
    </Dialog>
  );
}
