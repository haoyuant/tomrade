import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { FilterClause, Item } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "./context";
import { EpicPriority, EpicProgressBar, EpicStatus, type EpicProgress, ProgressRing } from "./EpicHeader";

const PEEK_ID = "epic-strip-peek";
const PEEK_WIDTH = 320;

/**
 * Which epics the board holds, without grouping it: one chip per epic with
 * open tickets. Hovering one fades the cards outside it; clicking one is the
 * same epic filter the query bar writes.
 */
export function EpicStrip() {
  const { t } = useI18n();
  const ws = useWorkspace();
  const [hover, setHover] = useState<{ id: string; at: DOMRect } | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  const progress = ws.epicProgress;

  const at = ws.query.filter.findIndex((c) => c.field === "epic" && c.op === "in");
  const chosen = new Set((at >= 0 ? ws.query.filter[at].values : []).filter((v): v is string => typeof v === "string"));

  const epics = ws.epics;
  const { open, finished } = useMemo(() => {
    const open: typeof epics = [];
    const finished: typeof epics = [];
    for (const epic of epics) {
      const p = progress.get(epic.id);
      if (!p || p.total === 0) continue;
      (p.done < p.total ? open : finished).push(epic);
    }
    return { open, finished };
  }, [epics, progress]);

  if (open.length + finished.length === 0) return null;

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (!next.delete(id)) next.add(id);
    const filter = [...ws.query.filter];
    const clause: FilterClause = { field: "epic", op: "in", values: [...next] };
    if (at >= 0) {
      if (next.size) filter[at] = clause;
      else filter.splice(at, 1);
    } else filter.push(clause);
    ws.setQuery({ ...ws.query, filter });
  };

  const shown = [...open, ...(showFinished ? finished : finished.filter((e) => chosen.has(e.id)))];
  const hidden = finished.length - (showFinished ? finished.length : finished.filter((e) => chosen.has(e.id)).length);

  return (
    <div className="epic-strip" role="toolbar" aria-label={t("epics.stripAria")}>
      {/* Faded by attribute, so hovering re-renders this strip and not the board. */}
      {hover && <style>{`.board-region .card:not([data-epic="${CSS.escape(hover.id)}"]) { opacity: 0.32; }`}</style>}
      <span className="epic-strip-label">
        <Icon name="i-stack" size={12} />
        {t("epics.stripLabel")}
      </span>
      {shown.map((epic) => {
        const p = progress.get(epic.id)!;
        const on = chosen.has(epic.id);
        return (
          <button
            type="button"
            key={epic.id}
            className="epic-chip"
            data-on={on}
            aria-pressed={on}
            aria-describedby={hover?.id === epic.id ? PEEK_ID : undefined}
            onClick={() => toggle(epic.id)}
            onMouseEnter={(e) => setHover({ id: epic.id, at: e.currentTarget.getBoundingClientRect() })}
            onMouseLeave={() => setHover(null)}
            onFocus={(e) => setHover({ id: epic.id, at: e.currentTarget.getBoundingClientRect() })}
            onBlur={() => setHover(null)}
          >
            <ProgressRing done={p.done} total={p.total} />
            <span className="epic-chip-name">{epic.title}</span>
            <span className="epic-chip-n num">{t("epics.progressShort", { done: String(p.done), total: String(p.total) })}</span>
          </button>
        );
      })}
      {(hidden > 0 || showFinished) && finished.length > 0 && (
        <button type="button" className="epic-chip epic-chip-more" onClick={() => setShowFinished((v) => !v)}>
          {showFinished ? t("epics.fewer") : t("epics.more", { n: String(hidden) })}
        </button>
      )}
      {hover &&
        (() => {
          const epic = epics.find((e) => e.id === hover.id);
          const p = progress.get(hover.id);
          return epic && p ? <EpicPeek epic={epic} progress={p} at={hover.at} on={chosen.has(epic.id)} /> : null;
        })()}
    </div>
  );
}

/** The opening lines of a description as plain text, for a glance. */
function excerpt(body: string | null): string {
  if (!body) return "";
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^(#|---|```|\|)/.test(line))
    .map((line) => line.replace(/^([-*>]|\d+\.)\s+/, "").replace(/[*_`]/g, ""))
    .join(" ")
    .slice(0, 240);
}

/** What a chip stands for, at a glance: the strip scrolls sideways, so the card floats over the page instead of inside it. */
function EpicPeek({ epic, progress, at, on }: { epic: Item; progress: EpicProgress; at: DOMRect; on: boolean }) {
  const { t } = useI18n();
  const left = Math.max(8, Math.min(at.left, window.innerWidth - PEEK_WIDTH - 8));
  const text = excerpt(epic.body);
  return createPortal(
    <div id={PEEK_ID} className="epic-peek" role="tooltip" style={{ top: at.bottom + 6, left, width: PEEK_WIDTH }}>
      <div className="epic-peek-head">
        <Icon className="epic-glyph" name="i-stack" size={13} />
        <span className="card-id">{epic.key}</span>
        <EpicStatus epic={epic} />
        <EpicPriority epic={epic} />
      </div>
      <div className="epic-peek-title">{epic.title}</div>
      {text && <div className="epic-peek-body">{text}</div>}
      <EpicProgressBar done={progress.done} total={progress.total} />
      <div className="epic-peek-foot">{t(on ? "epics.filterOff" : "epics.filterOn", { name: epic.key })}</div>
    </div>,
    document.body
  );
}
