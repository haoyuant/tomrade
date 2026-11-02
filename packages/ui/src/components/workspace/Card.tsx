import { memo, useCallback, useRef, type CSSProperties } from "react";
import { CHECKED, type Board, type FieldDef, type Item } from "@tomradex/domain";
import type { Badge } from "@tomradex/contributions";
import { Icon, type IconId } from "~/components/icons";
import { PriorityGlyph, ProvenanceMark, StatusMark, Tag } from "~/components/ui/atoms";
import { timeAgo } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useIsSelected, useWorkspace } from "./context";
import { isCommitKey } from "~/lib/keys";
import { useStartingFor } from "~/lib/startWays";
import { formatChord } from "~/lib/keybindings";

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
 * The card a key press moves to: ↑ ↓ within the column, ← → to the nearest
 * card at about the same height in the next column that has any.
 */
function cardBeside(from: HTMLElement, key: string): HTMLElement | null {
  const body = from.closest<HTMLElement>(".col-body");
  if (!body) return null;
  const inBody = (b: Element) => [...b.querySelectorAll<HTMLElement>(".card")];
  const cards = inBody(body);
  const at = cards.indexOf(from);
  if (key === "ArrowUp" || key === "ArrowDown") return cards[at + (key === "ArrowDown" ? 1 : -1)] ?? null;
  const bodies = [...(from.closest(".col-track, .lane-cols") ?? document).querySelectorAll<HTMLElement>(".col-body")];
  const step = key === "ArrowRight" ? 1 : -1;
  for (let i = bodies.indexOf(body) + step; i >= 0 && i < bodies.length; i += step) {
    const there = inBody(bodies[i]);
    if (there.length) return there[Math.min(at, there.length - 1)];
  }
  return null;
}

const NO_MARKS: Badge[] = [];

/**
 * A card opens the issue in the pane beside the assistant, so it behaves as a
 * button. Arrow keys move between cards; dragging is a mouse affordance, and
 * ⌥← ⌥→ are the same write for anyone on a keyboard — the tooltip is where
 * that gets discovered.
 *
 * It reads the workspace and hands the face only what this card shows, so a
 * write to one ticket, a search or a selection repaints the cards it changed
 * and no others.
 */
export function Card(props: CardProps) {
  const { item } = props;
  const { boards, query, epicNames, epicHues, badges, fieldById } = useWorkspace();
  const selected = useIsSelected(item.id);
  // a start under way from its page or ⌘K: read from memory, no query per card
  const starting = useStartingFor(item.id);
  // The latest handlers, behind callbacks that stay the same: the face is kept across renders.
  const handlers = useRef(props);
  handlers.current = props;
  const onOpen = useCallback(() => handlers.current.onOpen(), []);
  const onNudge = useCallback((direction: -1 | 1) => handlers.current.onNudge(direction), []);
  const grouped = (fieldId: string) => query.columnBy === fieldId || query.groupBy === fieldId;
  // A filter pinned to one workstream already says which one every card is in.
  const pinnedBoard = query.filter.some((c) => c.field === "board" && c.op === "in" && c.values.filter((v) => v !== null).length === 1);
  return (
    <CardFace
      item={item}
      selected={selected}
      dragging={!!props.dragging}
      dragHandleRef={props.dragHandleRef}
      marks={badges[item.id] ?? NO_MARKS}
      starting={starting?.agent ?? null}
      owner={!grouped("board") && !pinnedBoard ? boards.find((b) => b.id === item.boardId) : undefined}
      epicName={item.parentId && !grouped("epic") ? epicNames.get(item.parentId) : undefined}
      epicHue={item.parentId ? epicHues.get(item.parentId) : undefined}
      fields={query.fields}
      fieldById={fieldById}
      onOpen={onOpen}
      onNudge={onNudge}
    />
  );
}

const CardFace = memo(function CardFace({
  item,
  selected,
  dragging,
  dragHandleRef,
  marks,
  starting,
  owner,
  epicName,
  epicHue,
  fields,
  fieldById,
  onOpen,
  onNudge
}: {
  item: Item;
  selected: boolean;
  dragging: boolean;
  dragHandleRef?: (node: HTMLElement | null) => void;
  marks: Badge[];
  /** The agent a start under way runs, until its session is up. */
  starting: string | null;
  owner: Board | undefined;
  epicName: string | undefined;
  epicHue: number | undefined;
  fields: string[];
  fieldById: Map<string, FieldDef>;
  onOpen: () => void;
  onNudge: (direction: -1 | 1) => void;
}) {
  const { t } = useI18n();
  const customs = fields.map((id) => fieldById.get(id)).filter((def): def is FieldDef => !!def && !def.builtin && item.fields[def.id] !== undefined);
  // the session at work on it comes as code link's badge, said as a line of its own rather than a tag
  const session = marks.find((b) => b.id === "session");
  const tags = session ? marks.filter((b) => b !== session) : marks;

  return (
    <div
      ref={dragHandleRef}
      className={`card${dragging ? " dragging" : ""}`}
      data-id={item.id}
      data-epic={item.parentId ?? undefined}
      role="button"
      tabIndex={0}
      data-selected={selected}
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
      title={t("card.keyboardHint", { left: formatChord("Alt+ArrowLeft"), right: formatChord("Alt+ArrowRight") })}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (isCommitKey(e) || e.key === " ") {
          e.preventDefault();
          onOpen();
          // opened from the keyboard, the reading goes on in the pane
          requestAnimationFrame(() => document.querySelector<HTMLElement>("aside.detail")?.focus());
        } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          e.preventDefault();
          onNudge(e.key === "ArrowRight" ? 1 : -1);
        } else if (e.key.startsWith("Arrow") && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          cardBeside(e.currentTarget, e.key)?.focus();
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
        {starting ? (
          <span className="card-starting" role="status">
            <span className="start-starting-mark" aria-hidden="true" />
            {t("codeLink.startingLine", { agent: starting })}
          </span>
        ) : session && (
          <span className="card-session" data-testid="card-session" title={session.title}>
            <span className="card-session-mark" aria-hidden="true" />
            <span className="card-session-label">{session.label}</span>
          </span>
        )}
        {(epicName || item.labels.length > 0 || tags.length > 0 || customs.length > 0) && (
          <span className="card-foot">
            {epicName && (
              <span className="tag card-epic" title={epicName} style={epicHue === undefined ? undefined : ({ "--epic-hue": epicHue } as CSSProperties)}>
                <Icon name="i-stack" size={11} aria-hidden />
                <span className="card-epic-name">{epicName}</span>
              </span>
            )}
            {item.labels.map((l) => (
              <Tag key={l} tone="neutral">
                {l}
              </Tag>
            ))}
            {tags.map((b) => (
              <Tag key={b.id} tone={b.tone ?? "neutral"} title={b.title}>
                {/* the dependency plugin's one word, said in the person's language */}
                {b.id === "blocked" ? t("card.blockedBadge") : b.label}
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
});
