import { useState } from "react";
import type { Board } from "@tomrade/domain";
import { Icon, type IconId } from "~/components/icons";
import { Eyebrow } from "~/components/ui/atoms";
import { boardSubtitle } from "~/lib/domain";
import { useCreateBoard, useUndo } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { boardCount, useWorkspace } from "./context";

function BoardRow({ board }: { board: Board }) {
  const { items, board: active, openSpace, views } = useWorkspace();
  const count = boardCount(items, board);
  const saved = views.filter((v) => v.boardId === board.id).length;
  const current = board.id === active.id;
  return (
    <button
      type="button"
      className="side-row is-board"
      aria-current={current}
      title={`${board.note ?? boardSubtitle(board)} · ${saved} saved view${saved === 1 ? "" : "s"}`}
      // already here: switching would throw away the live query for no reason
      onClick={() => !current && openSpace(board.id)}
    >
      <Icon className="ico" name={board.icon as IconId} size={15} />
      <span className="side-stack">
        <span className="side-name">{board.name}</span>
        <span className="side-pkg">{boardSubtitle(board)}</span>
      </span>
      <span className="side-count num">{count}</span>
    </button>
  );
}

/**
 * Creating a board is a real write: it makes the workstream and the All work
 * view every board is guaranteed to have, switches to it, and stays undoable.
 */
function NewBoardRow() {
  const { project, openSpace } = useWorkspace();
  const create = useCreateBoard(project.id);
  const undo = useUndo(project.id);
  const toast = useToast();
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <button type="button" className="side-row side-add" style={{ marginTop: 2 }} onClick={() => setEditing(true)}>
        <Icon className="ico" name="i-plus" size={14} />
        <span className="side-name">New board</span>
      </button>
    );
  }

  const commit = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return setEditing(false);
    const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "board";
    create.mutate(
      { name: trimmed, icon: "i-board", subtitle: `packages/${slug}` },
      {
        onSuccess: (board) => {
          setEditing(false);
          openSpace(board.id, board.defaultViewId);
          toast({
            body: (
              <>
                Created board <span className="num">{trimmed}</span> · All work view added
              </>
            ),
            onUndo: () => undo.mutate(board.id)
          });
        }
      }
    );
  };

  return (
    <div className="side-row is-board" style={{ cursor: "default", background: "var(--surface)", boxShadow: "var(--elev-ring)" }}>
      <Icon className="ico" name="i-board" size={15} />
      <input
        autoFocus
        aria-label="New board name"
        placeholder="Workstream name…"
        style={{
          flex: 1,
          minWidth: 0,
          border: 0,
          background: "transparent",
          padding: 0,
          color: "var(--fg)",
          fontFamily: "var(--font-display)",
          fontSize: 14,
          outline: "none"
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(false);
          }
          if (e.key === "Enter") commit(e.currentTarget.value);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.value.trim()) setEditing(false);
        }}
      />
    </div>
  );
}

/**
 * Boards inside THIS project, and nothing else. Leaving the project is chrome
 * work — home and the switcher, both in the titlebar.
 */
export function Sidebar() {
  const { boards } = useWorkspace();
  const workstreams = boards.filter((b) => !b.across);
  const scopes = boards.filter((b) => b.across);

  return (
    <nav className="sidebar">
      <div className="side-group">
        <Eyebrow className="side-label">Boards</Eyebrow>
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {workstreams.map((b) => (
            <BoardRow key={b.id} board={b} />
          ))}
        </div>
        <NewBoardRow />
      </div>
      {scopes.length > 0 && (
        <div className="side-group">
          <Eyebrow className="side-label">Across boards</Eyebrow>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {scopes.map((b) => (
              <BoardRow key={b.id} board={b} />
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}
