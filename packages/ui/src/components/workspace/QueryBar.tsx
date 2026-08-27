import { useState, type ReactNode } from "react";
import type { GroupBy, Item, Priority, Provenance } from "@tomrade/domain";
import { Icon, type IconId } from "~/components/icons";
import { Menu, MenuCheckItem, MenuEmpty, MenuFoot, MenuHead } from "~/components/ui/menu";
import { PriorityGlyph } from "~/components/ui/atoms";
import {
  GROUPS,
  PRIORITIES,
  PRIORITY_LABEL,
  PROVENANCE,
  filterFromQuery,
  provenanceOf,
  queryWithGroup,
  type BoardQuery
} from "~/lib/domain";
import { useCreateView, useUpdateView } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { useWorkspace } from "./context";

interface Option {
  value: string;
  name: string;
  count: number;
  mark?: ReactNode;
}

interface Facet {
  key: "labels" | "epics" | "priorities" | "provenance";
  name: string;
  icon: IconId;
  empty: string;
  options: (owned: Item[], ws: ReturnType<typeof useWorkspace>) => Option[];
  show: (value: string, ws: ReturnType<typeof useWorkspace>) => string;
}

/** Every option carries the count it resolves to, so the menu never offers a
 *  filter without saying what it will leave on screen. */
const FACETS: Facet[] = [
  {
    key: "labels",
    name: "Label",
    icon: "i-tag",
    empty: "Nothing on this board carries a label yet.",
    show: (v) => v,
    options: (owned) => {
      const names = [...new Set(owned.flatMap((i) => i.labels))].sort();
      return names.map((name) => ({
        value: name,
        name,
        count: owned.filter((i) => i.labels.includes(name)).length,
        mark: <Icon name="i-tag" size={11} />
      }));
    }
  },
  {
    key: "epics",
    name: "Epic",
    icon: "i-stack",
    empty: "Nothing on this board is linked to an epic.",
    show: (v, ws) => (v === "none" ? "no epic" : (ws.epicNames.get(v) ?? "epic")),
    options: (owned, ws) => {
      const rows = ws.epics
        .map((e) => ({ value: e.id, name: e.title, count: owned.filter((i) => i.parentId === e.id).length, mark: <Icon name="i-stack" size={11} /> }))
        .filter((r) => r.count > 0);
      const loose = owned.filter((i) => !i.parentId).length;
      if (loose) rows.push({ value: "none", name: "No epic", count: loose, mark: <></> });
      return rows;
    }
  },
  {
    key: "priorities",
    name: "Priority",
    icon: "i-bars",
    empty: "",
    show: (v) => PRIORITY_LABEL[Number(v) as Priority],
    options: (owned) =>
      [...PRIORITIES]
        .reverse()
        .map((p) => ({ value: String(p), name: PRIORITY_LABEL[p], count: owned.filter((i) => i.priority === p).length, mark: <PriorityGlyph priority={p} always /> }))
        .filter((r) => r.count > 0)
  },
  {
    key: "provenance",
    name: "Last write",
    icon: "i-pen",
    empty: "",
    show: (v) => PROVENANCE[v as Provenance],
    options: (owned) =>
      (["ai", "human", "locked"] as Provenance[])
        .map((p) => ({
          value: p,
          name: PROVENANCE[p],
          count: owned.filter((i) => provenanceOf(i) === p).length,
          mark: p === "ai" ? <span className="prov-tick" style={{ height: 11 }} /> : p === "locked" ? <Icon className="prov-lock" name="i-lock" size={12} style={{ margin: 0 }} /> : undefined
        }))
        .filter((r) => r.count > 0)
  }
];

const selectionOf = (q: BoardQuery, key: Facet["key"]): string[] =>
  key === "priorities" ? q.priorities.map(String) : (q[key] as string[]);

function withSelection(q: BoardQuery, key: Facet["key"], values: string[]): BoardQuery {
  if (key === "priorities") return { ...q, priorities: values.map(Number) as Priority[] };
  if (key === "provenance") return { ...q, provenance: values as Provenance[] };
  return { ...q, [key]: values };
}

function FacetButton({ facet }: { facet: Facet }) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const selected = selectionOf(ws.query, facet.key);
  const options = facet.options(ws.owned, ws);

  const toggle = (value: string) =>
    ws.setQuery(withSelection(ws.query, facet.key, selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]));

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label={facet.name}
      trigger={
        <button
          type="button"
          className="qb-btn"
          data-on={selected.length > 0}
          title={selected.length ? `${facet.name}: ${selected.map((v) => facet.show(v, ws)).join(", ")}` : `Filter by ${facet.name.toLowerCase()}`}
        >
          <Icon className="ico" name={facet.icon} size={13} />
          <span>{facet.name}</span>
          {selected.length > 0 && (
            <span className="qb-val">
              {facet.show(selected[0], ws)}
              {selected.length > 1 ? ` +${selected.length - 1}` : ""}
            </span>
          )}
          <Icon className="chev" name="i-chevdown" size={12} />
        </button>
      }
    >
      <MenuHead title={facet.name} aside={selected.length ? <><span className="num">{selected.length}</span> selected</> : undefined} />
      {options.length === 0 ? (
        <MenuEmpty>{facet.empty || "Nothing to filter by on this board."}</MenuEmpty>
      ) : (
        options.map((o) => (
          <MenuCheckItem key={o.value} checked={selected.includes(o.value)} onToggle={() => toggle(o.value)} mark={o.mark} name={o.name} count={o.count} />
        ))
      )}
      {selected.length > 0 && (
        <MenuFoot>
          <button type="button" className="btn btn-ghost" style={{ padding: "4px 8px" }} onClick={() => ws.setQuery(withSelection(ws.query, facet.key, []))}>
            Clear {facet.name.toLowerCase()}
          </button>
        </MenuFoot>
      )}
    </Menu>
  );
}

export function QueryBar({ onOpenViewSettings }: { onOpenViewSettings: () => void }) {
  const ws = useWorkspace();
  const updateView = useUpdateView(ws.project.id);
  const createView = useCreateView(ws.project.id);
  const toast = useToast();

  const epicColumns = [...ws.epics.map((e) => e.id), "none"];
  const setGroup = (group: GroupBy) => ws.setQuery(queryWithGroup(ws.query, group, ws.savedQuery, epicColumns));

  const saveToView = () => {
    updateView.mutate({
      id: ws.view.id,
      patch: { groupBy: ws.query.group, columns: ws.query.columns, wip: ws.query.wip, filter: filterFromQuery(ws.query) }
    });
    toast({ body: <>Saved <span className="num">{ws.view.name}</span> on {ws.board.name}</> });
  };

  const newView = () => {
    createView.mutate(
      {
        boardId: ws.board.id,
        name: "New view",
        icon: "i-filter",
        groupBy: ws.query.group,
        columns: ws.query.columns,
        wip: ws.query.wip,
        filter: filterFromQuery(ws.query)
      },
      { onSuccess: (view) => ws.openSpace(ws.board.id, view.id) }
    );
  };

  return (
    <div className="query-bar">
      {FACETS.map((f) => (
        <FacetButton key={f.key} facet={f} />
      ))}

      {/* the saved view and the live query have drifted apart — say so, and offer both ways out */}
      {ws.dirty && (
        <>
          <span className="qb-sep" />
          <button type="button" className="btn btn-secondary" style={{ padding: "5px 9px" }} title={`Write these filters and this grouping into “${ws.view.name}”`} onClick={saveToView}>
            <Icon name="i-check" size={13} /> <span className="lbl">Save to view</span>
          </button>
          <button type="button" className="btn btn-ghost" style={{ padding: "5px 9px" }} title={`Back to the saved “${ws.view.name}” view`} onClick={() => ws.setQuery(ws.savedQuery)}>
            Reset
          </button>
        </>
      )}

      <div className="qb-right">
        <div className="seg quiet" role="group" aria-label="Group columns by">
          {(Object.keys(GROUPS) as GroupBy[]).map((g) => (
            <button key={g} type="button" aria-pressed={ws.query.group === g} title={`One column per ${GROUPS[g].label.toLowerCase()}`} onClick={() => setGroup(g)}>
              <Icon className="ico" name={GROUPS[g].icon} size={13} />
              <span className="seg-lbl">{GROUPS[g].label}</span>
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-ghost" style={{ padding: "5px 9px" }} title="Save the filters and grouping above as a new view of this board" onClick={newView}>
          <Icon name="i-plus" size={14} /> <span className="lbl">New view</span>
        </button>
        <button type="button" className="btn btn-ghost" style={{ padding: "5px 9px" }} title="Which columns this view shows, and their WIP limits" onClick={onOpenViewSettings}>
          <Icon name="i-sliders" size={14} /> <span className="lbl">Columns</span>
        </button>
      </div>
    </div>
  );
}
