import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Icon } from "~/components/icons";
import { Kbd, Spacer } from "~/components/ui/atoms";
import { Menu, MenuActionItem, MenuHead, MenuLinkItem, MenuRadioItem } from "~/components/ui/menu";
import { useWorkspace } from "./context";

/**
 * Home *leaves* the project, the switcher *rebinds* it in place — two jobs, so
 * two controls, separated by a hairline rather than a slash.
 */
export function TitleBar({
  onOpenPalette,
  onNewIssue,
  onOpenSettings,
  onOpenProjectSettings,
  projectMenuOpen,
  setProjectMenuOpen
}: {
  onOpenPalette: () => void;
  onNewIssue: () => void;
  onOpenSettings: () => void;
  onOpenProjectSettings: () => void;
  projectMenuOpen: boolean;
  setProjectMenuOpen: (open: boolean) => void;
}) {
  const { project, projects, board, view, boards, items } = useWorkspace();
  const navigate = useNavigate();
  const open = items.filter((i) => i.status !== "done" && i.status !== "cancelled").length;

  return (
    <header className="titlebar">
      <Link to="/" className="btn btn-icon no-drag" title="Projects home" aria-label="Projects home">
        <Icon name="i-home" size={16} />
      </Link>
      <span className="title-sep" />
      <div className="menu-wrap no-drag" style={{ display: "flex", alignItems: "center", alignSelf: "stretch" }}>
        <Menu
          open={projectMenuOpen}
          onOpenChange={setProjectMenuOpen}
          label="Projects"
          wide
          trigger={
            <button type="button" id="projSwitch" className="btn btn-ghost" title="Switch project — ⌘P" style={{ padding: "4px 8px" }}>
              <Icon className="ico" name="i-stack" size={15} />
              <span>{project.name}</span>
              <Icon className="chev" name="i-chevdown" size={13} />
            </button>
          }
        >
          <MenuHead title="Projects" aside="local · this machine" />
          {projects.map((p) => (
            <MenuRadioItem
              key={p.id}
              checked={p.id === project.id}
              name={p.name}
              sub={p.archived ? "Archived" : p.id === project.id ? `${boards.filter((b) => !b.across).length} boards · ${open} open` : p.description ?? "Local project"}
              mark={<Icon name={p.archived ? "i-archive" : "i-stack"} size={13} style={{ color: p.id === project.id ? "var(--accent)" : "var(--meta)" }} />}
              onSelect={() => void navigate({ to: "/p/$projectId", params: { projectId: p.id } })}
            />
          ))}
          <div className="menu-foot">
            <MenuActionItem icon={<Icon name="i-gear" size={13} />} name="Project settings" onSelect={onOpenProjectSettings} />
            <MenuLinkItem icon={<Icon name="i-home" size={13} />} name="All projects" onSelect={() => void navigate({ to: "/" })} />
          </div>
        </Menu>
      </div>
      <span className="crumb-sep">/</span>
      <span className="crumb-title">{board.name}</span>
      <span className="crumb-sep">/</span>
      <span className="crumb-title" style={{ color: "var(--muted)" }}>
        {view.name}
      </span>
      <Spacer />
      <button type="button" className="btn btn-ghost no-drag" onClick={onOpenPalette} title="Command palette">
        <Icon name="i-search" size={14} />
        <span>Search</span>
        <Kbd>⌘K</Kbd>
      </button>
      <button type="button" className="btn btn-primary no-drag" onClick={onNewIssue} title="New issue — ⌘N">
        <Icon name="i-plus" size={14} />
        New
      </button>
      <button type="button" className="btn btn-icon no-drag" onClick={onOpenSettings} title="Settings — ⌘," aria-label="Settings">
        <Icon name="i-gear" size={17} />
      </button>
    </header>
  );
}

/** Under 990px the sidebar is hidden, so this answers the same question it does. */
export function BoardHead({ onOpenBoardSettings }: { onOpenBoardSettings: () => void }) {
  const { board, boards, view, boardViews, items, visible, openSpace } = useWorkspace();
  const [menuOpen, setMenuOpen] = useState(false);
  const count = (b: (typeof boards)[number]) => items.filter((i) => b.across || i.boardId === b.id).length;

  const group = (title: string, rows: typeof boards) =>
    rows.length > 0 && (
      <>
        <MenuHead title={title} />
        {rows.map((b) => (
          <MenuRadioItem
            key={b.id}
            checked={b.id === board.id}
            name={b.name}
            sub={b.subtitle ?? undefined}
            mark={<Icon name={b.icon as never} size={13} />}
            count={count(b)}
            onSelect={() => {
              setMenuOpen(false);
              openSpace(b.id);
            }}
          />
        ))}
      </>
    );

  return (
    <div className="board-head">
      <div className="menu-wrap board-nav">
        <Menu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          label="Boards and cross-board views"
          trigger={
            <button type="button" className="btn btn-icon" aria-label="Switch board" title="Boards and cross-board views">
              <Icon name="i-board" size={16} />
            </button>
          }
        >
          {group("Boards", boards.filter((b) => !b.across))}
          {group("Across boards", boards.filter((b) => b.across))}
        </Menu>
      </div>
      <h1 className="board-title">{board.name}</h1>
      <div className="board-facts">
        {board.subtitle && <span className="tag neutral num">{board.subtitle}</span>}
        <span className="meta-txt">
          <span className="num">{visible.length}</span> shown of <span className="num">{count(board)}</span> ·{" "}
          <span className="num">{boardViews.length}</span> view{boardViews.length === 1 ? "" : "s"}
        </span>
      </div>
      <Spacer />
      {/* a cross-board space borrows every board and owns nothing to configure */}
      {!board.across && (
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="Board settings"
          aria-haspopup="dialog"
          title="Name, glyph, the issues this board owns, and its saved views"
          onClick={onOpenBoardSettings}
        >
          <Icon name="i-board" size={14} />
          <span className="lbl">Board settings</span>
        </button>
      )}
      <span className="sr-only">{view.name}</span>
    </div>
  );
}
