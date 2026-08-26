import { useEffect, useState } from "react";
import type { Priority } from "@tomrade/core";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Eyebrow, Tag } from "~/components/ui/atoms";
import { GROUPS, PRIORITIES, STATUS_KEYS, columnKeyOf, columnLabel, filterFromQuery } from "~/lib/domain";
import { useUpdateView } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { useWorkspace } from "~/components/workspace/context";

/** Edits the columns of what is on screen — the live query — so it can never
 *  disagree with the board behind it. */
export function ViewSettingsDialog({
  open,
  onOpenChange,
  onOpenBoardSettings
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenBoardSettings: () => void;
}) {
  const ws = useWorkspace();
  const updateView = useUpdateView(ws.project.id);
  const toast = useToast();
  const [name, setName] = useState(ws.view.name);
  const [columns, setColumns] = useState(ws.query.columns);
  const [wip, setWip] = useState(ws.query.wip);

  useEffect(() => {
    if (!open) return;
    setName(ws.view.name);
    setColumns(ws.query.columns);
    setWip(ws.query.wip);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const space =
    ws.query.group === "priority"
      ? [...PRIORITIES].reverse().map(String)
      : ws.query.group === "epic"
        ? [...ws.epics.map((e) => e.id), "none"]
        : STATUS_KEYS;

  const toggle = (key: string) =>
    setColumns((cols) => (cols.includes(key) ? cols.filter((c) => c !== key) : [...cols, key]).sort((a, b) => space.indexOf(a) - space.indexOf(b)));

  const save = () => {
    if (!columns.length) return;
    const patch = { name: name.trim() || ws.view.name, groupBy: ws.query.group, columns, wip, filter: filterFromQuery(ws.query) };
    updateView.mutate({ id: ws.view.id, patch });
    ws.setQuery({ ...ws.query, columns, wip });
    onOpenChange(false);
    toast({ body: <>Saved <span className="num">{patch.name}</span></> });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label="View settings" className="sheet-view">
      <DialogHead title="View settings" aside={<Tag tone="neutral">{ws.board.name}</Tag>} />
      <DialogBody className="stack-4">
        <div className="field">
          <label htmlFor="vsName">View name</label>
          <input id="vsName" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Eyebrow>
            Columns
            <span className="meta-txt" style={{ textTransform: "none", letterSpacing: 0, marginLeft: 6 }}>
              · grouped by {GROUPS[ws.query.group].label.toLowerCase()}
            </span>
          </Eyebrow>
          <div style={{ marginTop: "var(--space-2)" }}>
            {space.map((key) => {
              const on = columns.includes(key);
              const label = columnLabel(key, ws.query.group, ws.epicNames);
              const count = ws.owned.filter((i) => columnKeyOf(i, ws.query.group) === key).length;
              return (
                <div className={`cfg-row${on ? "" : " off"}`} key={key}>
                  <span className="cfg-name">{label}</span>
                  <span className="meta-txt num">{count}</span>
                  {ws.query.group === "status" && (
                    <label className="meta-txt" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      WIP
                      <input
                        className="wip-in"
                        type="number"
                        min={0}
                        placeholder="—"
                        aria-label={`WIP limit for ${label}`}
                        value={wip[key] ?? ""}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10);
                          setWip((current) => {
                            const next = { ...current };
                            if (Number.isNaN(value)) delete next[key];
                            else next[key] = value;
                            return next;
                          });
                        }}
                      />
                    </label>
                  )}
                  <button type="button" className="switch" role="switch" aria-checked={on} aria-label={`Show ${label}`} onClick={() => toggle(key)} />
                </div>
              );
            })}
          </div>
          <p className="meta-txt" style={{ marginTop: "var(--space-2)", color: columns.length ? undefined : "var(--warn)" }}>
            {columns.length
              ? `${columns.length} column${columns.length > 1 ? "s" : ""} shown · issues in hidden columns keep their ${ws.query.group}`
              : "Every column is off — this view would render blank."}
          </p>
        </div>
        <p className="meta-txt dense">
          Grouping and filters are set on the board itself, in the bar above the columns. Saving here writes the name, the columns and whatever that
          bar is currently showing into this view.
        </p>
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" aria-haspopup="dialog" style={{ marginRight: "auto" }} onClick={onOpenBoardSettings}>
          Board settings →
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
        <button type="button" className="btn btn-secondary" onClick={save}>
          Save view
        </button>
      </DialogFoot>
    </Dialog>
  );
}

export type { Priority };
