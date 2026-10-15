import { AgentConnection } from "../projects/AgentConnection";
import { useEffect, useRef, useState } from "react";
import type { Board, FieldDef, FieldType, Item } from "@tomradex/domain";
import { Icon, type IconId } from "~/components/icons";
import { useChooseRepoFolder } from "~/components/projects/RepositoriesBlock";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { IconPicker } from "~/components/ui/icon-picker";
import { Eyebrow, Tag } from "~/components/ui/atoms";
import { BOARD_GLYPHS, FIELD_TYPE_LABEL, fieldLabel, viewIcon } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { normalizeRemote } from "~/lib/remotes";
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
  useRepoCheckouts,
  useRepos,
  useUpdateBoard,
  useUpdateField,
  useUpdateFieldOption
} from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";
import { useToastUndo } from "~/lib/undo";
import { keyLabel } from "~/lib/keybindings";

const CUSTOM_TYPES: FieldType[] = ["text", "number", "date", "select", "checkbox"];

const holders = (items: Item[], fieldId: string) => items.filter((i) => fieldId in i.fields).length;

/**
 * Enter and blur commit, Escape restores — a one-line rename that never needs a
 * Save button. Enter commits directly rather than through blur, because an
 * unfocused window fires no focus events at all.
 */
function RenameInput({ id, value, ariaLabel, className, placeholder, allowEmpty, onSave }: { id?: string; value: string; ariaLabel: string; className?: string; placeholder?: string; /** An emptied field is a value too (a path back to the root), not a cancelled edit. */ allowEmpty?: boolean; onSave: (next: string) => void }) {
  const settled = useRef(false);
  const commit = (el: HTMLInputElement) => {
    if (settled.current) return;
    settled.current = true;
    const next = el.value.trim();
    if (next !== value && (next || allowEmpty)) onSave(next);
    else el.value = value;
  };
  return (
    <input
      key={value}
      id={id}
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

/** A repository path as the backend reads it: no leading or trailing slashes, '' for the root. */
const cleanRepoPath = (p: string) => p.trim().replace(/^[\/\\]+|[\/\\]+$/g, "");

/**
 * One workstream as a small card: the head names it, the code line picks the
 * repository and folder its coding agents start in, and one sentence spells
 * out what that means on this machine.
 */
/**
 * Removing a workstream asks first, whatever it holds: it says where its
 * tickets go, that its repository binding goes with it, and that ⌘Z brings
 * it back. Cancel holds the focus.
 */
function RemoveWorkstreamDialog({
  open,
  onOpenChange,
  board,
  count,
  repoName,
  others,
  dest,
  onDest,
  pending,
  onConfirm
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  board: Board;
  count: number;
  repoName: string | null;
  others: Board[];
  dest: string;
  onDest: (id: string) => void;
  pending: boolean;
  onConfirm: () => void;
}) {
  const { t, tx } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("fieldsDialog.removeWorkstreamDialog", { name: board.name })} className="sheet-md">
      <DialogHead title={t("fieldsDialog.removeWorkstreamHead")} aside={<Tag tone="neutral">{board.name}</Tag>} />
      <DialogBody className="stack-3 ws-remove">
        {count > 0 ? (
          <div className="stack-2">
            <p className="meta-txt dense">{t(count === 1 ? "fieldsDialog.removeHoldsOne" : "fieldsDialog.removeHoldsMany", { n: count })}</p>
            <select className="select ws-remove-dest" aria-label={t("fieldsDialog.destinationAria")} value={dest} onChange={(e) => onDest(e.target.value)}>
              {others.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="meta-txt dense">{t("fieldsDialog.removeEmpty")}</p>
        )}
        {repoName && <p className="meta-txt dense">{tx("fieldsDialog.removeRepo", { repo: <b>{repoName}</b> })}</p>}
        <p className="meta-txt dense">{tx("fieldsDialog.removeUndo", { cmdz: <span className="num">{keyLabel("undo")}</span> })}</p>
      </DialogBody>
      <DialogFoot>
        {/* Cancel takes the focus: Enter must not remove */}
        <button type="button" autoFocus className="btn btn-secondary" onClick={() => onOpenChange(false)}>
          {t("common.cancel")}
        </button>
        <button type="button" className="btn btn-danger ws-remove-confirm" disabled={pending || (count > 0 && !dest)} onClick={onConfirm}>
          <Icon name="i-trash" size={13} />
          {t(count > 0 ? "fieldsDialog.moveAndRemove" : "fieldsDialog.removeConfirm")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}

/** The repository select's last option: pick a folder, add its repository, and point the workstream at it. */
const FROM_FOLDER = "__folder__";

function WorkstreamRow({ board, count, others, projectId, onOpenRepositories }: { board: Board; count: number; others: Board[]; projectId: string; onOpenRepositories?: () => void }) {
  const { t, tx } = useI18n();
  const toast = useToast();
  const update = useUpdateBoard(projectId);
  const repos = useRepos(projectId);
  const checkouts = useRepoCheckouts();
  const folder = useChooseRepoFolder(projectId);
  const remove = useRemoveBoard(projectId);
  const move = useMoveItemsToBoard(projectId);
  const items = useItems(projectId);
  const undoWrite = useToastUndo(projectId);
  const [removing, setRemoving] = useState(false);
  const [dest, setDest] = useState(others[0]?.id ?? "");
  const fail = (err: Error) => toast(errorSpec(err));

  const repo = (repos.data ?? []).find((r) => r.id === board.repoId) ?? null;
  const checkout = repo ? ((checkouts.data ?? []).find((c) => c.remote === normalizeRemote(repo.remote))?.checkout ?? null) : null;
  const subdir = cleanRepoPath(board.repoPath);
  const repoSelectId = `wsRepo-${board.id}`;
  const pathId = `wsPath-${board.id}`;

  const removeNow = () =>
    remove.mutate(board.id, {
      onSuccess: () => {
        setRemoving(false);
        toast({ body: tx("fieldsDialog.removedWorkstreamToast", { name: <b>{board.name}</b> }), onUndo: () => undoWrite({ id: board.id }) });
      },
      onError: fail
    });

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

  const repositoriesLink = onOpenRepositories && (
    <button type="button" className="link-btn" onClick={onOpenRepositories}>
      {t("fieldsDialog.openRepositories")}
    </button>
  );

  return (
    <div className="fld-ws" data-board={board.id}>
      <div className="fld-ws-head">
        <IconPicker compact value={viewIcon(board.icon)} ariaLabel={t("fieldsDialog.workstreamIconAria")} onChange={(icon) => update.mutate({ id: board.id, patch: { icon } }, { onError: fail })} />
        <RenameInput value={board.name} ariaLabel={t("fieldsDialog.workstreamNameAria")} className="input fld-ws-name" onSave={(name) => update.mutate({ id: board.id, patch: { name } }, { onError: fail })} />
        <span className="meta-txt num">{t(count === 1 ? "fieldsDialog.valuesOne" : "fieldsDialog.valuesMany", { n: count })}</span>
        <button
          type="button"
          className="btn btn-icon fld-ws-remove"
          title={t("fieldsDialog.removeWorkstreamTitle", { name: board.name })}
          aria-label={t("fieldsDialog.removeWorkstreamAria", { name: board.name })}
          disabled={others.length === 0}
          onClick={() => setRemoving(true)}
        >
          <Icon name="i-close" size={13} />
        </button>
      </div>

      <div className="fld-ws-code">
        <div className="field">
          <label htmlFor={repoSelectId}>{t("fieldsDialog.workstreamRepoLabel")}</label>
          <select
            id={repoSelectId}
            className="select"
            aria-label={t("fieldsDialog.workstreamRepoAria", { name: board.name })}
            value={board.repoId ?? ""}
            disabled={folder.busy}
            onChange={(e) => {
              const repoId = e.target.value;
              if (repoId === FROM_FOLDER) {
                void folder.choose().then((added) => added && update.mutate({ id: board.id, patch: { repoId: added.repo.id } }, { onError: fail }));
                return;
              }
              update.mutate({ id: board.id, patch: { repoId: repoId || null, repoPath: repoId ? board.repoPath : "" } }, { onError: fail });
            }}
          >
            <option value="">{t("fieldsDialog.workstreamRepoNone")}</option>
            {(repos.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
            <option value={FROM_FOLDER}>{t("fieldsDialog.workstreamRepoFolder")}</option>
          </select>
        </div>
        {repo && (
          <div className="field">
            <label htmlFor={pathId}>{t("fieldsDialog.workstreamRepoPathLabel")}</label>
            <RenameInput
              id={pathId}
              value={board.repoPath}
              allowEmpty
              ariaLabel={t("fieldsDialog.workstreamRepoPathAria")}
              className="input num fld-ws-path"
              placeholder={t("fieldsDialog.workstreamRepoPathPlaceholder")}
              onSave={(repoPath) => update.mutate({ id: board.id, patch: { repoPath: cleanRepoPath(repoPath) } }, { onError: fail })}
            />
          </div>
        )}
      </div>

      {repo && <AgentConnection key={repo.id} projectId={projectId} repoId={repo.id} hint />}
      <p className="meta-txt dense fld-ws-where">
        {!repo ? (
          <>
            <span>{t((repos.data ?? []).length ? "fieldsDialog.workstreamWhereNone" : "fieldsDialog.workstreamNoRepos")}</span>
            {repositoriesLink}
          </>
        ) : (
          <>
            <span>
              {subdir
                ? tx("fieldsDialog.workstreamWherePath", { repo: <b>{repo.name}</b>, path: <span className="num">{subdir}/</span> })
                : tx("fieldsDialog.workstreamWhereRoot", { repo: <b>{repo.name}</b> })}
            </span>
            {checkout ? (
              <span className="num fld-ws-checkout" title={checkout}>
                {t("fieldsDialog.workstreamCheckoutAt", { dir: checkout })}
              </span>
            ) : (
              <>
                <span>{t("fieldsDialog.workstreamCheckoutUnset")}</span>
                {repositoriesLink}
              </>
            )}
          </>
        )}
      </p>

      <RemoveWorkstreamDialog
        open={removing}
        onOpenChange={setRemoving}
        board={board}
        count={count}
        repoName={repo?.name ?? null}
        others={others}
        dest={dest}
        onDest={setDest}
        pending={remove.isPending || move.isPending}
        onConfirm={() => (count > 0 ? moveThenRemove() : removeNow())}
      />
    </div>
  );
}

/**
 * The built-in Workstream field's options are the project's boards. Every
 * issue belongs to one, so a workstream that still holds issues asks where
 * they go before it leaves, and the last one never can.
 */
function WorkstreamEditor({ projectId, items, focusBoardId, onOpenRepositories }: { projectId: string; items: Item[]; focusBoardId?: string | null; onOpenRepositories?: () => void }) {
  const { t, tx } = useI18n();
  const toast = useToast();
  const boards = useBoards(projectId);
  const create = useCreateBoard(projectId);
  const [newName, setNewName] = useState("");
  const list = boards.data ?? [];
  const editor = useRef<HTMLDivElement>(null);
  const ready = list.some((b) => b.id === focusBoardId);

  // opened for one workstream: bring its card into view, on its repository choice
  useEffect(() => {
    if (!focusBoardId || !ready) return;
    const card = editor.current?.querySelector<HTMLElement>(`.fld-ws[data-board="${focusBoardId}"]`);
    if (!card) return;
    card.scrollIntoView({ block: "center" });
    card.classList.add("is-focus");
    card.querySelector<HTMLElement>("select")?.focus();
  }, [focusBoardId, ready]);

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    create.mutate(
      { name, icon: "i-board" },
      { onSuccess: (b) => (setNewName(""), toast({ body: tx("fieldsDialog.addedWorkstreamToast", { name: <b>{b.name}</b> }) })), onError: (err) => toast(errorSpec(err)) }
    );
  };

  return (
    <div ref={editor} className="fld-editor stack-3" data-editor="workstream">
      <p className="meta-txt dense">{t("fieldsDialog.workstreamNote")}</p>
      <p className="meta-txt dense">
        {t("fieldsDialog.workstreamRepoNote")}
        {onOpenRepositories && (
          <>
            {" "}
            <button type="button" className="link-btn" onClick={onOpenRepositories}>
              {t("fieldsDialog.openRepositories")}
            </button>
          </>
        )}
      </p>
      <div>
        <Eyebrow>{t("fieldsDialog.workstreamsEyebrow")}</Eyebrow>
        <div className="stack-2" style={{ marginTop: "var(--space-2)" }}>
          {list.map((b) => (
            <WorkstreamRow key={b.id} board={b} count={items.filter((i) => i.boardId === b.id).length} others={list.filter((o) => o.id !== b.id)} projectId={projectId} onOpenRepositories={onOpenRepositories} />
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
  initialFieldId = null,
  initialBoardId = null,
  onOpenRepositories
}: {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The field to land on — "board" opens straight onto the workstream editor. */
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
        onError: (err) => toast(errorSpec(err))
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
                  {selectedId === f.id && <WorkstreamEditor projectId={projectId} items={rows} focusBoardId={open ? initialBoardId : null} onOpenRepositories={openRepositories} />}
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
                    {f.id === selectedId && <FieldEditor projectId={projectId} def={f} items={rows} onDeleted={() => setSelectedId(null)} />}
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
