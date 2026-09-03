import { CHECKED, type FieldDef, type Item } from "@tomrade/domain";
import { Icon, type IconId } from "~/components/icons";
import { PriorityGlyph, ProvenanceMark, StatusMark, Tag } from "~/components/ui/atoms";
import { timeAgo } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "./context";

export interface CardProps {
  item: Item;
  onOpen: () => void;
  /** One column left or right, through the same write path as a drag. */
  onNudge: (direction: -1 | 1) => void;
  dragging?: boolean;
  dragHandleRef?: (node: HTMLElement | null) => void;
}

/** A custom field's value as the card prints it: option names for selects, a tick for a checkbox. */
function customValue(def: FieldDef, value: string | number, checked: string): string {
  if (def.type === "select") return def.options.find((o) => o.id === value)?.name ?? String(value);
  if (def.type === "checkbox") return value === CHECKED ? checked : String(value);
  return String(value);
}

/**
 * A card opens the issue in the pane beside the assistant, so it behaves as a
 * button. Dragging is a mouse affordance; ← → are the same write for anyone on
 * a keyboard, and the tooltip is where that gets discovered.
 */
export function Card({ item, onOpen, onNudge, dragging, dragHandleRef }: CardProps) {
  const { t } = useI18n();
  const { boards, query, epicNames, selectedId, badges, fieldById } = useWorkspace();
  const marks = badges[item.id] ?? [];
  const grouped = (fieldId: string) => query.columnBy === fieldId || query.groupBy === fieldId;
  // A filter pinned to one workstream already says which one every card is in.
  const pinnedBoard = query.filter.some((c) => c.field === "board" && c.op === "in" && c.values.filter((v) => v !== null).length === 1);
  const owner = !grouped("board") && !pinnedBoard ? boards.find((b) => b.id === item.boardId) : undefined;
  const epicName = item.parentId && !grouped("epic") ? epicNames.get(item.parentId) : undefined;
  const customs = query.fields
    .map((id) => fieldById.get(id))
    .filter((def): def is FieldDef => !!def && !def.builtin && item.fields[def.id] !== undefined);

  return (
    <div
      ref={dragHandleRef}
      className={`card${dragging ? " dragging" : ""}`}
      data-id={item.id}
      role="button"
      tabIndex={0}
      data-selected={item.id === selectedId}
      aria-keyshortcuts="ArrowLeft ArrowRight"
      title={t("card.keyboardHint")}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onNudge(e.key === "ArrowRight" ? 1 : -1);
        }
      }}
    >
      <span className="card-gutter">
        <ProvenanceMark item={item} />
      </span>
      <span className="card-body">
        <span className="card-meta">
          <StatusMark status={item.status} />
          <PriorityGlyph priority={item.priority} />
          <span className="card-id">{item.key}</span>
          {owner && (
            <span className="card-board" title={t("card.inWorkstream", { board: owner.name })}>
              <Icon name={owner.icon as IconId} size={11} />
              {owner.name}
            </span>
          )}
          <span className="card-date">{timeAgo(item.updatedAt)}</span>
        </span>
        <span className="card-title">{item.title}</span>
        {(epicName || item.labels.length > 0 || marks.length > 0 || customs.length > 0) && (
          <span className="card-foot">
            {epicName && <span className="card-epic">{epicName}</span>}
            {item.labels.map((l) => (
              <Tag key={l} tone="neutral">
                {l}
              </Tag>
            ))}
            {marks.map((b) => (
              <Tag key={b.id} tone={b.tone ?? "neutral"} title={b.title}>
                {b.label}
              </Tag>
            ))}
            {customs.map((def) => (
              <span className="card-field" key={def.id} data-field={def.id} title={def.name}>
                {def.name} · {customValue(def, item.fields[def.id], t("card.checked"))}
              </span>
            ))}
          </span>
        )}
      </span>
    </div>
  );
}
