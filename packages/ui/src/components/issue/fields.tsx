import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Board, Item, ItemStatus, Patch, Priority } from "@tomrade/domain";
import { Icon } from "~/components/icons";
import { PriorityGlyph, StatusMark } from "~/components/ui/atoms";
import { PRIORITIES, PRIORITY_LABEL, STATUS, STATUS_KEYS } from "~/lib/domain";
import { usePatchItem, useUndo } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { cn } from "~/lib/utils";

/**
 * One write path for every editable field on an issue, shared by the docked
 * detail pane, the expanded overlay and the standalone sheet.
 *
 * Every edit asserts the version it read, so a field the user reaches for
 * while an agent is writing is refused rather than merged — and the refusal
 * says so. `usePatchItem` re-fetches on settle either way, so the retry is
 * made against a fresh version instead of the stale one that was just refused.
 */
export type IssueWrite = (item: Item, patch: Patch, said: ReactNode) => void;

export function useIssueWriter(projectId: string): { write: IssueWrite; pending: boolean } {
  const patch = usePatchItem(projectId);
  const undo = useUndo(projectId);
  const toast = useToast();

  const write = useCallback<IssueWrite>(
    (item, next, said) => {
      patch.mutate(
        { id: item.id, patch: next, baseVersion: item.version },
        {
          onSuccess: () => toast({ body: said, onUndo: () => undo.mutate(item.id) }),
          // react-query swallows the rejection otherwise, and a refused edit
          // that says nothing reads as an edit that silently did not happen
          onError: (err) =>
            toast({
              body: /conflict/i.test(err.message) ? (
                <>
                  An agent wrote to <span className="num">{item.key}</span> first — it re-read, so try again.
                </>
              ) : (
                err.message
              )
            })
        }
      );
    },
    [patch, toast, undo]
  );

  return { write, pending: patch.isPending };
}

export interface FieldProps {
  item: Item;
  write: IssueWrite;
}

/**
 * An editable enum reads as its own value and only looks like a control when
 * reached for. A native `<select>` is deliberate: the field strip renders
 * inside a Radix dialog when the pane is expanded, and an OS menu neither
 * fights that focus trap nor gets clipped by the overlay's rounded corners.
 */
function Picker({
  label,
  value,
  mark,
  options,
  onPick
}: {
  label: string;
  value: string;
  mark?: ReactNode;
  options: { value: string; name: string }[];
  onPick: (value: string) => void;
}) {
  return (
    <span className="fset">
      {mark}
      <select className="fsel" aria-label={label} value={value} onChange={(e) => onPick(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.name}
          </option>
        ))}
      </select>
      <Icon className="fchev" name="i-chevdown" size={11} aria-hidden />
    </span>
  );
}

export function StatusField({ item, write }: FieldProps) {
  return (
    <Picker
      label="Status"
      value={item.status}
      mark={<StatusMark status={item.status} size={13} />}
      options={STATUS_KEYS.map((s) => ({ value: s, name: STATUS[s].label }))}
      onPick={(v) => {
        const next = v as ItemStatus;
        if (next === item.status) return;
        write(item, { status: next }, <>Moved <span className="num">{item.key}</span> to {STATUS[next].label}</>);
      }}
    />
  );
}

export function PriorityField({ item, write }: FieldProps) {
  return (
    <Picker
      label="Priority"
      value={String(item.priority)}
      mark={<PriorityGlyph priority={item.priority} size={13} always />}
      options={PRIORITIES.map((p) => ({ value: String(p), name: PRIORITY_LABEL[p] }))}
      onPick={(v) => {
        const next = Number(v) as Priority;
        if (next === item.priority) return;
        write(item, { priority: next }, <>Set <span className="num">{item.key}</span> to {PRIORITY_LABEL[next]} priority</>);
      }}
    />
  );
}

/** Epics are items, so the option value is an item id and "" means unparented. */
export function EpicField({ item, write, epics }: FieldProps & { epics: Item[] }) {
  const candidates = epics.filter((e) => e.id !== item.id);
  return (
    <Picker
      label="Parent epic"
      value={item.parentId ?? ""}
      mark={item.parentId ? <Icon name="i-stack" size={12} style={{ color: "var(--meta)" }} /> : undefined}
      options={[
        { value: "", name: "None" },
        ...candidates.map((e) => ({ value: e.id, name: e.title })),
        // an epic deleted out from under us, or one this project cannot list
        ...(item.parentId && !candidates.some((e) => e.id === item.parentId) ? [{ value: item.parentId, name: "Epic" }] : [])
      ]}
      onPick={(v) => {
        const next = v || null;
        if (next === item.parentId) return;
        const name = candidates.find((e) => e.id === next)?.title;
        write(item, { parentId: next }, next ? <>Linked <span className="num">{item.key}</span> to {name ?? "its epic"}</> : <>Unlinked <span className="num">{item.key}</span> from its epic</>);
      }}
    />
  );
}

/**
 * The owning board, not a view: an issue belongs to exactly one workstream and
 * a cross-board scope owns nothing, so scopes are never offered as a target.
 */
export function BoardField({ item, write, boards }: FieldProps & { boards: Board[] }) {
  const workstreams = boards.filter((b) => !b.across);
  return (
    <Picker
      label="Board"
      value={item.boardId}
      options={
        workstreams.some((b) => b.id === item.boardId)
          ? workstreams.map((b) => ({ value: b.id, name: b.name }))
          : [{ value: item.boardId, name: "Board" }, ...workstreams.map((b) => ({ value: b.id, name: b.name }))]
      }
      onPick={(v) => {
        if (v === item.boardId) return;
        const name = workstreams.find((b) => b.id === v)?.name ?? "another board";
        write(item, { boardId: v }, <>Moved <span className="num">{item.key}</span> to {name}</>);
      }}
    />
  );
}

/**
 * Labels are a free vocabulary — the repository creates any name it has not
 * seen — so the field offers what the project already uses without refusing
 * anything new.
 */
export function LabelsField({ item, write, vocabulary }: FieldProps & { vocabulary: string[] }) {
  const listId = useId();
  const [adding, setAdding] = useState(false);
  // Enter unmounts the input, and an unmount can still blur — `item` is a
  // closure over the pre-write issue, so a second add would not see the label
  // it just wrote and would write it again.
  const settled = useRef(false);
  const unused = vocabulary.filter((v) => !item.labels.includes(v));

  const add = (raw: string) => {
    setAdding(false);
    if (settled.current) return;
    settled.current = true;
    const name = raw.trim();
    if (!name || item.labels.includes(name)) return;
    write(item, { labels: [...item.labels, name].sort() }, <>Added <b>{name}</b> to <span className="num">{item.key}</span></>);
  };

  const remove = (name: string) =>
    write(item, { labels: item.labels.filter((l) => l !== name) }, <>Removed <b>{name}</b> from <span className="num">{item.key}</span></>);

  return (
    <span className="labset">
      {item.labels.map((l) => (
        <span key={l} className="tag faint lab">
          {l}
          <button type="button" className="lab-x" aria-label={`Remove label ${l}`} title={`Remove ${l}`} onClick={() => remove(l)}>
            <Icon name="i-close" size={9} />
          </button>
        </span>
      ))}
      {adding ? (
        <>
          <input
            autoFocus
            className="lab-in"
            list={unused.length ? listId : undefined}
            aria-label="New label"
            placeholder="label…"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add(e.currentTarget.value);
              }
              if (e.key === "Escape") {
                // the expanded pane is a dialog; Escape belongs to this input first
                e.stopPropagation();
                settled.current = true;
                setAdding(false);
              }
            }}
            onBlur={(e) => add(e.currentTarget.value)}
          />
          {unused.length > 0 && (
            <datalist id={listId}>
              {unused.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          )}
        </>
      ) : (
        <button
          type="button"
          className="lab-add"
          title="Add a label to this issue"
          onClick={() => {
            settled.current = false;
            setAdding(true);
          }}
        >
          <Icon name="i-plus" size={10} /> Label
        </button>
      )}
    </span>
  );
}

/**
 * The lock is a human-only field: it stops agents writing title and body, so
 * only a human can set or clear it. Status stays agent-writable either way.
 */
export function LockButton({ item, write, className }: FieldProps & { className?: string }) {
  const locked = item.humanLocked;
  return (
    <button
      type="button"
      className={cn("btn", className ?? "btn-ghost")}
      data-on={locked}
      aria-pressed={locked}
      title={locked ? "Let agents write the title and body again" : "Stop agents writing the title and body"}
      onClick={() =>
        write(
          item,
          { humanLocked: !locked },
          locked ? <>Unlocked <span className="num">{item.key}</span></> : <>Locked the title and body of <span className="num">{item.key}</span></>
        )
      }
    >
      <Icon name="i-lock" size={13} />
      <span className="lbl">{locked ? "Unlock" : "Lock"}</span>
    </button>
  );
}

/**
 * Click-to-edit text. The read view is a button so the affordance is reachable
 * from a keyboard, and the write view is a textarea that grows to its content —
 * a wrapped title must not scroll inside two lines.
 *
 * Blur commits, because an edit abandoned by clicking elsewhere is still an
 * edit; Escape is the way to discard one.
 */
export function InlineText({
  value,
  placeholder,
  ariaLabel,
  className,
  heading,
  submit,
  onSave
}: {
  value: string;
  placeholder: string;
  ariaLabel: string;
  /** Shared by both views, so the text does not reflow when it becomes editable. */
  className: string;
  /** Keeps the read view a real heading; the write view is always a textarea. */
  heading?: "h1" | "h2";
  /** A title takes Enter; a body needs it for paragraphs and takes ⌘Enter. */
  submit: "enter" | "mod-enter";
  onSave: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Escape unmounts the textarea, and an unmount can still fire blur — without
  // this the discard would be committed by the very blur it caused.
  const discarded = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!editing || !el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const commit = (next: string) => {
    setEditing(false);
    if (discarded.current) {
      discarded.current = false;
      return;
    }
    const trimmed = next.trim();
    if (trimmed === value.trim()) return;
    onSave(trimmed);
  };

  if (!editing) {
    const view = (
      <button
        type="button"
        className={cn("inline-edit", !heading && className)}
        title="Click to edit"
        onClick={() => {
          discarded.current = false;
          setEditing(true);
        }}
      >
        {value || <span className="inline-hint">{placeholder}</span>}
      </button>
    );
    if (heading === "h1") return <h1 className={className}>{view}</h1>;
    if (heading === "h2") return <h2 className={className}>{view}</h2>;
    return view;
  }

  return (
    <textarea
      ref={ref}
      rows={1}
      className={cn(className, "inline-ta")}
      aria-label={ariaLabel}
      placeholder={placeholder}
      defaultValue={value}
      onInput={(e) => {
        e.currentTarget.style.height = "auto";
        e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          discarded.current = true;
          setEditing(false);
          return;
        }
        const send = submit === "enter" ? e.key === "Enter" && !e.shiftKey : e.key === "Enter" && (e.metaKey || e.ctrlKey);
        if (send) {
          e.preventDefault();
          commit(e.currentTarget.value);
        }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
    />
  );
}

/** Title and body, wired to the write path. The lock never blocks a human. */
export function IssueTitle({ item, write, heading }: FieldProps & { heading: "h1" | "h2" }) {
  return (
    <InlineText
      value={item.title}
      placeholder="Untitled issue"
      ariaLabel="Issue title"
      className={heading === "h1" ? "issue-title" : "detail-title"}
      heading={heading}
      submit="enter"
      onSave={(next) => next && write(item, { title: next }, <>Retitled <span className="num">{item.key}</span></>)}
    />
  );
}

export function IssueBody({ item, write, className }: FieldProps & { className: string }) {
  return (
    <InlineText
      value={item.body ?? ""}
      placeholder="No description yet. Click to write one."
      ariaLabel="Issue description"
      className={className}
      submit="mod-enter"
      onSave={(next) => write(item, { body: next || null }, <>Edited the description of <span className="num">{item.key}</span></>)}
    />
  );
}
