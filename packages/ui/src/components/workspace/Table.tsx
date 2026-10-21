import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EMPTY_KEY, groupKeyOf, type FieldDef, type Item, type SortKey } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { BoardField, CustomField, DerivedField, EpicField, LabelsField, PriorityField, StatusField, useIssueWriter, type IssueWrite } from "~/components/issue/fields";
import { DEFAULT_SHOWN_FIELDS, PROVENANCE, agoLabel, fieldLabel, provenanceOf } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useCreateItem } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";
import { useIsSelected, useWorkspace, type WorkspaceValue } from "./context";
import { EpicPriority, EpicProgressBar, EpicStatus, EpicTitle, epicProgress } from "./EpicHeader";
import { mergePatch, seedFromFilter, toCreateInput } from "./patches";
import { useToastUndo } from "~/lib/undo";
import { isCommitKey } from "~/lib/keys";

/** What a table shows when the view has not chosen its fields. */

/** none → asc → desc → none, one key at a time: the header is the quick sort, the view panel the full one. */
function nextSort(current: SortKey[], fieldId: string): SortKey[] {
  const active = current.length === 1 && current[0].field === fieldId ? current[0] : null;
  if (!active) return [{ field: fieldId, dir: "asc" }];
  if (active.dir === "asc") return [{ field: fieldId, dir: "desc" }];
  return [];
}

function Cell({ item, def, ws, write }: { item: Item; def: FieldDef; ws: WorkspaceValue; write: IssueWrite }) {
  const prov = provenanceOf(item);
  switch (def.id) {
    case "status":
      return <StatusField item={item} write={write} />;
    case "priority":
      return <PriorityField item={item} write={write} />;
    case "epic":
      return <EpicField item={item} write={write} epics={ws.epics} />;
    case "board":
      return <BoardField item={item} write={write} boards={ws.boards} />;
    case "labels":
      return <LabelsField item={item} write={write} vocabulary={ws.labels} />;
    case "key":
      return <span className="num">{item.key}</span>;
    case "updated":
      return <span className="num tbl-dim">{agoLabel(item.updatedAt)}</span>;
    case "provenance":
      return (
        <span className="tbl-prov">
          {(prov === "ai" || prov === "sync") && <span className={prov === "sync" ? "prov-tick is-sync" : "prov-tick"} style={{ height: 12 }} />}
          {prov === "locked" && <Icon className="prov-lock" name="i-lock" size={12} />}
          <span className="num">{PROVENANCE[prov]}</span>
        </span>
      );
    default:
      return def.derived ? <DerivedField item={item} def={def} /> : def.builtin ? null : <CustomField item={item} write={write} def={def} />;
  }
}

function Row({ item, columns, ws, write }: { item: Item; columns: FieldDef[]; ws: WorkspaceValue; write: IssueWrite }) {
  const { t } = useI18n();
  const selected = useIsSelected(item.id);
  return (
    <tr className="tbl-row" data-id={item.id} data-selected={selected}>
      <td className="tbl-cell tbl-title-cell" data-field="title">
        <button type="button" className="tbl-title" title={t("table.openTitle")} onClick={() => ws.select(item.id)}>
          <span className="card-id">{item.key}</span>
          <span className="tbl-title-text">{item.title}</span>
        </button>
      </td>
      {columns.map((def) => (
        <td className="tbl-cell" key={def.id} data-field={def.id}>
          <Cell item={item} def={def} ws={ws} write={write} />
        </td>
      ))}
    </tr>
  );
}

/** A new issue typed at the foot lands on the workstream the filter pins, else the first. */
function ComposerRow({ span }: { span: number }) {
  const { t, tx } = useI18n();
  const ws = useWorkspace();
  const create = useCreateItem(ws.project.id);
  const undoWrite = useToastUndo(ws.project.id);
  const toast = useToast();
  const [editing, setEditing] = useState(false);

  const submit = (title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return setEditing(false);
    const input = toCreateInput(trimmed, mergePatch({}, seedFromFilter(ws.query, ws.fieldById)), ws.boards[0]?.id ?? "");
    if (!input) return setEditing(false);
    create.mutate(input, {
      onSuccess: (item) => {
        setEditing(false);
        toast({ body: <>{tx("table.createdToast", { key: <span className="num">{item.key}</span> })}</>, onUndo: () => undoWrite({ id: item.id, stamp: item.version }) });
      },
      onError: (err) => toast(errorSpec(err))
    });
  };

  return (
    <tr className="tbl-new">
      <td className="tbl-cell" colSpan={span}>
        {editing ? (
          <input
            autoFocus
            className="input tbl-new-input"
            placeholder={t("table.composerPlaceholder")}
            aria-label={t("table.newIssue")}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(false);
              }
              if (isCommitKey(e)) submit(e.currentTarget.value);
            }}
            onBlur={(e) => {
              if (!e.currentTarget.value.trim()) setEditing(false);
            }}
          />
        ) : (
          <button type="button" className="btn btn-ghost" style={{ justifyContent: "flex-start" }} onClick={() => setEditing(true)}>
            <Icon name="i-plus" size={13} /> {t("table.newIssue")}
          </button>
        )}
      </td>
    </tr>
  );
}

function EpicGroupRow({
  epic,
  label,
  count,
  progress,
  columns,
  collapsed,
  onToggle,
  onOpen,
  isNone
}: {
  epic: Item | undefined;
  label: string;
  count: number;
  progress: { done: number; total: number };
  columns: FieldDef[];
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
  isNone: boolean;
}) {
  return (
    <tr className={isNone ? "tbl-epic is-none" : "tbl-epic"} data-group={epic?.id ?? EMPTY_KEY} data-collapsed={collapsed}>
      <td className="tbl-cell tbl-title-cell" data-field="title">
        <EpicTitle epic={epic} label={label} count={count} collapsed={collapsed} onToggle={onToggle} onOpen={onOpen} />
        {epic && progress.total > 0 && <EpicProgressBar {...progress} />}
      </td>
      {columns.map((def) => (
        <td className="tbl-cell" key={def.id} data-field={def.id}>
          {epic && def.id === "status" && <EpicStatus epic={epic} />}
          {epic && def.id === "priority" && <EpicPriority epic={epic} />}
          {epic && def.id === "updated" && <span className="num tbl-dim">{agoLabel(epic.updatedAt)}</span>}
        </td>
      ))}
    </tr>
  );
}

/** The table layout: one row per visible issue, one column per shown field, headers that sort. */
export function Table({ onConflict }: { onConflict: (title: string) => void }) {
  void onConflict; // cell edits report conflicts through the issue writer's toast
  const { t } = useI18n();
  const ws = useWorkspace();
  const { query, visible, fieldById, groupSpace, groupLabel } = ws;
  const groupBy = query.groupBy;
  const { write } = useIssueWriter(ws.project.id);

  const columns = useMemo(() => {
    // grouped by epic, the column would only repeat the group head on every row
    const ids = (query.fields.length ? query.fields : DEFAULT_SHOWN_FIELDS.table).filter((id) => id !== "title" && fieldById.has(id) && !(id === "epic" && groupBy === "epic"));
    return ids.map((id) => fieldById.get(id)!);
  }, [query.fields, fieldById, groupBy]);

  const byEpic = groupBy === "epic";
  const epicById = useMemo(() => new Map(ws.epics.map((e) => [e.id, e])), [ws.epics]);
  const progress = useMemo(() => (byEpic ? epicProgress(ws.owned) : null), [byEpic, ws.owned]);
  const [shut, setShut] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setShut((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  // epic heads stick under the column header, so they need its height
  const headRef = useRef<HTMLTableSectionElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const head = headRef.current;
    if (!head || !byEpic) return;
    const ro = new ResizeObserver(() => wrapRef.current?.style.setProperty("--tbl-head-h", `${head.offsetHeight}px`));
    ro.observe(head);
    return () => ro.disconnect();
  }, [byEpic]);

  const sortOf = (fieldId: string): "asc" | "desc" | null => (query.sortBy.length === 1 && query.sortBy[0].field === fieldId ? query.sortBy[0].dir : null);

  const header = (def: FieldDef | null): ReactNode => {
    const id = def?.id ?? "title";
    const label = def ? fieldLabel(def) : t("table.titleHeader");
    const sortable = def ? def.can.sort : true;
    const dir = sortOf(id);
    if (!sortable) return <span className="tbl-th-label">{label}</span>;
    return (
      <button
        type="button"
        className="tbl-th-btn"
        data-sort={dir ?? undefined}
        title={t(dir === "asc" ? "table.sortDescTitle" : dir === "desc" ? "table.sortClearTitle" : "table.sortAscTitle", { field: label })}
        onClick={() => ws.setQuery({ ...query, sortBy: nextSort(query.sortBy, id) })}
      >
        <span className="tbl-th-label">{label}</span>
        {dir && <span className="tbl-sort num">{dir === "asc" ? "↑" : "↓"}</span>}
      </button>
    );
  };

  const groups = useMemo(() => {
    if (!groupBy) return [{ key: null as string | null, items: visible }];
    const buckets = new Map<string, Item[]>();
    for (const key of groupSpace(groupBy)) buckets.set(key, []);
    for (const item of visible) {
      const key = groupKeyOf(item, groupBy);
      (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(item);
    }
    return [...buckets.entries()].filter(([, items]) => items.length > 0).map(([key, items]) => ({ key, items }));
  }, [visible, groupBy, groupSpace]);

  const span = columns.length + 1;

  return (
    <div className="tbl-wrap" ref={wrapRef} data-group-by={groupBy ?? undefined}>
      <table className="tbl">
        <thead className="tbl-head" ref={headRef}>
          <tr>
            <th className="tbl-cell tbl-title-cell" scope="col" data-field="title" aria-sort={sortOf("title") === "asc" ? "ascending" : sortOf("title") === "desc" ? "descending" : "none"}>
              {header(null)}
            </th>
            {columns.map((def) => (
              <th
                className="tbl-cell"
                scope="col"
                key={def.id}
                data-field={def.id}
                aria-sort={sortOf(def.id) === "asc" ? "ascending" : sortOf(def.id) === "desc" ? "descending" : def.can.sort ? "none" : undefined}
              >
                {header(def)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <Fragment key={group.key ?? "all"}>
              {group.key !== null && byEpic && (
                <EpicGroupRow
                  epic={epicById.get(group.key)}
                  label={groupLabel("epic", group.key)}
                  count={group.items.length}
                  progress={progress?.get(group.key) ?? { done: 0, total: 0 }}
                  columns={columns}
                  collapsed={shut.has(group.key)}
                  onToggle={() => toggle(group.key!)}
                  onOpen={ws.select}
                  isNone={group.key === EMPTY_KEY}
                />
              )}
              {group.key !== null && groupBy && !byEpic && (
                <tr className="tbl-group" data-group={group.key}>
                  <td className="tbl-cell" colSpan={span}>
                    <span className="tbl-group-name">{groupLabel(groupBy, group.key)}</span>
                    <span className="tbl-group-count num">{group.items.length}</span>
                  </td>
                </tr>
              )}
              {!(group.key !== null && shut.has(group.key)) && group.items.map((item) => (
                <Row key={item.id} item={item} columns={columns} ws={ws} write={write} />
              ))}
            </Fragment>
          ))}
          {visible.length === 0 && (
            <tr className="tbl-empty">
              <td className="tbl-cell col-empty" colSpan={span}>
                {ws.search.trim() ? t("table.emptySearch", { query: ws.search.trim() }) : t(ws.filterCount ? "table.emptyFiltered" : "table.emptyPlain")}
              </td>
            </tr>
          )}
          <ComposerRow span={span} />
        </tbody>
      </table>
    </div>
  );
}
