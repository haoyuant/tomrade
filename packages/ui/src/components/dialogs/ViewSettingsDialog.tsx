import { useEffect, useState } from "react";
import type { Priority } from "@tomrade/domain";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Eyebrow, Tag } from "~/components/ui/atoms";
import { GROUPS, PRIORITIES, STATUS_KEYS, VIEW_KINDS, columnKeyOf, columnLabel, filterFromQuery } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
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
  const { t, tx } = useI18n();
  const ws = useWorkspace();
  const updateView = useUpdateView(ws.project.id);
  const toast = useToast();
  const kindLabel = VIEW_KINDS[ws.view.kind].label;
  const [columns, setColumns] = useState(ws.query.columns);
  const [wip, setWip] = useState(ws.query.wip);

  useEffect(() => {
    if (!open) return;
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
    const patch = { columns, wip, filter: filterFromQuery(ws.query) };
    updateView.mutate({ id: ws.view.id, patch });
    ws.setQuery({ ...ws.query, columns, wip });
    onOpenChange(false);
    toast({ body: <>{tx("viewSettingsDialog.savedToast", { name: <span className="num">{kindLabel}</span> })}</> });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("viewSettingsDialog.dialogLabel", { kind: kindLabel })} className="sheet-view">
      <DialogHead title={t("viewSettingsDialog.dialogLabel", { kind: kindLabel })} aside={<Tag tone="neutral">{ws.board.name}</Tag>} />
      <DialogBody className="stack-4">
        <div>
          <Eyebrow>
            {t("viewSettingsDialog.columnsLabel")}
            <span className="meta-txt" style={{ textTransform: "none", letterSpacing: 0, marginLeft: 6 }}>
              {t("viewSettingsDialog.groupedBySuffix", { group: GROUPS[ws.query.group].label.toLowerCase() })}
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
                      {t("viewSettingsDialog.wipLabel")}
                      <input
                        className="wip-in"
                        type="number"
                        min={0}
                        placeholder="—"
                        aria-label={t("viewSettingsDialog.wipAria", { label })}
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
                  <button
                    type="button"
                    className="switch"
                    role="switch"
                    aria-checked={on}
                    aria-label={t("viewSettingsDialog.showAria", { label })}
                    onClick={() => toggle(key)}
                  />
                </div>
              );
            })}
          </div>
          <p className="meta-txt" style={{ marginTop: "var(--space-2)", color: columns.length ? undefined : "var(--warn)" }}>
            {columns.length
              ? t("viewSettingsDialog.columnsShown", { n: columns.length, group: GROUPS[ws.query.group].label.toLowerCase() })
              : t("viewSettingsDialog.allColumnsOff")}
          </p>
        </div>
        <p className="meta-txt dense">{t("viewSettingsDialog.footNote")}</p>
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" aria-haspopup="dialog" style={{ marginRight: "auto" }} onClick={onOpenBoardSettings}>
          {t("viewSettingsDialog.boardSettings")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
          {t("viewSettingsDialog.cancel")}
        </button>
        <button type="button" className="btn btn-secondary" onClick={save}>
          {t("viewSettingsDialog.saveView")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}

export type { Priority };
