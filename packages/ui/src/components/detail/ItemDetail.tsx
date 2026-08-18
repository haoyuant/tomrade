// Item detail/edit modal — the human-owned write surface. Edits apply DIRECTLY as
// human writes (no gate), echoed with the current version; a stale save surfaces
// the conflict. humanLocked is a human-only switch (AI writes are refused on it).

import { useState } from "react";
import { cn } from "~/lib/utils";
import { Badge } from "~/components/ui/Badge";
import { BTN, INPUT, PROVENANCE, TYPE_COLORS, WORKFLOW_STATUS } from "~/lib/design-system";
import { provenanceOf, useDeleteItem, usePatchItem } from "~/lib/queries";
import type { Item, ItemKind, ItemStatus } from "@tomrade/core";

const KIND_OPTIONS: ItemKind[] = ["ticket", "epic"];
const STATUS_OPTIONS: ItemStatus[] = ["backlog", "todo", "doing", "verifying", "done", "cancelled"];

export function ItemDetail({ item, onClose }: { item: Item; onClose: () => void }) {
  const patch = usePatchItem();
  const remove = useDeleteItem();
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body ?? "");
  const [status, setStatus] = useState<ItemStatus>(item.status);
  const [kind, setKind] = useState<ItemKind>(item.kind);
  const [message, setMessage] = useState<string | null>(null);

  const save = () => {
    patch.mutate(
      { id: item.id, patch: { title, body: body || null, status, kind }, baseVersion: item.version },
      {
        onSuccess: () => setMessage("Saved ✓"),
        onError: (e) => setMessage(e instanceof Error ? e.message : String(e))
      }
    );
  };

  const toggleLock = () => {
    patch.mutate(
      { id: item.id, patch: { humanLocked: !item.humanLocked }, baseVersion: item.version },
      {
        onSuccess: onClose,
        onError: (e) => setMessage(e instanceof Error ? e.message : String(e))
      }
    );
  };

  const prov = PROVENANCE[provenanceOf(item)];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 px-5 py-3">
          <span className={cn("text-[10px] font-semibold uppercase", TYPE_COLORS[kind]?.color)}>
            {TYPE_COLORS[kind]?.label}
          </span>
          <Badge className={prov.badge}>{prov.label === "Locked" ? "🔒 " : ""}{prov.label}</Badge>
          <span className="text-xs text-slate-500">
            v{item.version} · {item.updatedBy} · #{item.id.slice(0, 8)}
          </span>
          <button type="button" onClick={onClose} className="ml-auto text-slate-500 dark:text-slate-400 hover:text-slate-200">✕</button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto p-5">
          <input
            className={INPUT}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
          />
          <textarea
            className={cn(INPUT, "min-h-40 resize-y font-mono text-xs")}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Body (markdown)"
          />
          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
              Status
              <select className={INPUT} value={status} onChange={(e) => setStatus(e.target.value as ItemStatus)}>
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{WORKFLOW_STATUS[s]?.label ?? s}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
              Kind
              <select className={INPUT} value={kind} onChange={(e) => setKind(e.target.value as ItemKind)}>
                {KIND_OPTIONS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-slate-200 dark:border-slate-800 px-5 py-3">
          {message && <span className="text-xs text-slate-500 dark:text-slate-400">{message}</span>}
          <button type="button" className={cn(BTN.secondary, "ml-auto")} onClick={toggleLock}>
            {item.humanLocked ? "Unlock (human)" : "Lock (human)"}
          </button>
          <button
            type="button"
            className={BTN.danger}
            onClick={() => { if (window.confirm("Delete this item?")) remove.mutate(item.id, { onSuccess: onClose }); }}
          >
            Delete
          </button>
          <button type="button" className={BTN.primary} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
