import { useEffect, useState } from "react";
import { EMPTY_KEY, LAYOUTS, groupKeyOf, type Layout } from "@tomradex/domain";
import { Icon, type IconId } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { IconPicker } from "~/components/ui/icon-picker";
import { Eyebrow, Tag } from "~/components/ui/atoms";
import { BOARD_GLYPHS, DEFAULT_SHOWN_FIELDS, LAYOUT_LABEL, fieldLabel, viewIcon } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useGraphs, useUpdateView } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { useWorkspace } from "~/components/workspace/context";

/**
 * The view's configuration: what it is called, how it draws, which fields it
 * shows, and — on a board — which columns and their WIP caps. Saving writes the
 * saved view directly; the live draft's filter, grouping and sort come along so
 * nothing on screen is lost, and the draft rebinds to what was saved.
 */
export function ViewSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tx } = useI18n();
  const ws = useWorkspace();
  const update = useUpdateView(ws.project.id);
  const graphs = useGraphs();
  const toast = useToast();
  const [name, setName] = useState(ws.view.name);
  const [icon, setIcon] = useState<IconId>(viewIcon(ws.view.icon));
  const [layout, setLayout] = useState<Layout>(ws.layout);
  const [fields, setFields] = useState<string[]>(ws.query.fields);
  const [columns, setColumns] = useState<string[]>(ws.query.columns);
  const [wip, setWip] = useState<Record<string, number>>(ws.query.wip);
  const [graph, setGraph] = useState<string | null>(ws.query.graph);

  useEffect(() => {
    if (!open) return;
    setName(ws.view.name);
    setIcon(viewIcon(ws.view.icon));
    setLayout(ws.layout);
    setFields(ws.query.fields);
    setColumns(ws.query.columns);
    setWip(ws.query.wip);
    setGraph(ws.query.graph);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const columnBy = ws.query.columnBy ?? "status";
  const columnDef = ws.fieldById.get(columnBy);
  const space = ws.groupSpace(columnBy);
  const shownColumns = columns.filter((k) => space.includes(k));
  const columnOn = (key: string) => (shownColumns.length ? shownColumns.includes(key) : true);
  const toggleColumn = (key: string) => {
    const current = shownColumns.length ? shownColumns : space;
    const next = current.includes(key) ? current.filter((c) => c !== key) : [...current, key];
    setColumns(next.length === space.length ? [] : next.sort((a, b) => space.indexOf(a) - space.indexOf(b)));
  };

  // An empty list means the layout's default; the first toggle materializes it.
  const shownFields = fields.length ? fields : DEFAULT_SHOWN_FIELDS[layout];
  const toggleField = (id: string) => setFields(shownFields.includes(id) ? shownFields.filter((f) => f !== id) : [...shownFields, id]);
  const graphOptions = graphs.data ?? [];

  const save = () => {
    if (layout === "board" && space.length && shownColumns.length === 0 && columns.length) return;
    const trimmed = name.trim() || ws.view.name;
    update.mutate(
      {
        id: ws.view.id,
        patch: {
          name: trimmed,
          icon,
          layout,
          query: { ...ws.query, fields, columns: layout === "board" ? columns : ws.query.columns, wip: layout === "board" ? wip : ws.query.wip, graph }
        }
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast({ body: <>{tx("viewSettingsDialog.savedToast", { name: <span className="num">{trimmed}</span> })}</> });
        },
        onError: (err) => toast({ body: err.message })
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("viewSettingsDialog.dialogLabel", { name: ws.view.name })} className="sheet-view">
      <DialogHead title={t("viewSettingsDialog.headTitle")} aside={<Tag tone="neutral">{ws.view.name}</Tag>} />
      <DialogBody className="stack-4">
        <div className="grid-2">
          <div className="field">
            <label htmlFor="vsName">{t("viewSettingsDialog.nameLabel")}</label>
            <input id="vsName" autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="vsIcon">{t("viewSettingsDialog.iconLabel")}</label>
            <IconPicker id="vsIcon" value={icon} onChange={setIcon} ariaLabel={t("viewSettingsDialog.iconLabel")} />
          </div>
        </div>

        <div>
          <Eyebrow>{t("viewSettingsDialog.layoutLabel")}</Eyebrow>
          <div className="seg quiet vs-layout" role="group" aria-label={t("viewSettingsDialog.layoutLabel")} style={{ marginTop: "var(--space-2)", display: "inline-flex" }}>
            {LAYOUTS.map((l) => (
              <button key={l} type="button" data-layout={l} aria-pressed={layout === l} onClick={() => setLayout(l)}>
                <Icon className="ico" name={LAYOUT_LABEL[l].icon} size={13} />
                <span className="seg-lbl">{LAYOUT_LABEL[l].label}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <Eyebrow>{t("viewSettingsDialog.fieldsLabel")}</Eyebrow>
          <p className="meta-txt dense" style={{ margin: "6px 0 var(--space-2)" }}>
            {fields.length ? t("viewSettingsDialog.fieldsCustom", { n: fields.length }) : t("viewSettingsDialog.fieldsDefault")}
          </p>
          <div className="vs-fields">
            {ws.fields
              .filter((f) => f.id !== "title")
              .map((f) => {
                const on = shownFields.includes(f.id);
                return (
                  <div className={`cfg-row${on ? "" : " off"}`} key={f.id} data-field={f.id}>
                    <span className="cfg-name">{fieldLabel(f)}</span>
                    <button type="button" className="switch" role="switch" aria-checked={on} aria-label={t("viewSettingsDialog.showFieldAria", { label: fieldLabel(f) })} onClick={() => toggleField(f.id)} />
                  </div>
                );
              })}
          </div>
        </div>

        {layout === "board" && (
          <div>
            <Eyebrow>
              {t("viewSettingsDialog.columnsLabel")}
              <span className="meta-txt" style={{ textTransform: "none", letterSpacing: 0, marginLeft: 6 }}>
                {t("viewSettingsDialog.columnBySuffix", { field: columnDef ? fieldLabel(columnDef) : columnBy })}
              </span>
            </Eyebrow>
            <div className="vs-columns" style={{ marginTop: "var(--space-2)" }}>
              {space.map((key) => {
                const on = columnOn(key);
                const label = ws.groupLabel(columnBy, key);
                const count = ws.owned.filter((i) => groupKeyOf(i, columnBy) === key).length;
                return (
                  <div className={`cfg-row${on ? "" : " off"}`} key={key} data-column={key}>
                    <span className="cfg-name">{label}</span>
                    <span className="meta-txt num">{count}</span>
                    {key !== EMPTY_KEY && (
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
                    <button type="button" className="switch" role="switch" aria-checked={on} aria-label={t("viewSettingsDialog.showAria", { label })} onClick={() => toggleColumn(key)} />
                  </div>
                );
              })}
            </div>
            <p className="meta-txt" style={{ marginTop: "var(--space-2)", color: shownColumns.length || !columns.length ? undefined : "var(--warn)" }}>
              {shownColumns.length || !columns.length ? t("viewSettingsDialog.columnsShown", { n: shownColumns.length || space.length }) : t("viewSettingsDialog.allColumnsOff")}
            </p>
          </div>
        )}

        {layout === "graph" && (
          <div className="field">
            <label htmlFor="vsGraph">{t("viewSettingsDialog.graphLabel")}</label>
            <select id="vsGraph" className="select" value={graph ?? graphOptions[0]?.id ?? ""} onChange={(e) => setGraph(e.target.value || null)}>
              {graphOptions.length === 0 && <option value="">{t("viewSettingsDialog.noGraphs")}</option>}
              {graphOptions.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
            <span className="meta-txt">{t("viewSettingsDialog.graphNote")}</span>
          </div>
        )}

        <p className="meta-txt dense">{t("viewSettingsDialog.footNote")}</p>
      </DialogBody>
      <DialogFoot>
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
