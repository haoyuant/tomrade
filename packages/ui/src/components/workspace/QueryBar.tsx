import { useState, type ReactNode } from "react";
import { EMPTY_KEY, fieldValueOf, type FieldDef, type FieldValue, type FilterClause, type FilterOp, type Item, type Priority, type SortKey, type ViewQuery } from "@tomradex/domain";
import { Icon, type IconId } from "~/components/icons";
import { Kbd, PriorityGlyph, StatusMark } from "~/components/ui/atoms";
import { Menu, MenuActionItem, MenuCheckItem, MenuEmpty, MenuFoot, MenuHead, MenuRadioItem } from "~/components/ui/menu";
import { Popover } from "~/components/ui/popover";
import { FILTER_OP_LABEL, fieldLabel, isTicket, manualSortLabel, viewIcon } from "~/lib/domain";
import { useAllItems } from "~/lib/queries";
import { useI18n } from "~/lib/i18n";
import { ticketSearch, useTicketSearch, useWorkspace, type WorkspaceValue } from "./context";
import { isCancelKey, isCommitKey } from "~/lib/keys";

const FIELD_ICON: Record<string, IconId> = {
  title: "i-pen",
  status: "s-doing",
  priority: "i-bars",
  epic: "i-stack",
  labels: "i-tag",
  board: "i-board",
  updated: "i-clock",
  key: "i-bars",
  provenance: "i-pen"
};

const iconFor = (def: FieldDef): IconId =>
  FIELD_ICON[def.id] ??
  (def.type === "select" ? "i-filter" : def.type === "date" ? "i-clock" : def.type === "checkbox" ? "i-check" : def.type === "number" ? "i-bars" : "i-pen");

/** Fields whose values are picked from a list; the rest are typed. */
const isChoice = (def: FieldDef) => def.type === "select" || def.type === "labels" || def.type === "item" || def.type === "checkbox";

const clauseIndexFor = (q: ViewQuery, fieldId: string, op: FilterOp) => q.filter.findIndex((c) => c.field === fieldId && c.op === op);

/** Replace, append or drop one clause; the query is otherwise untouched. */
function withClause(q: ViewQuery, index: number, clause: FilterClause | null): ViewQuery {
  const filter = [...q.filter];
  if (clause === null) {
    if (index >= 0) filter.splice(index, 1);
  } else if (index >= 0) filter[index] = clause;
  else filter.push(clause);
  return { ...q, filter };
}

/** How many tickets carry `key` for the field — the count beside every option, so a filter never hides its cost. */
function countFor(owned: Item[], def: FieldDef, key: string | null): number {
  return owned.filter((i) => {
    const raw = fieldValueOf(i, def.id);
    if (key === null) return raw === null || (Array.isArray(raw) && raw.length === 0);
    return Array.isArray(raw) ? raw.map(String).includes(key) : raw !== null && String(raw) === key;
  }).length;
}

function markFor(fieldId: string, key: string, ws: WorkspaceValue): ReactNode {
  if (fieldId === "status") return <StatusMark status={key as never} size={12} />;
  if (fieldId === "priority") return <PriorityGlyph priority={Number(key) as Priority} always />;
  if (fieldId === "labels") return <Icon name="i-tag" size={11} />;
  if (fieldId === "epic") return <Icon name="i-stack" size={11} />;
  if (fieldId === "board") {
    const icon = ws.optionsOf("board").find((o) => o.key === key)?.icon;
    return <Icon name={viewIcon(icon ?? "i-board")} size={12} />;
  }
  return undefined;
}

function summarize(clause: FilterClause, def: FieldDef, ws: WorkspaceValue): string {
  const names = clause.values.map((v) => (v === null ? ws.groupLabel(def.id, EMPTY_KEY) : isChoice(def) ? ws.groupLabel(def.id, String(v)) : def.type === "text" || def.id === "title" ? `“${v}”` : String(v)));
  if (names.length <= 2) return names.join(", ");
  return `${names[0]} +${names.length - 1}`;
}

/** The option list for a choice field, writing one `in` clause; unticking the last value removes the clause. */
function ChoiceEditor({ def, onBack }: { def: FieldDef; onBack?: () => void }) {
  const { t } = useI18n();
  const ws = useWorkspace();
  const index = clauseIndexFor(ws.query, def.id, "in");
  const clause = index >= 0 ? ws.query.filter[index] : null;
  const chosen = new Set((clause?.values ?? []).map((v) => (v === null ? EMPTY_KEY : String(v))));
  // Counted over every ticket while the list is open: an option only old done tickets carry is still offered.
  const all = useAllItems(ws.project.id);
  const owned = all.data?.filter(isTicket) ?? ws.owned;
  const options = ws.optionsOf(def.id).map((o) => ({ key: o.key, name: o.name, count: countFor(owned, def, o.key) })).filter((o) => o.count > 0 || chosen.has(o.key));
  const emptyCount = countFor(owned, def, null);
  const withEmpty = ws.groupSpace(def.id).includes(EMPTY_KEY) && (emptyCount > 0 || chosen.has(EMPTY_KEY));

  const toggle = (key: string) => {
    const next = new Set(chosen);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    const values: (FieldValue | null)[] = [...next].map((k) => (k === EMPTY_KEY ? null : k));
    ws.setQuery(withClause(ws.query, index, values.length ? { field: def.id, op: "in", values } : null));
  };

  return (
    <>
      <MenuHead title={fieldLabel(def)} aside={chosen.size ? t("queryBar.selectedCount", { n: chosen.size }) : undefined} />
      {options.length === 0 && !withEmpty ? (
        <MenuEmpty>{t("queryBar.nothingToFilter", { name: fieldLabel(def).toLowerCase() })}</MenuEmpty>
      ) : (
        <>
          {options.map((o) => (
            <MenuCheckItem key={o.key} checked={chosen.has(o.key)} onToggle={() => toggle(o.key)} mark={markFor(def.id, o.key, ws)} name={o.name} count={o.count} />
          ))}
          {withEmpty && <MenuCheckItem checked={chosen.has(EMPTY_KEY)} onToggle={() => toggle(EMPTY_KEY)} mark={<></>} name={ws.groupLabel(def.id, EMPTY_KEY)} count={emptyCount} />}
        </>
      )}
      {(chosen.size > 0 || onBack) && (
        <MenuFoot>
          {onBack && (
            <button type="button" className="btn btn-ghost" style={{ padding: "4px 8px" }} onClick={onBack}>
              ← {t("queryBar.allFields")}
            </button>
          )}
          {chosen.size > 0 && (
            <button type="button" className="btn btn-ghost" style={{ padding: "4px 8px", marginLeft: "auto" }} onClick={() => ws.setQuery(withClause(ws.query, index, null))}>
              {t("queryBar.clearFacet", { name: fieldLabel(def).toLowerCase() })}
            </button>
          )}
        </MenuFoot>
      )}
    </>
  );
}

/** A typed value: `contains` for text, a lower and an upper bound for numbers and dates. */
function TypedEditor({ def, onDone }: { def: FieldDef; onDone: () => void }) {
  const { t } = useI18n();
  const ws = useWorkspace();
  const isText = def.type === "text";
  const inputType = def.type === "number" ? "number" : def.type === "date" ? "date" : "text";
  const current = (op: FilterOp) => {
    const i = clauseIndexFor(ws.query, def.id, op);
    const v = i >= 0 ? ws.query.filter[i].values[0] : null;
    return v === null || v === undefined ? "" : String(v);
  };
  const parse = (raw: string): FieldValue | null => {
    const s = raw.trim();
    if (!s) return null;
    if (def.type === "number") {
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    return s;
  };
  const apply = (op: FilterOp, raw: string) => {
    const value = parse(raw);
    const index = clauseIndexFor(ws.query, def.id, op);
    ws.setQuery(withClause(ws.query, index, value === null ? null : { field: def.id, op, values: [value] }));
  };
  const field = (op: FilterOp, label: string) => (
    <label className="pop-field">
      <span className="meta-txt">{label}</span>
      <input
        className="input"
        type={inputType}
        step={def.type === "number" ? "any" : undefined}
        aria-label={`${fieldLabel(def)} ${label}`}
        defaultValue={current(op)}
        autoFocus={op === "contains" || op === "gte"}
        onKeyDown={(e) => {
          if (isCommitKey(e)) {
            apply(op, e.currentTarget.value);
            onDone();
          }
        }}
        onBlur={(e) => apply(op, e.currentTarget.value)}
      />
    </label>
  );
  return (
    <div className="pop-body">
      <MenuHead title={fieldLabel(def)} />
      {isText ? field("contains", FILTER_OP_LABEL.contains) : (
        <>
          {field("gte", t("queryBar.atLeast"))}
          {field("lte", t("queryBar.atMost"))}
        </>
      )}
      <MenuFoot>
        <button type="button" className="btn btn-secondary" style={{ marginLeft: "auto", padding: "4px 10px" }} onClick={onDone}>
          {t("common.done")}
        </button>
      </MenuFoot>
    </div>
  );
}

function FilterChip({ index, clause }: { index: number; clause: FilterClause }) {
  const { t } = useI18n();
  const ws = useWorkspace();
  const def = ws.fieldById.get(clause.field);
  const [open, setOpen] = useState(false);
  const remove = () => ws.setQuery(withClause(ws.query, index, null));
  const text = def ? `${fieldLabel(def)} ${FILTER_OP_LABEL[clause.op]} ${summarize(clause, def, ws)}` : clause.field;
  const edit = (
    <button type="button" className="qb-chip-edit" title={t("queryBar.editFilterTitle")}>
      {def && <Icon className="ico" name={iconFor(def)} size={12} />}
      <span>{text}</span>
    </button>
  );
  return (
    <span className="qb-chip" data-field={clause.field} data-op={clause.op}>
      {!def ? (
        edit
      ) : isChoice(def) ? (
        <Menu open={open} onOpenChange={setOpen} label={fieldLabel(def)} trigger={edit}>
          <ChoiceEditor def={def} />
        </Menu>
      ) : (
        <Popover open={open} onOpenChange={setOpen} label={fieldLabel(def)} trigger={<span onClick={() => setOpen((v) => !v)}>{edit}</span>}>
          <TypedEditor def={def} onDone={() => setOpen(false)} />
        </Popover>
      )}
      <button type="button" className="qb-chip-x" aria-label={t("queryBar.removeFilterAria", { name: text })} title={t("queryBar.removeFilterTitle")} onClick={remove}>
        <Icon name="i-close" size={10} />
      </button>
    </span>
  );
}

/** Two stages in one menu: pick a field, then its values. Typed fields hand over to a popover. */
function AddFilter() {
  const { t } = useI18n();
  const ws = useWorkspace();
  const [menuOpen, setMenuOpen] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const filterable = ws.fields.filter((f) => f.can.filter);
  const staged = stage ? ws.fieldById.get(stage) : undefined;
  const typedDef = typed ? ws.fieldById.get(typed) : undefined;

  const pick = (def: FieldDef) => {
    if (isChoice(def)) return setStage(def.id);
    setMenuOpen(false);
    setTyped(def.id);
  };

  const trigger = (
    <Menu
      open={menuOpen}
      onOpenChange={(o) => {
        setMenuOpen(o);
        if (!o) setStage(null);
      }}
      label={t("queryBar.addFilter")}
      trigger={
        <button type="button" className="qb-btn qb-add" data-on={ws.query.filter.length > 0} title={t("queryBar.addFilterTitle")}>
          <Icon className="ico" name="i-filter" size={13} />
          <span>{ws.query.filter.length ? t("queryBar.addFilterShort") : t("queryBar.filter")}</span>
          <Icon className="chev" name="i-chevdown" size={12} />
        </button>
      }
    >
      {staged ? (
        <ChoiceEditor def={staged} onBack={() => setStage(null)} />
      ) : (
        <>
          <MenuHead title={t("queryBar.filterBy")} />
          {filterable.map((f) => (
            <MenuActionItem key={f.id} icon={<Icon name={iconFor(f)} size={13} />} name={fieldLabel(f)} keepOpen={isChoice(f)} onSelect={() => pick(f)} />
          ))}
        </>
      )}
    </Menu>
  );

  return (
    <Popover open={!!typedDef} onOpenChange={() => setTyped(null)} label={typedDef ? fieldLabel(typedDef) : t("queryBar.addFilter")} trigger={trigger}>
      {typedDef && <TypedEditor def={typedDef} onDone={() => setTyped(null)} />}
    </Popover>
  );
}

/** One field out of the groupable ones — Column by, Swimlanes / Group by. */
function FieldPick({
  icon,
  label,
  value,
  fields,
  allowNone,
  onPick,
  className
}: {
  icon: IconId;
  label: string;
  value: string | null;
  fields: FieldDef[];
  allowNone: boolean;
  onPick: (fieldId: string | null) => void;
  className: string;
}) {
  const { t } = useI18n();
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const current = value ? ws.fieldById.get(value) : undefined;
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label={label}
      align="end"
      trigger={
        <button type="button" className={`qb-btn ${className}`} data-on={allowNone && !!current} title={label}>
          <Icon className="ico" name={icon} size={13} />
          <span className="lbl">{label}</span>
          <span className="qb-val">{current ? fieldLabel(current) : t("common.none")}</span>
          <Icon className="chev" name="i-chevdown" size={12} />
        </button>
      }
    >
      <MenuHead title={label} />
      {allowNone && <MenuRadioItem checked={!current} name={t("common.none")} onSelect={() => onPick(null)} />}
      {fields.map((f) => (
        <MenuRadioItem key={f.id} checked={f.id === value} name={fieldLabel(f)} mark={<Icon name={iconFor(f)} size={13} />} onSelect={() => onPick(f.id)} />
      ))}
    </Menu>
  );
}

/** One key: a field and a direction. Picking the current field flips it; Manual clears. */
function SortPick() {
  const { t } = useI18n();
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const sortable = ws.fields.filter((f) => f.can.sort);
  const key: SortKey | undefined = ws.query.sortBy[0];
  const current = key ? ws.fieldById.get(key.field) : undefined;
  const pick = (fieldId: string) => {
    const dir = key?.field === fieldId ? (key.dir === "asc" ? "desc" : "asc") : "asc";
    ws.setQuery({ ...ws.query, sortBy: [{ field: fieldId, dir }] });
  };
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label={t("queryBar.sort")}
      align="end"
      trigger={
        <button type="button" className="qb-btn qb-sort" data-on={!!key} title={t("queryBar.sortTitle")}>
          <Icon className="ico" name="i-bars" size={13} />
          <span className="lbl">{t("queryBar.sort")}</span>
          <span className="qb-val">{current ? `${fieldLabel(current)} ${key!.dir === "asc" ? "↑" : "↓"}` : manualSortLabel()}</span>
          <Icon className="chev" name="i-chevdown" size={12} />
        </button>
      }
    >
      <MenuHead title={t("queryBar.sort")} aside={t("queryBar.sortHint")} />
      <MenuRadioItem checked={!key} name={manualSortLabel()} onSelect={() => ws.setQuery({ ...ws.query, sortBy: [] })} />
      {sortable.map((f) => (
        <MenuRadioItem
          key={f.id}
          checked={key?.field === f.id}
          name={fieldLabel(f)}
          mark={key?.field === f.id ? <span className="num">{key.dir === "asc" ? "↑" : "↓"}</span> : <Icon name={iconFor(f)} size={13} />}
          onSelect={() => pick(f.id)}
        />
      ))}
    </Menu>
  );
}

/** Puts the caret in the query bar's search, its words selected; false where the screen has no query bar. */
export function focusTicketSearch(): boolean {
  const input = document.querySelector<HTMLInputElement>(".qb-search-input");
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}

/** Narrows whichever view is open to the tickets holding every word, in key, title or body. */
function SearchBox() {
  const { t } = useI18n();
  const ws = useWorkspace();
  const text = useTicketSearch(ws.project.id);
  const set = (next: string) => ticketSearch.set(ws.project.id, next);
  return (
    <>
      <div className="qb-search" data-on={text.trim().length > 0}>
        <Icon className="ico" name="i-search" size={13} />
        <input
          className="qb-search-input"
          type="search"
          value={text}
          placeholder={t("queryBar.searchPlaceholder")}
          aria-label={t("queryBar.searchAria")}
          spellCheck={false}
          onChange={(e) => set(e.target.value)}
          onKeyDown={(e) => {
            // Escape empties the field, then leaves it — before it closes the open ticket
            if (isCancelKey(e)) {
              e.preventDefault();
              if (text) set("");
              else e.currentTarget.blur();
            } else if (isCommitKey(e) && ws.visible[0]) {
              e.preventDefault();
              ws.select(ws.visible[0].id);
            }
          }}
        />
        {text ? (
          <button type="button" className="qb-search-x" aria-label={t("queryBar.clearSearch")} title={t("queryBar.clearSearch")} onClick={() => set("")}>
            <Icon name="i-close" size={10} />
          </button>
        ) : (
          <Kbd>/</Kbd>
        )}
      </div>
      {ws.searchElsewhere > 0 && (
        <span className="qb-search-note meta-txt" title={t("queryBar.searchElsewhereTitle")}>
          {t("queryBar.searchElsewhere", { n: ws.searchElsewhere })}
        </span>
      )}
    </>
  );
}

/** Save the draft under a new name: a popover with one field. */
function SaveAsNew() {
  const { t } = useI18n();
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const commit = (raw: string) => {
    const name = raw.trim();
    if (!name) return;
    setOpen(false);
    ws.saveAsNewView(name);
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={t("queryBar.saveAsNew")}
      align="end"
      trigger={
        <button type="button" className="btn btn-ghost qb-save-as" style={{ padding: "5px 9px" }} onClick={() => setOpen((v) => !v)}>
          {t("queryBar.saveAsNew")}
        </button>
      }
    >
      <div className="pop-body">
        <MenuHead title={t("queryBar.saveAsNew")} />
        <label className="pop-field">
          <span className="meta-txt">{t("queryBar.newViewName")}</span>
          <input
            autoFocus
            className="input"
            aria-label={t("queryBar.newViewName")}
            placeholder={t("queryBar.newViewPlaceholder")}
            defaultValue={t("titleBar.copyName", { name: ws.view.name })}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (isCommitKey(e)) commit(e.currentTarget.value);
            }}
          />
        </label>
        <MenuFoot>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginLeft: "auto", padding: "4px 10px" }}
            onClick={(e) => commit((e.currentTarget.closest(".pop-body")?.querySelector("input") as HTMLInputElement | null)?.value ?? "")}
          >
            {t("queryBar.saveAsNewConfirm")}
          </button>
        </MenuFoot>
      </div>
    </Popover>
  );
}

/**
 * The live query sitting on top of the saved view. Every control edits the
 * draft; "Save view" writes it back, "Discard" drops it, and the difference is
 * always visible.
 */
export function QueryBar() {
  const { t } = useI18n();
  const ws = useWorkspace();
  const groupable = ws.fields.filter((f) => f.can.group);

  return (
    <div className="query-bar" data-dirty={ws.dirty}>
      <SearchBox />
      {ws.query.filter.map((clause, i) => (
        <FilterChip key={`${clause.field}:${clause.op}:${i}`} index={i} clause={clause} />
      ))}
      <AddFilter />

      <div className="qb-right">
        {ws.layout === "board" && (
          <FieldPick
            icon="i-board"
            label={t("queryBar.columnBy")}
            value={ws.query.columnBy ?? "status"}
            fields={groupable}
            allowNone={false}
            className="qb-column-by"
            // the column space changes, so a visibility list written against the old one is dropped
            onPick={(fieldId) => fieldId && ws.setQuery({ ...ws.query, columnBy: fieldId, columns: [], wip: {} })}
          />
        )}
        {ws.layout !== "graph" && (
          <FieldPick
            icon="i-stack"
            label={ws.layout === "board" ? t("queryBar.swimlanes") : t("queryBar.groupBy")}
            value={ws.query.groupBy}
            fields={groupable.filter((f) => f.id !== (ws.query.columnBy ?? "status") || ws.layout !== "board")}
            allowNone
            className="qb-group-by"
            onPick={(fieldId) => ws.setQuery({ ...ws.query, groupBy: fieldId })}
          />
        )}
        {ws.layout !== "graph" && <SortPick />}
        {ws.virtual ? (
          // nothing saved to write back to: the page can only become a view
          <div className="qb-dirty" role="group" aria-label={t("queryBar.unsavedAria")}>
            <span className="qb-sep" />
            {ws.dirty && (
              <button type="button" className="btn btn-ghost qb-discard" style={{ padding: "5px 9px" }} onClick={ws.discardChanges}>
                {t("queryBar.discard")}
              </button>
            )}
            <SaveAsNew />
          </div>
        ) : (
          ws.dirty && (
            <div className="qb-dirty" role="group" aria-label={t("queryBar.unsavedAria")}>
              <span className="qb-sep" />
              <button type="button" className="btn btn-secondary qb-save" style={{ padding: "5px 10px" }} onClick={ws.saveView}>
                {t("queryBar.saveView")}
              </button>
              <button type="button" className="btn btn-ghost qb-discard" style={{ padding: "5px 9px" }} onClick={ws.discardChanges}>
                {t("queryBar.discard")}
              </button>
              <SaveAsNew />
            </div>
          )
        )}
      </div>
    </div>
  );
}
