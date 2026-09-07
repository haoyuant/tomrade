import { useEffect, useRef, useState } from "react";
import type { Board, FieldDef, FieldType, Item } from "@tomrade/domain";
import { Icon, type IconId } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { IconPicker } from "~/components/ui/icon-picker";
import { Eyebrow, Tag } from "~/components/ui/atoms";
import { BOARD_GLYPHS, FIELD_TYPE_LABEL, fieldLabel, viewIcon } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import {
  useAddFieldOption,
  useBoards,
  useCreateBoard,
  useCreateField,
  useFields,
  useItems,
  useMoveItemsToBoard,
  useRemoveBoard,
  useRemoveField,
  useRemoveFieldOption,
  useRepos,
  useUpdateBoard,
  useUpdateField,
  useUpdateFieldOption
} from "~/lib/queries";
import { useToast } from "~/lib/toast";

const CUSTOM_TYPES: FieldType[] = ["text", "number", "date", "select", "checkbox"];

const holders = (items: Item[], fieldId: string) => items.filter((i) => fieldId in i.fields).length;

/**
 * Enter and blur commit, Escape restores — a one-line rename that never needs a
 * Save button. Enter commits directly rather than through blur, because an
 * unfocused window fires no focus events at all.
 */
function RenameInput({ value, ariaLabel, className, placeholder, onSave }: { value: string; ariaLabel: string; className?: string; placeholder?: string; onSave: (next: string) => void }) {
  const settled = useRef(false);
  const commit = (el: HTMLInputElement) => {
    if (settled.current) return;
    settled.current = true;
    const next = el.value.trim();
    if (next && next !== value) onSave(next);
    else el.value = value;
  };
  return (
    <input
      key={value}
      className={className ?? "input"}
      aria-label={ariaLabel}
      placeholder={placeholder}
      defaultValue={value}
      onFocus={() => {
        settled.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          e.currentTarget.value = value;
          settled.current = true;
          e.currentTarget.blur();
        }
        if (e.key === "Enter") {
          commit(e.currentTarget);
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => commit(e.currentTarget)}
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
  if (!onSelect) return <div className="cfg-row fld-row is-builtin" data-field={def.id}>{body}</div>;
  return (
    <button type="button" className={`cfg-row fld-row${def.builtin ? " is-builtin" : ""}${selected ? " is-selected" : ""}`} data-field={def.id} aria-expanded={selected} onClick={onSelect}>
      {body}
      <Icon className="fld-chev" name="i-chevdown" size={11} aria-hidden />
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
  const ref = useRef<HTMLDivElement | null>(null);

  // The list above can push the editor below the fold; a selection should be seen.
  useEffect(() => {
    setConfirming(false);
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [def.id]);

  const fail = (err: Error) => toast({ body: err.message });

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

/** One workstream: glyph, name, package, how many issues it holds, and the way out. */
function WorkstreamRow({ board, count, others, projectId }: { board: Board; count: number; others: Board[]; projectId: string }) {
  const { t, tx } = useI18n();
  const toast = useToast();
  const update = useUpdateBoard(projectId);
  const repos = useRepos(projectId);
  const remove = useRemoveBoard(projectId);
  const move = useMoveItemsToBoard(projectId);
  const items = useItems(projectId);
  const [removing, setRemoving] = useState(false);
  const [dest, setDest] = useState(others[0]?.id ?? "");
  const fail = (err: Error) => toast({ body: err.message });

  const removeNow = () =>
    remove.mutate(board.id, { onSuccess: () => toast({ body: tx("fieldsDialog.removedWorkstreamToast", { name: <b>{board.name}</b> }) }), onError: fail });

  const moveThenRemove = () => {
    const target = others.find((b) => b.id === dest);
    if (!target) return;
    const ids = (items.data ?? []).filter((i) => i.boardId === board.id).map((i) => i.id);
    move.mutate(
      { from: board.id, to: target.id, itemIds: ids },
      {
        onSuccess: (n) => {
          toast({ body: tx("fieldsDialog.movedWorkstreamToast", { n: <span className="num">{n}</span>, name: <b>{target.name}</b> }) });
          removeNow();
        },
        onError: fail
      }
    );
  };

  return (
    <div className="fld-opt fld-ws" data-board={board.id}>
      <IconPicker compact value={viewIcon(board.icon)} ariaLabel={t("fieldsDialog.workstreamIconAria")} onChange={(icon) => update.mutate({ id: board.id, patch: { icon } }, { onError: fail })} />
      <RenameInput value={board.name} ariaLabel={t("fieldsDialog.workstreamNameAria")} className="input fld-opt-name" onSave={(name) => update.mutate({ id: board.id, patch: { name } }, { onError: fail })} />
      <RenameInput
        value={board.subtitle ?? ""}
        ariaLabel={t("fieldsDialog.workstreamPkgAria")}
        className="input fld-opt-desc num"
        placeholder={t("fieldsDialog.workstreamPkgPlaceholder")}
        onSave={(subtitle) => update.mutate({ id: board.id, patch: { subtitle: subtitle || null } }, { onError: fail })}
      />
      <span className="meta-txt num">{t(count === 1 ? "fieldsDialog.valuesOne" : "fieldsDialog.valuesMany", { n: count })}</span>
      {/* The repository the workstream stands for: where its agents run. */}
      <span className="row fld-ws-repo" style={{ gap: 6, gridColumn: "1 / -1" }}>
        <select
          className="select"
          style={{ flex: 1 }}
          aria-label={t("fieldsDialog.workstreamRepoAria", { name: board.name })}
          value={board.repoId ?? ""}
          onChange={(e) => update.mutate({ id: board.id, patch: { repoId: e.target.value || null, repoPath: e.target.value ? board.repoPath : "" } }, { onError: fail })}
        >
          <option value="">{t("fieldsDialog.workstreamRepoNone")}</option>
          {(repos.data ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        {board.repoId && (
          <RenameInput
            value={board.repoPath}
            ariaLabel={t("fieldsDialog.workstreamRepoPathAria")}
            className="input num fld-ws-path"
            placeholder={t("fieldsDialog.workstreamRepoPathPlaceholder")}
            onSave={(repoPath) => update.mutate({ id: board.id, patch: { repoPath } }, { onError: fail })}
          />
        )}
      </span>
      {removing && count > 0 ? (
        <span className="row" style={{ gap: 6, gridColumn: "1 / -1" }}>
          <span className="meta-txt">{t("fieldsDialog.moveIssuesTo", { n: count })}</span>
          <select className="select" style={{ flex: 1 }} aria-label={t("fieldsDialog.destinationAria")} value={dest} onChange={(e) => setDest(e.target.value)}>
            {others.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-danger" disabled={!dest} onClick={moveThenRemove}>
            {t("fieldsDialog.moveAndRemove")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setRemoving(false)}>
            {t("common.cancel")}
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="btn btn-icon"
          title={t("fieldsDialog.removeWorkstreamTitle", { name: board.name })}
          aria-label={t("fieldsDialog.removeWorkstreamAria", { name: board.name })}
          disabled={others.length === 0}
          onClick={() => (count > 0 ? setRemoving(true) : removeNow())}
        >
          <Icon name="i-close" size={13} />
        </button>
      )}
    </div>
  );
}

/**
 * The built-in Workstream field's options are the project's boards. Every
 * issue belongs to one, so a workstream that still holds issues asks where
 * they go before it leaves, and the last one never can.
 */
function WorkstreamEditor({ projectId, items }: { projectId: string; items: Item[] }) {
  const { t, tx } = useI18n();
  const toast = useToast();
  const boards = useBoards(projectId);
  const create = useCreateBoard(projectId);
  const [newName, setNewName] = useState("");
  const list = boards.data ?? [];

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    create.mutate(
      { name, icon: "i-board", subtitle: slug ? `packages/${slug}` : null },
      { onSuccess: (b) => (setNewName(""), toast({ body: tx("fieldsDialog.addedWorkstreamToast", { name: <b>{b.name}</b> }) })), onError: (err) => toast({ body: err.message }) }
    );
  };

  return (
    <div className="fld-editor stack-3" data-editor="workstream">
      <p className="meta-txt dense">{t("fieldsDialog.workstreamNote")}</p>
      <p className="meta-txt dense">{t("fieldsDialog.workstreamRepoNote")}</p>
      <div>
        <Eyebrow>{t("fieldsDialog.workstreamsEyebrow")}</Eyebrow>
        <div className="stack-1" style={{ marginTop: "var(--space-2)" }}>
          {list.map((b) => (
            <WorkstreamRow key={b.id} board={b} count={items.filter((i) => i.boardId === b.id).length} others={list.filter((o) => o.id !== b.id)} projectId={projectId} />
          ))}
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <input
              className="input"
              aria-label={t("fieldsDialog.newWorkstreamAria")}
              placeholder={t("fieldsDialog.newWorkstreamPlaceholder")}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
              }}
            />
            <button type="button" className="btn btn-ghost" disabled={!newName.trim()} onClick={add}>
              <Icon name="i-plus" size={13} /> {t("fieldsDialog.addWorkstream")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The project's field registry. Built-ins are listed so the whole vocabulary a
 * view can use is in one place; only custom fields — and the Workstream
 * field's options — are editable, and every edit lands live: a field is schema,
 * not a draft.
 */
export function FieldsDialog({
  projectId,
  projectName,
  open,
  onOpenChange,
  initialFieldId = null
}: {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The field to land on — "board" opens straight onto the workstream editor. */
  initialFieldId?: string | null;
}) {
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
    setSelectedId(initialFieldId);
    setNewName("");
    setNewType("text");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

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
            {builtin.map((f) =>
              f.id === "board" ? (
                <div key={f.id} className="fld-item">
                  <FieldRow def={f} count={null} selected={selectedId === f.id} onSelect={() => setSelectedId(selectedId === f.id ? null : f.id)} />
                  {selectedId === f.id && <WorkstreamEditor projectId={projectId} items={rows} />}
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
                    {f.id === selectedId && <FieldEditor projectId={projectId} def={f} count={holders(rows, f.id)} onDeleted={() => setSelectedId(null)} />}
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
