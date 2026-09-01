import { useState, type ReactNode } from "react";
import type { Item, Priority, Provenance, ViewKind } from "@tomrade/domain";
import { Icon, type IconId } from "~/components/icons";
import { Menu, MenuCheckItem, MenuEmpty, MenuFoot, MenuHead } from "~/components/ui/menu";
import { PriorityGlyph } from "~/components/ui/atoms";
import { PRIORITIES, PRIORITY_LABEL, PROVENANCE, VIEW_KINDS, provenanceOf, type BoardQuery } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useWorkspace } from "./context";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

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
function getFacets(t: T): Facet[] {
  return [
    {
      key: "labels",
      name: t("queryBar.labelName"),
      icon: "i-tag",
      empty: t("queryBar.labelEmpty"),
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
      name: t("queryBar.epicName"),
      icon: "i-stack",
      empty: t("queryBar.epicEmpty"),
      show: (v, ws) => (v === "none" ? t("queryBar.noEpicLower") : (ws.epicNames.get(v) ?? t("queryBar.epicFallback"))),
      options: (owned, ws) => {
        const rows = ws.epics
          .map((e) => ({ value: e.id, name: e.title, count: owned.filter((i) => i.parentId === e.id).length, mark: <Icon name="i-stack" size={11} /> }))
          .filter((r) => r.count > 0);
        const loose = owned.filter((i) => !i.parentId).length;
        if (loose) rows.push({ value: "none", name: t("queryBar.noEpicOption"), count: loose, mark: <></> });
        return rows;
      }
    },
    {
      key: "priorities",
      name: t("queryBar.priorityName"),
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
      name: t("queryBar.lastWriteName"),
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
}

const selectionOf = (q: BoardQuery, key: Facet["key"]): string[] =>
  key === "priorities" ? q.priorities.map(String) : (q[key] as string[]);

function withSelection(q: BoardQuery, key: Facet["key"], values: string[]): BoardQuery {
  if (key === "priorities") return { ...q, priorities: values.map(Number) as Priority[] };
  if (key === "provenance") return { ...q, provenance: values as Provenance[] };
  return { ...q, [key]: values };
}

function FacetButton({ facet }: { facet: Facet }) {
  const { t, tx } = useI18n();
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
          title={
            selected.length
              ? t("queryBar.facetSelectedTitle", { name: facet.name, list: selected.map((v) => facet.show(v, ws)).join(", ") })
              : t("queryBar.filterByGeneric", { name: facet.name.toLowerCase() })
          }
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
      <MenuHead title={facet.name} aside={selected.length ? tx("queryBar.selectedCount", { n: <span className="num">{selected.length}</span> }) : undefined} />
      {options.length === 0 ? (
        <MenuEmpty>{facet.empty || t("queryBar.nothingToFilterGeneric")}</MenuEmpty>
      ) : (
        options.map((o) => (
          <MenuCheckItem key={o.value} checked={selected.includes(o.value)} onToggle={() => toggle(o.value)} mark={o.mark} name={o.name} count={o.count} />
        ))
      )}
      {selected.length > 0 && (
        <MenuFoot>
          <button type="button" className="btn btn-ghost" style={{ padding: "4px 8px" }} onClick={() => ws.setQuery(withSelection(ws.query, facet.key, []))}>
            {t("queryBar.clearFacet", { name: facet.name.toLowerCase() })}
          </button>
        </MenuFoot>
      )}
    </Menu>
  );
}

export function QueryBar({ onOpenViewSettings }: { onOpenViewSettings: () => void }) {
  const { t } = useI18n();
  const ws = useWorkspace();
  const facets = getFacets(t);

  /** Switching kind is real navigation: each of the four built-in views loads its own saved columns/WIP. */
  const switchKind = (kind: ViewKind) => {
    if (kind === ws.view.kind) return;
    const target = ws.boardViews.find((v) => v.kind === kind);
    if (target) ws.openSpace(ws.board.id, target.id);
  };

  return (
    <div className="query-bar">
      {facets.map((f) => (
        <FacetButton key={f.key} facet={f} />
      ))}

      <div className="qb-right">
        <div className="seg quiet" role="group" aria-label={t("queryBar.groupColumnsByAria")}>
          {(Object.keys(VIEW_KINDS) as ViewKind[]).map((k) => (
            <button
              key={k}
              type="button"
              className={k === "dependencies" ? "seg-graph" : undefined}
              aria-pressed={ws.view.kind === k}
              title={k === "dependencies" ? t("queryBar.dependenciesTitle") : t("queryBar.oneColumnPerTitle", { group: VIEW_KINDS[k].label.toLowerCase() })}
              onClick={() => switchKind(k)}
            >
              <Icon className="ico" name={VIEW_KINDS[k].icon} size={13} />
              <span className="seg-lbl">{VIEW_KINDS[k].label}</span>
            </button>
          ))}
        </div>
        {/* the dependencies view is a graph canvas — it has no columns/WIP to configure */}
        {ws.view.kind !== "dependencies" && (
          <button type="button" className="btn btn-ghost" style={{ padding: "5px 9px" }} title={t("queryBar.viewSettingsTitle")} onClick={onOpenViewSettings}>
            <Icon name="i-sliders" size={14} /> <span className="lbl">{t("queryBar.viewSettings")}</span>
          </button>
        )}
      </div>
    </div>
  );
}
