import type { Item } from "@tomrade/domain";
import { Icon, type IconId } from "~/components/icons";
import { PriorityGlyph, ProvenanceMark, StatusMark, Tag } from "~/components/ui/atoms";
import { timeAgo } from "~/lib/domain";
import { useWorkspace } from "./context";

export interface CardProps {
  item: Item;
  onOpen: () => void;
  /** One column left or right, through the same write path as a drag. */
  onNudge: (direction: -1 | 1) => void;
  dragging?: boolean;
  dragHandleRef?: (node: HTMLElement | null) => void;
}

/**
 * A card opens the issue in the pane beside the assistant, so it behaves as a
 * button. Dragging is a mouse affordance; ← → are the same write for anyone on
 * a keyboard, and the tooltip is where that gets discovered.
 */
export function Card({ item, onOpen, onNudge, dragging, dragHandleRef }: CardProps) {
  const { board, boards, query, epicNames, selectedId, badges } = useWorkspace();
  const marks = badges[item.id] ?? [];
  const owner = board.across ? boards.find((b) => b.id === item.boardId) : undefined;
  const epicName = item.parentId && query.group !== "epic" ? epicNames.get(item.parentId) : undefined;

  return (
    <div
      ref={dragHandleRef}
      className={`card${dragging ? " dragging" : ""}`}
      data-id={item.id}
      role="button"
      tabIndex={0}
      data-selected={item.id === selectedId}
      aria-keyshortcuts="ArrowLeft ArrowRight"
      title="Enter to open · ← → to move column"
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
            <span className="card-board" title={`Owned by the ${owner.name} board`}>
              <Icon name={owner.icon as IconId} size={11} />
              {owner.name}
            </span>
          )}
          <span className="card-date">{timeAgo(item.updatedAt)}</span>
        </span>
        <span className="card-title">{item.title}</span>
        {(epicName || item.labels.length > 0 || marks.length > 0) && (
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
          </span>
        )}
      </span>
    </div>
  );
}
