import { useEffect, useState } from "react";
import type { FieldDef, FieldType, Item } from "@tomrade/domain";
import { Icon } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Eyebrow, Tag } from "~/components/ui/atoms";
import { FIELD_TYPE_LABEL, fieldLabel } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useAddFieldOption, useCreateField, useFields, useItems, useRemoveField, useRemoveFieldOption, useUpdateField, useUpdateFieldOption } from "~/lib/queries";
import { useToast } from "~/lib/toast";

const CUSTOM_TYPES: FieldType[] = ["text", "number", "date", "select"];

const holders = (items: Item[], fieldId: string) => items.filter((i) => fieldId in i.fields).length;

/** Blur commits, Escape restores — a one-line rename that never needs a Save button. */
function RenameInput({ value, ariaLabel, className, placeholder, onSave }: { value: string; ariaLabel: string; className?: string; placeholder?: string; onSave: (next: string) => void }) {
  return (
    <input
      key={value}
      className={className ?? "input"}
      aria-label={ariaLabel}
      placeholder={placeholder}
      defaultValue={value}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      onBlur={(e) => {
        const next = e.currentTarget.value.trim();
        if (next && next !== value) onSave(next);
        else e.currentTarget.value = value;
      }}
    />
  );
}

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
  if (!onSelect) return <div className="cfg-row fld-row is-builtin">{body}</div>;
  return (
    <button type="button" className={`cfg-row fld-row${selected ? " is-selected" : ""}`} aria-pressed={selected} onClick={onSelect}>
      {body}
    </button>
  );
}

/** The editor for one custom field: rename, options for a select, and the delete behind a second click. */
function FieldEditor({ projectId, def, count, onDeleted }: { projectId: string; def: FieldDef; count: number; onDeleted: () => void }) {
  const { t, tx } = useI18n();
  const toast = useToast();
  const update = useUpdateField(projectId);
  const remove = useRemoveField(projectId);
  const addOption = useAddFieldOption(projectId);
  const updateOption = useUpdateFieldOption(projectId);
  const removeOption = useRemoveFieldOption(projectId);
  const [confirming, setConfirming] = useState(false);
  const [newOption, setNewOption] = useState("");

  useEffect(() => setConfirming(false), [def.id]);

  const fail = (err: Error) => toast({ body: err.message });

  const commitOption = () => {
    const name = newOption.trim();
    if (!name) return;
    addOption.mutate({ fieldId: def.id, input: { name } }, { onSuccess: () => setNewOption(""), onError: fail });
  };

  return (
    <div className="fld-editor stack-3">
      <div className="grid-2">
        <div className="field">
          <label htmlFor="fldName">{t("fieldsDialog.nameLabel")}</label>
          <RenameInput
            value={def.name}
            ariaLabel={t("fieldsDialog.nameLabel")}
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
                <RenameInput
                  value={o.name}
                  ariaLabel={t("fieldsDialog.optionNameAria")}
                  className="input fld-opt-name"
                  onSave={(name) => updateOption.mutate({ fieldId: def.id, optionId: o.id, patch: { name } }, { onError: fail })}
                />
                <RenameInput
                  value={o.description ?? ""}
                  ariaLabel={t("fieldsDialog.optionDescriptionAria")}
                  className="input fld-opt-desc"
                  placeholder={t("fieldsDialog.optionDescriptionPlaceholder")}
                  onSave={(description) => updateOption.mutate({ fieldId: def.id, optionId: o.id, patch: { description } }, { onError: fail })}
                />
                <button
                  type="button"
                  className="btn btn-icon"
                  title={t("fieldsDialog.removeOptionTitle", { name: o.name })}
                  aria-label={t("fieldsDialog.removeOptionAria", { name: o.name })}
                  onClick={() =>
                    removeOption.mutate(
                      { fieldId: def.id, optionId: o.id },
                      { onSuccess: (n) => toast({ body: tx("fieldsDialog.removedOptionToast", { name: <b>{o.name}</b>, n: <span className="num">{n}</span> }) }), onError: fail }
                    )
                  }
                >
                  <Icon name="i-close" size={13} />
                </button>
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
                  if (e.key === "Enter") commitOption();
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
 * view can use is in one place; only custom fields are editable, and every
 * edit lands live — a field is schema, not a draft.
 */
export function FieldsDialog({ projectId, projectName, open, onOpenChange }: { projectId: string; projectName: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tx } = useI18n();
  const toast = useToast();
  const fields = useFields(projectId);
  const items = useItems(projectId);
  const create = useCreateField(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<FieldType>("text");

  useEffect(() => {
    if (!open) return;
    setSelectedId(null);
    setNewName("");
    setNewType("text");
  }, [open]);

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
        onError: (err) => toast({ body: err.message })
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("fieldsDialog.dialogLabel")} className="sheet-board">
      <DialogHead title={t("fieldsDialog.headTitle")} aside={<Tag tone="neutral">{projectName}</Tag>} />
      <DialogBody className="stack-4">
        <div>
          <Eyebrow>{t("fieldsDialog.builtinEyebrow")}</Eyebrow>
          <div className="fld-list" style={{ marginTop: "var(--space-2)" }}>
            {builtin.map((f) => (
              <FieldRow key={f.id} def={f} count={null} />
            ))}
          </div>
          <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
            {t("fieldsDialog.builtinNote")}
          </p>
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
                  <FieldRow key={f.id} def={f} count={holders(rows, f.id)} selected={f.id === selectedId} onSelect={() => setSelectedId(f.id === selectedId ? null : f.id)} />
                ))}
              </div>
              {selected ? (
                <FieldEditor projectId={projectId} def={selected} count={holders(rows, selected.id)} onDeleted={() => setSelectedId(null)} />
              ) : (
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
                if (e.key === "Enter") submit();
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
