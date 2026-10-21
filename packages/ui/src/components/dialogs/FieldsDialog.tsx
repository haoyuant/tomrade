import { useEffect, useRef, useState } from "react";
import type { FieldDef, FieldType, Item } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead, useOpeningKey } from "~/components/ui/dialog";
import { Eyebrow, FoldChevron, FoldChevronSpace, Tag } from "~/components/ui/atoms";
import { FIELD_TYPE_LABEL, fieldLabel } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import {
  useAddFieldOption,
  useCreateField,
  useFields,
  useItems,
  useRemoveField,
  useRemoveFieldOption,
  useUpdateField,
  useUpdateFieldOption
} from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";
import { InlineEdit } from "~/components/ui/InlineEdit";
import { isCommitKey } from "~/lib/keys";
import { WorkstreamEditor } from "./WorkstreamEditor";

const CUSTOM_TYPES: FieldType[] = ["text", "number", "date", "select", "checkbox"];

const holders = (items: Item[], fieldId: string) => items.filter((i) => fieldId in i.fields).length;

function FieldRow({ def, count, selected, onSelect }: { def: FieldDef; count: number | null; selected?: boolean; onSelect?: () => void }) {
  const { t } = useI18n();
  const body = (
    <>
      <span className="cfg-name">{fieldLabel(def)}</span>
      {count !== null && <span className="meta-txt num">{t(count === 1 ? "fieldsDialog.valuesOne" : "fieldsDialog.valuesMany", { n: count })}</span>}
      <Tag tone={def.builtin ? "faint" : "neutral"}>{FIELD_TYPE_LABEL[def.type]}</Tag>
      {def.builtin && <Icon name="i-lock" size={12} style={{ color: "var(--meta)" }} aria-hidden />}
    </>
  );
  if (!onSelect) return (
    <div className="fold-row">
      <FoldChevronSpace />
      <div className="cfg-row fld-row is-builtin" data-field={def.id}>{body}</div>
    </div>
  );
  return (
    <div className="fold-row">
      <FoldChevron open={!!selected} onToggle={onSelect} />
      <button type="button" className={`cfg-row fld-row${def.builtin ? " is-builtin" : ""}${selected ? " is-selected" : ""}`} data-field={def.id} aria-expanded={selected} onClick={onSelect}>
        {body}
      </button>
    </div>
  );
}

/** The editor for one custom field: rename, options for a select, and the delete behind a second click. */
function FieldEditor({ projectId, def, items, onDeleted }: { projectId: string; def: FieldDef; items: Item[]; onDeleted: () => void }) {
  const { t, tx } = useI18n();
  const toast = useToast();
  const update = useUpdateField(projectId);
  const remove = useRemoveField(projectId);
  const addOption = useAddFieldOption(projectId);
  const updateOption = useUpdateFieldOption(projectId);
  const removeOption = useRemoveFieldOption(projectId);
  const [confirming, setConfirming] = useState(false);
  // An option issues still hold is removed only after saying what becomes of them: "" clears, an id moves them there.
  const [removing, setRemoving] = useState<{ optionId: string; moveTo: string } | null>(null);
  const [newOption, setNewOption] = useState("");
  const count = holders(items, def.id);
  const holding = (optionId: string) => items.filter((i) => i.fields[def.id] === optionId).length;
  const ref = useRef<HTMLDivElement | null>(null);

  // The list above can push the editor below the fold; a selection should be seen.
  useEffect(() => {
    setConfirming(false);
    setRemoving(null);
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [def.id]);

  const fail = (err: Error) => toast(errorSpec(err));

  const dropOption = (optionId: string, moveTo: string) => {
    const name = def.options.find((o) => o.id === optionId)?.name ?? "";
    const target = def.options.find((o) => o.id === moveTo)?.name;
    removeOption.mutate(
      { fieldId: def.id, optionId, ...(target ? { moveTo } : {}) },
      {
        onSuccess: (n) => {
          setRemoving(null);
          toast({
            body: target
              ? tx("fieldsDialog.movedOptionToast", { name: <b>{name}</b>, target: <b>{target}</b>, n: <span className="num">{n}</span> })
              : tx("fieldsDialog.removedOptionToast", { name: <b>{name}</b>, n: <span className="num">{n}</span> })
          });
        },
        onError: fail
      }
    );
  };

  const commitOption = () => {
    const name = newOption.trim();
    if (!name) return;
    addOption.mutate({ fieldId: def.id, input: { name } }, { onSuccess: () => setNewOption(""), onError: fail });
  };

  return (
    <div className="fld-editor stack-3" ref={ref}>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="fldName">{t("fieldsDialog.nameLabel")}</label>
          <InlineEdit
            value={def.name}
            aria-label={t("fieldsDialog.nameLabel")}
            onSave={(name) =>
              update.mutate({ id: def.id, patch: { name } }, { onSuccess: () => toast({ body: tx("fieldsDialog.renamedToast", { name: <b>{name}</b> }) }), onError: fail })
            }
          />
        </div>
        <div className="field">
          <label htmlFor="fldType">{t("fieldsDialog.typeLabel")}</label>
          <input id="fldType" className="input" readOnly value={FIELD_TYPE_LABEL[def.type]} />
        </div>
      </div>

      {def.type === "select" && (
        <div>
          <Eyebrow>{t("fieldsDialog.optionsEyebrow")}</Eyebrow>
          <div className="stack-1" style={{ marginTop: "var(--space-2)" }}>
            {def.options.length === 0 && <p className="meta-txt dense">{t("fieldsDialog.noOptionsYet")}</p>}
            {def.options.map((o) => (
              <div className="fld-opt" key={o.id}>
                <InlineEdit
                  value={o.name}
                  aria-label={t("fieldsDialog.optionNameAria")}
                  className="input fld-opt-name"
                  onSave={(name) => updateOption.mutate({ fieldId: def.id, optionId: o.id, patch: { name } }, { onError: fail })}
                />
                <InlineEdit
                  value={o.description ?? ""}
                  aria-label={t("fieldsDialog.optionDescriptionAria")}
                  className="input fld-opt-desc"
                  placeholder={t("fieldsDialog.optionDescriptionPlaceholder")}
                  onSave={(description) => updateOption.mutate({ fieldId: def.id, optionId: o.id, patch: { description } }, { onError: fail })}
                />
                <button
                  type="button"
                  className="btn btn-icon"
                  title={t("fieldsDialog.removeOptionTitle", { name: o.name })}
                  aria-label={t("fieldsDialog.removeOptionAria", { name: o.name })}
                  aria-expanded={removing?.optionId === o.id}
                  onClick={() => (holding(o.id) === 0 ? dropOption(o.id, "") : setRemoving({ optionId: o.id, moveTo: "" }))}
                >
                  <Icon name="i-close" size={13} />
                </button>
                {removing?.optionId === o.id && (
                  <div className="fld-opt-confirm" role="group" aria-label={t("fieldsDialog.removeOptionAria", { name: o.name })}>
                    <p className="meta-txt dense">{t(holding(o.id) === 1 ? "fieldsDialog.removeOptionHeldOne" : "fieldsDialog.removeOptionHeldMany", { n: holding(o.id), name: o.name })}</p>
                    <div className="row" style={{ gap: "var(--space-2)", flexWrap: "wrap" }}>
                      <select
                        className="input"
                        style={{ width: "auto" }}
                        aria-label={t("fieldsDialog.removeOptionTargetAria", { name: o.name })}
                        value={removing.moveTo}
                        onChange={(e) => setRemoving({ optionId: o.id, moveTo: e.target.value })}
                      >
                        <option value="">{t("fieldsDialog.removeOptionClear")}</option>
                        {def.options
                          .filter((x) => x.id !== o.id)
                          .map((x) => (
                            <option key={x.id} value={x.id}>
                              {t("fieldsDialog.removeOptionMoveTo", { name: x.name })}
                            </option>
                          ))}
                      </select>
                      <button type="button" className="btn btn-danger" disabled={removeOption.isPending} onClick={() => dropOption(o.id, removing.moveTo)}>
                        <Icon name="i-trash" size={13} /> {t("fieldsDialog.confirmRemoveOption", { name: o.name })}
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => setRemoving(null)}>
                        {t("common.cancel")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            <div className="row" style={{ gap: "var(--space-2)" }}>
              <input
                className="input"
                aria-label={t("fieldsDialog.newOptionAria")}
                placeholder={t("fieldsDialog.newOptionPlaceholder")}
                value={newOption}
                onChange={(e) => setNewOption(e.target.value)}
                onKeyDown={(e) => {
                  if (isCommitKey(e)) commitOption();
                }}
              />
              <button type="button" className="btn btn-ghost" disabled={!newOption.trim()} onClick={commitOption}>
                <Icon name="i-plus" size={13} /> {t("fieldsDialog.addOption")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div>
        <Eyebrow style={{ color: "var(--danger)" }}>{t("fieldsDialog.deleteField")}</Eyebrow>
        <p className="meta-txt dense" style={{ margin: "6px 0 var(--space-2)" }}>
          {count === 0 ? t("fieldsDialog.deleteWarningNone") : t(count === 1 ? "fieldsDialog.deleteWarningOne" : "fieldsDialog.deleteWarningMany", { n: count })}
        </p>
        {confirming ? (
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() =>
                remove.mutate(def.id, {
                  onSuccess: () => {
                    toast({ body: tx("fieldsDialog.deletedToast", { name: <b>{def.name}</b> }) });
                    onDeleted();
                  },
                  onError: fail
                })
              }
            >
              <Icon name="i-trash" size={13} /> {t("fieldsDialog.confirmDelete", { name: def.name })}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-ghost is-danger" onClick={() => setConfirming(true)}>
            <Icon name="i-trash" size={13} /> {t("fieldsDialog.deleteField")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The project's field registry. Built-ins are listed so the whole vocabulary a
 * view can use is in one place; only custom fields — and the Workstream
 * field's options — are editable, and every edit lands live: a field is schema,
 * not a draft. Each opening starts clean, on the field it was opened for.
 */
export function FieldsDialog(props: Parameters<typeof FieldsSheet>[0]) {
  return <FieldsSheet key={useOpeningKey(props.open)} {...props} />;
}

function FieldsSheet({
  projectId,
  projectName,
  open,
  onOpenChange,
  initialFieldId = null,
  initialBoardId = null,
  onOpenRepositories
}: {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The field to land on — "board" opens the Workstreams sheet: the workstream editor alone. */
  initialFieldId?: string | null;
  /** With "board": the workstream whose card to land on. */
  initialBoardId?: string | null;
  /** Where "Repositories…" lands: the project's settings, after this sheet has closed. */
  onOpenRepositories?: () => void;
}) {
  const { t, tx } = useI18n();
  const openRepositories = onOpenRepositories
    ? () => {
        onOpenChange(false);
        onOpenRepositories();
      }
    : undefined;
  const toast = useToast();
  const fields = useFields(projectId);
  const items = useItems(projectId);
  const create = useCreateField(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(initialFieldId);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<FieldType>("text");

  const all = fields.data ?? [];
  const builtin = all.filter((f) => f.builtin);
  const custom = all.filter((f) => !f.builtin);
  const selected = custom.find((f) => f.id === selectedId) ?? null;
  const rows = items.data ?? [];

  const submit = () => {
    const name = newName.trim();
    if (!name) return;
    create.mutate(
      { name, type: newType },
      {
        onSuccess: (def) => {
          setNewName("");
          setSelectedId(def.id);
          toast({ body: tx("fieldsDialog.createdToast", { name: <b>{def.name}</b> }) });
        },
        onError: (err) => toast(errorSpec(err))
      }
    );
  };

  // Opened from a workstream: the Workstream field's editor alone, under its own title.
  const boardField = builtin.find((f) => f.id === "board");
  if (initialFieldId === "board") {
    return (
      <Dialog open={open} onOpenChange={onOpenChange} label={t("fieldsDialog.workstreamsTitle")} className="sheet-board">
        <DialogHead title={t("fieldsDialog.workstreamsTitle")} aside={<Tag tone="neutral">{projectName}</Tag>} />
        <DialogBody className="stack-4">
          {boardField && (
            <div className="fld-list">
              <div className="fld-item">
                <FieldRow def={boardField} count={null} />
                <div className="fold-row-body">
                  <WorkstreamEditor projectId={projectId} items={rows} focusBoardId={open ? initialBoardId : null} onOpenRepositories={openRepositories} />
                </div>
              </div>
            </div>
          )}
        </DialogBody>
        <DialogFoot>
          <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
            {t("fieldsDialog.close")}
          </button>
        </DialogFoot>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("fieldsDialog.dialogLabel")} className="sheet-board">
      <DialogHead title={t("fieldsDialog.headTitle")} aside={<Tag tone="neutral">{projectName}</Tag>} />
      <DialogBody className="stack-4">
        <div>
          <Eyebrow>{t("fieldsDialog.builtinEyebrow")}</Eyebrow>
          <div className="fld-list" style={{ marginTop: "var(--space-2)" }}>
            {builtin.map((f) =>
              f.id === "board" ? (
                <div key={f.id} className="fld-item">
                  <FieldRow def={f} count={null} selected={selectedId === f.id} onSelect={() => setSelectedId(selectedId === f.id ? null : f.id)} />
                  {selectedId === f.id && <div className="fold-row-body"><WorkstreamEditor projectId={projectId} items={rows} focusBoardId={open ? initialBoardId : null} onOpenRepositories={openRepositories} /></div>}
                </div>
              ) : (
                <FieldRow key={f.id} def={f} count={null} />
              )
            )}
          </div>
          {selectedId !== "board" && (
            <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
              {t("fieldsDialog.builtinNote")}
            </p>
          )}
        </div>

        <div>
          <Eyebrow>{t("fieldsDialog.customEyebrow")}</Eyebrow>
          {custom.length === 0 ? (
            <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
              {t("fieldsDialog.noCustomYet")}
            </p>
          ) : (
            <>
              <div className="fld-list" style={{ marginTop: "var(--space-2)" }}>
                {custom.map((f) => (
                  <div key={f.id} className="fld-item">
                    <FieldRow def={f} count={holders(rows, f.id)} selected={f.id === selectedId} onSelect={() => setSelectedId(f.id === selectedId ? null : f.id)} />
                    {f.id === selectedId && <div className="fold-row-body"><FieldEditor projectId={projectId} def={f} items={rows} onDeleted={() => setSelectedId(null)} /></div>}
                  </div>
                ))}
              </div>
              {!selected && (
                <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
                  {t("fieldsDialog.selectHint")}
                </p>
              )}
            </>
          )}
        </div>

        <div>
          <Eyebrow>{t("fieldsDialog.newFieldEyebrow")}</Eyebrow>
          <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <input
              className="input"
              style={{ flex: 2 }}
              aria-label={t("fieldsDialog.newFieldNameAria")}
              placeholder={t("fieldsDialog.newFieldNamePlaceholder")}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (isCommitKey(e)) submit();
              }}
            />
            <select className="select" style={{ flex: 1 }} aria-label={t("fieldsDialog.newFieldTypeAria")} value={newType} onChange={(e) => setNewType(e.target.value as FieldType)}>
              {CUSTOM_TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {FIELD_TYPE_LABEL[ty]}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-secondary" disabled={!newName.trim()} onClick={submit}>
              <Icon name="i-plus" size={13} /> {t("fieldsDialog.addField")}
            </button>
          </div>
        </div>
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
          {t("fieldsDialog.close")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}
