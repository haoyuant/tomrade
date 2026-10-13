import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { LAYOUTS, type Layout } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { Kbd, Spacer } from "~/components/ui/atoms";
import { Menu, MenuActionItem, MenuHead, MenuLinkItem, MenuRadioItem } from "~/components/ui/menu";
import { FIELD_LABEL, LAYOUT_LABEL, viewIcon } from "~/lib/domain";
import { useRepoStates } from "~/lib/codeLink";
import { useI18n } from "~/lib/i18n";
import { useRemoveView, useUpdateView } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";
import { useWorkspace, viewCount } from "./context";
import { useToastUndo } from "~/lib/undo";
import { keyLabel } from "~/lib/keybindings";

/**
 * Home *leaves* the project, the switcher *rebinds* it in place — two jobs, so
 * two controls, separated by a hairline rather than a slash.
 */
export function TitleBar({
  onOpenPalette,
  onNewIssue,
  onOpenSettings,
  onOpenUsage,
  onOpenHistory,
  historyBusy = false,
  projectMenuOpen,
  setProjectMenuOpen
}: {
  onOpenPalette: () => void;
  onNewIssue: () => void;
  onOpenSettings: () => void;
  onOpenUsage: () => void;
  onOpenHistory: () => void;
  /** An undo, redo or rollback is running: the history control spins so a slow one never reads as nothing happening. */
  historyBusy?: boolean;
  projectMenuOpen: boolean;
  setProjectMenuOpen: (open: boolean) => void;
}) {
  const { project, projects, view, views, items, filePath } = useWorkspace();
  const navigate = useNavigate();
  const { t } = useI18n();
  const open = items.filter((i) => i.kind !== "epic" && i.status !== "done" && i.status !== "cancelled").length;

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
                    ? t("titleBar.viewsOpenSummary", { views: views.length, open })
                    : (p.description ?? t("titleBar.localProject"))
              }
              mark={<Icon name={p.archived ? "i-archive" : "i-stack"} size={13} style={{ color: p.id === project.id ? "var(--accent)" : "var(--meta)" }} />}
              onSelect={() => void navigate({ to: "/p/$projectId", params: { projectId: p.id } })}
            />
          ))}
          <div className="menu-foot">
            <MenuLinkItem icon={<Icon name="i-home" size={13} />} name={t("titleBar.allProjects")} onSelect={() => void navigate({ to: "/" })} />
          </div>
        </Menu>
      </div>
      <span className="crumb-sep">/</span>
      <span className="crumb-title">{filePath !== null ? (filePath ? filePath.slice(filePath.lastIndexOf("/") + 1) : t("files.home")) : view.name}</span>
      <Spacer />
      <button type="button" className="btn btn-ghost no-drag" onClick={onOpenPalette} title={t("titleBar.commandPaletteTitle")}>
        <Icon name="i-search" size={14} />
        <span>{t("titleBar.search")}</span>
        <Kbd>{keyLabel("palette")}</Kbd>
      </button>
      <button type="button" className="btn btn-primary no-drag" onClick={onNewIssue} title={t("titleBar.newIssueTitle")}>
        <Icon name="i-plus" size={14} />
        {t("titleBar.newButton")}
      </button>
      <button
        type="button"
        className={`btn btn-icon no-drag title-history${historyBusy ? " is-busy" : ""}`}
        onClick={onOpenHistory}
        title={historyBusy ? t("titleBar.historyBusyTitle") : t("titleBar.historyTitle")}
        aria-label={t("titleBar.historyAria")}
        aria-busy={historyBusy}
      >
        <Icon name={historyBusy ? "i-sync" : "i-history"} size={17} className={historyBusy ? "is-spinning" : undefined} />
      </button>
      <button type="button" className="btn btn-icon no-drag" onClick={onOpenUsage} title={t("usage.label")} aria-label={t("usage.label")} data-testid="titlebar-usage">
        <Icon name="i-bars" size={17} />
      </button>
      <button type="button" className="btn btn-icon no-drag" onClick={onOpenSettings} title={t("titleBar.settingsTitle")} aria-label={t("titleBar.settingsAria")}>
        <Icon name="i-gear" size={17} />
      </button>
    </header>
  );
}

/** The view's name, renamed in place. Blur commits, Escape discards; a menu item can ask it to start editing. */
function ViewName({ editRequest }: { editRequest: number }) {
  const { t, tx } = useI18n();
  const { project, view } = useWorkspace();
  const update = useUpdateView(project.id);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const discarded = useRef(false);

  useEffect(() => {
    if (editRequest > 0) setEditing(true);
  }, [editRequest]);

  const commit = (next: string) => {
    setEditing(false);
    if (discarded.current) {
      discarded.current = false;
      return;
    }
    const name = next.trim();
    if (!name || name === view.name) return;
    update.mutate(
      { id: view.id, patch: { name } },
      { onSuccess: () => toast({ body: tx("titleBar.renamedViewToast", { name: <span className="num">{name}</span> }) }), onError: (err) => toast(errorSpec(err)) }
    );
  };

  if (!editing) {
    return (
      <h1 className="board-title view-title">
        <button
          type="button"
          className="inline-edit view-name"
          title={t("titleBar.renameViewTitle")}
          onClick={() => {
            discarded.current = false;
            setEditing(true);
          }}
        >
          {view.name}
        </button>
      </h1>
    );
  }
  return (
    <h1 className="board-title view-title">
      <input
        autoFocus
        className="view-name-input"
        aria-label={t("titleBar.viewNameAria")}
        defaultValue={view.name}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            discarded.current = true;
            e.currentTarget.blur();
          }
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        onBlur={(e) => commit(e.currentTarget.value)}
      />
    </h1>
  );
}

/**
 * The view's head: name, count, the layout switch and the view's own menu.
 * Railed, or hidden under 990px, the sidebar is gone — so the head also grows
 * a view switcher exactly then.
 */
const READINESS_KEY = { empty: "codeLink.readiness_empty", scaffolded: "codeLink.readiness_scaffolded", unknown: "codeLink.readiness_unknown" } as const;

export function ViewHead({ onOpenViewSettings }: { onOpenViewSettings: () => void }) {
  const ws = useWorkspace();
  const { t, tx } = useI18n();
  // A workstream page says what its repository is ready for: empty repositories bootstrap first.
  const repoStates = useRepoStates(ws.project.id);
  const readiness = ws.workstream?.repoId ? (repoStates.data ?? []).find((r) => r.repoId === ws.workstream!.repoId) ?? null : null;
  const toast = useToast();
  const remove = useRemoveView(ws.project.id);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editRequest, setEditRequest] = useState(0);

  const undoWrite = useToastUndo(ws.project.id);
  const lastView = ws.views.length <= 1;
  const deleteView = () => {
    const view = ws.view;
    remove.mutate(view.id, {
      onSuccess: () => toast({ body: tx("titleBar.deletedViewToast", { name: <span className="num">{view.name}</span> }), onUndo: () => undoWrite({ id: view.id }) }),
      onError: (err) => toast(errorSpec(err))
    });
  };

  return (
    <div className="board-head view-head">
      <div className="menu-wrap board-nav">
        <Menu
          open={switcherOpen}
          onOpenChange={setSwitcherOpen}
          label={t("titleBar.viewsMenuLabel")}
          trigger={
            <button type="button" className="btn btn-icon" aria-label={t("titleBar.switchViewAria")} title={t("titleBar.viewsMenuLabel")}>
              <Icon name="i-board" size={16} />
            </button>
          }
        >
          <MenuHead title={t("titleBar.viewsGroup")} />
          {ws.views.map((v) => (
            <MenuRadioItem
              key={v.id}
              checked={v.id === ws.view.id}
              name={v.name}
              sub={LAYOUT_LABEL[v.layout].label}
              mark={<Icon name={viewIcon(v.icon)} size={13} />}
              count={viewCount(ws.items, v)}
              onSelect={() => {
                setSwitcherOpen(false);
                ws.openView(v.id);
              }}
            />
          ))}
        </Menu>
      </div>
      <Icon className="view-ico" name={viewIcon(ws.view.icon)} size={16} />
      {ws.virtual ? (
        <h1 className="view-title">
          <span className="view-name">{ws.view.name}</span>
        </h1>
      ) : (
        <ViewName editRequest={editRequest} />
      )}
      <div className="board-facts">
        {ws.virtual && <span className="tag neutral view-kind">{FIELD_LABEL.board}</span>}
        {readiness && (
          <span className="tag faint readiness" title={readiness.remoteDetail ?? readiness.summary ?? undefined}>
            {readiness.remote === "unreachable" ? t("codeLink.remoteUnreachable") : t(READINESS_KEY[readiness.readiness])}
            {readiness.remote !== "unreachable" && readiness.readiness === "scaffolded" && !readiness.hasBrief ? ` · ${t("codeLink.noBrief")}` : ""}
          </span>
        )}
        {ws.dirty && <span className="tag faint view-dirty">{t("titleBar.unsaved")}</span>}
        <span className="meta-txt">
          {tx("titleBar.shownOf", { shown: <span className="num">{ws.visible.length}</span>, total: <span className="num">{ws.owned.length}</span> })}
        </span>
      </div>
      <Spacer />
      <div className="seg quiet layout-seg" role="group" aria-label={t("titleBar.layoutAria")}>
        {LAYOUTS.map((l: Layout) => (
          <button
            key={l}
            type="button"
            data-layout={l}
            aria-pressed={ws.layout === l}
            title={t("titleBar.layoutTitle", { layout: LAYOUT_LABEL[l].label })}
            onClick={() => ws.layout !== l && ws.setLayout(l)}
          >
            <Icon className="ico" name={LAYOUT_LABEL[l].icon} size={13} />
            <span className="seg-lbl">{LAYOUT_LABEL[l].label}</span>
          </button>
        ))}
      </div>
      <button type="button" className="btn btn-ghost view-settings-btn" aria-haspopup="dialog" title={t("titleBar.viewSettingsTitle")} onClick={onOpenViewSettings}>
        <Icon name="i-sliders" size={14} />
        <span className="lbl">{t("titleBar.viewSettings")}</span>
      </button>
      {!ws.virtual && (
      <div className="menu-wrap">
        <Menu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          label={t("titleBar.viewMenuLabel")}
          align="end"
          trigger={
            <button type="button" className="btn btn-icon view-menu-btn" aria-label={t("titleBar.viewMenuLabel")} title={t("titleBar.viewMenuLabel")}>
              <Icon name="i-chevdown" size={14} />
            </button>
          }
        >
          <MenuHead title={ws.view.name} aside={LAYOUT_LABEL[ws.view.layout].label} />
          <MenuActionItem icon={<Icon name="i-pen" size={13} />} name={t("titleBar.renameView")} onSelect={() => setEditRequest((n) => n + 1)} />
          <MenuActionItem
            icon={<Icon name="i-stack" size={13} />}
            name={t("titleBar.duplicateView")}
            onSelect={() => ws.saveAsNewView(t("titleBar.copyName", { name: ws.view.name }))}
          />
          <div className="menu-foot">
            <MenuActionItem icon={<Icon name="i-trash" size={13} />} name={t("titleBar.deleteView")} onSelect={deleteView} disabled={lastView} title={lastView ? t("titleBar.lastViewTitle") : undefined} />
          </div>
        </Menu>
      </div>
      )}
    </div>
  );
}
