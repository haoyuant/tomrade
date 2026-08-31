import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Icon } from "~/components/icons";
import { Kbd, Spacer } from "~/components/ui/atoms";
import { Menu, MenuActionItem, MenuHead, MenuLinkItem, MenuRadioItem } from "~/components/ui/menu";
import { useI18n } from "~/lib/i18n";
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
  const { t } = useI18n();
  const open = items.filter((i) => i.status !== "done" && i.status !== "cancelled").length;

  return (
    <header className="titlebar">
      <Link to="/" className="btn btn-icon no-drag" title={t("titleBar.projectsHome")} aria-label={t("titleBar.projectsHome")}>
        <Icon name="i-home" size={16} />
      </Link>
      <span className="title-sep" />
      <div className="menu-wrap no-drag" style={{ display: "flex", alignItems: "center", alignSelf: "stretch" }}>
        <Menu
          open={projectMenuOpen}
          onOpenChange={setProjectMenuOpen}
          label={t("titleBar.projectsLabel")}
          wide
          trigger={
            <button type="button" id="projSwitch" className="btn btn-ghost" title={t("titleBar.switchProjectTitle")} style={{ padding: "4px 8px" }}>
              <Icon className="ico" name="i-stack" size={15} />
              <span>{project.name}</span>
              <Icon className="chev" name="i-chevdown" size={13} />
            </button>
          }
        >
          <MenuHead title={t("titleBar.projectsLabel")} aside={t("settingsDialog.localMachine")} />
          {projects.map((p) => (
            <MenuRadioItem
              key={p.id}
              checked={p.id === project.id}
              name={p.name}
              sub={
                p.archived
                  ? t("titleBar.archived")
                  : p.id === project.id
                    ? t("titleBar.boardsOpenSummary", { boards: boards.filter((b) => !b.across).length, open })
                    : (p.description ?? t("titleBar.localProject"))
              }
              mark={<Icon name={p.archived ? "i-archive" : "i-stack"} size={13} style={{ color: p.id === project.id ? "var(--accent)" : "var(--meta)" }} />}
              onSelect={() => void navigate({ to: "/p/$projectId", params: { projectId: p.id } })}
            />
          ))}
          <div className="menu-foot">
            <MenuActionItem icon={<Icon name="i-gear" size={13} />} name={t("titleBar.projectSettings")} onSelect={onOpenProjectSettings} />
            <MenuLinkItem icon={<Icon name="i-home" size={13} />} name={t("titleBar.allProjects")} onSelect={() => void navigate({ to: "/" })} />
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
      <button type="button" className="btn btn-ghost no-drag" onClick={onOpenPalette} title={t("titleBar.commandPaletteTitle")}>
        <Icon name="i-search" size={14} />
        <span>{t("titleBar.search")}</span>
        <Kbd>⌘K</Kbd>
      </button>
      <button type="button" className="btn btn-primary no-drag" onClick={onNewIssue} title={t("titleBar.newIssueTitle")}>
        <Icon name="i-plus" size={14} />
        {t("titleBar.newButton")}
      </button>
      <button type="button" className="btn btn-icon no-drag" onClick={onOpenSettings} title={t("titleBar.settingsTitle")} aria-label={t("titleBar.settingsAria")}>
        <Icon name="i-gear" size={17} />
      </button>
    </header>
  );
}

/** Railed, or hidden under 990px, the sidebar is gone — so this answers the same question it does. */
export function BoardHead({ onOpenBoardSettings }: { onOpenBoardSettings: () => void }) {
  const { board, boards, view, boardViews, items, visible, openSpace } = useWorkspace();
  const { t, tx } = useI18n();
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
          label={t("titleBar.boardsMenuLabel")}
          trigger={
            <button type="button" className="btn btn-icon" aria-label={t("titleBar.switchBoardAria")} title={t("titleBar.boardsMenuLabel")}>
              <Icon name="i-board" size={16} />
            </button>
          }
        >
          {group(t("titleBar.boardsGroup"), boards.filter((b) => !b.across))}
          {group(t("sidebar.acrossBoards"), boards.filter((b) => b.across))}
        </Menu>
      </div>
      <h1 className="board-title">{board.name}</h1>
      <div className="board-facts">
        {board.subtitle && <span className="tag neutral num">{board.subtitle}</span>}
        <span className="meta-txt">
          {tx("titleBar.shownOf", { shown: <span className="num">{visible.length}</span>, total: <span className="num">{count(board)}</span> })} ·{" "}
          {tx("titleBar.viewsCount", { n: <span className="num">{boardViews.length}</span> })}
        </span>
      </div>
      <Spacer />
      {/* a cross-board space borrows every board and owns nothing to configure */}
      {!board.across && (
        <button
          type="button"
          className="btn btn-ghost"
          aria-label={t("titleBar.boardSettingsAria")}
          aria-haspopup="dialog"
          title={t("titleBar.boardSettingsTooltip")}
          onClick={onOpenBoardSettings}
        >
          <Icon name="i-board" size={14} />
          <span className="lbl">{t("titleBar.boardSettingsAria")}</span>
        </button>
      )}
      <span className="sr-only">{view.name}</span>
    </div>
  );
}
