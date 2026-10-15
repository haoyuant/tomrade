import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DragDropProvider } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { move } from "@dnd-kit/helpers";
import type { Board, Repo, View } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { Eyebrow, Spacer } from "~/components/ui/atoms";
import { Hint } from "~/components/ui/hint";
import { FilesTree } from "~/components/files/FilesTree";
import { InlineNameRow } from "./InlineNameRow";
import { BUILTIN_MODULES, PluginModuleBody, PluginModuleHead, SidebarModule, useSidebarLayout, useSidebarModules } from "./SidebarModules";
import { viewIcon } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useCreateBoard, useCreateView, useRepos, useUpdateView } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";
import { useWorkspace, viewCount } from "./context";
import { useToastUndo } from "~/lib/undo";

function ViewRow({ view, index }: { view: View; index: number }) {
  const { items, view: active, openView, virtual, filePath, routines } = useWorkspace();
  const current = !virtual && filePath === null && !routines && view.id === active.id;
  const { ref, isDragging } = useSortable({ id: view.id, index, type: "view", accept: "view" });
  return (
    <button
      ref={ref as (node: HTMLElement | null) => void}
      type="button"
      className={`side-row is-view${isDragging ? " dragging" : ""}`}
      data-view={view.id}
      aria-current={current}
      title={view.name}
      // already here: switching would throw away the live draft for no reason
      onClick={() => !current && openView(view.id)}
    >
      <Icon className="ico" name={viewIcon(view.icon)} size={15} />
      <span className="side-name">{view.name}</span>
      <span className="side-count num">{viewCount(items, view)}</span>
    </button>
  );
}

/** A midpoint between neighbours, or null when there is none — then the whole roster is renumbered. */
function rankBetween(prev: number | undefined, next: number | undefined): number | null {
  if (prev === undefined && next === undefined) return 0;
  if (prev === undefined) return (next as number) - 1;
  if (next === undefined) return prev + 1;
  if (next - prev < 1e-6) return null;
  return (prev + next) / 2;
}

/**
 * The roster is sortable by drag. The order is the views' ranks, so a drop is
 * one view update (a midpoint rank) — logged and undoable like any other — or
 * a renumbering when the ranks left no room.
 */
function ViewList() {
  const { project, views } = useWorkspace();
  const update = useUpdateView(project.id);
  const toast = useToast();
  const [order, setOrder] = useState<View[]>(views);
  const orderRef = useRef(order);
  orderRef.current = order;
  const dragging = useRef(false);

  useEffect(() => {
    if (!dragging.current) setOrder(views);
  }, [views]);

  const commit = (id: string) => {
    const list = orderRef.current;
    const at = list.findIndex((v) => v.id === id);
    if (at < 0) return;
    const rank = rankBetween(list[at - 1]?.rank, list[at + 1]?.rank);
    const failed = (err: Error) => {
      setOrder(views);
      toast(errorSpec(err));
    };
    // views are ranked apart when created, so a renumbering is rare: only ranks that collided, from a sync
    if (rank !== null) update.mutate({ id, patch: { rank } }, { onError: failed });
    else list.forEach((v, i) => v.rank !== i && update.mutate({ id: v.id, patch: { rank: i } }, { onError: failed }));
  };

  return (
    <DragDropProvider
      onDragStart={() => {
        dragging.current = true;
      }}
      onDragOver={(event) => setOrder((current) => move(current, event))}
      onDragEnd={(event) => {
        dragging.current = false;
        if (event.canceled) return setOrder(views);
        const id = event.operation.source?.id;
        if (id != null) commit(String(id));
      }}
    >
      <div className="side-list" style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {order.map((v, i) => (
          <ViewRow key={v.id} view={v} index={i} />
        ))}
      </div>
    </DragDropProvider>
  );
}

/** Creating a view is a real write: it lands in the roster, opens, and stays undoable. */
function NewViewRow() {
  const { t, tx } = useI18n();
  const { project, openView } = useWorkspace();
  const create = useCreateView(project.id);
  const undoWrite = useToastUndo(project.id);
  const toast = useToast();
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <button type="button" className="side-row side-add side-new-view" style={{ marginTop: 2 }} onClick={() => setEditing(true)}>
        <Icon className="ico" name="i-plus" size={14} />
        <span className="side-name">{t("sidebar.newView")}</span>
      </button>
    );
  }

  const commit = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return setEditing(false);
    create.mutate(
      { name: trimmed, icon: "i-board", layout: "board", query: { columnBy: "status" } },
      {
        onSuccess: (view) => {
          setEditing(false);
          openView(view.id);
          toast({
            body: <>{tx("sidebar.createdViewToast", { name: <span className="num">{trimmed}</span> })}</>,
            onUndo: () => undoWrite({ id: view.id, stamp: view.updatedAt })
          });
        },
        onError: (err) => toast(errorSpec(err))
      }
    );
  };

  return <InlineNameRow icon="i-board" ariaLabel={t("sidebar.newViewNameAria")} placeholder={t("sidebar.viewNamePlaceholder")} onCommit={commit} onCancel={() => setEditing(false)} />;
}

/**
 * A workstream row is a place: its page shows everything in the workstream as
 * a board by status, unsaved, and reads as current instead of any view. Its
 * second line says where its code lives, so the repository binding is never a
 * hidden setting.
 */
function WorkstreamRow({ board, repo, onEdit }: { board: Board; repo: Repo | null; onEdit: () => void }) {
  const { t } = useI18n();
  const { owned, openWorkstream, virtual, workstream } = useWorkspace();
  const current = virtual && workstream?.id === board.id;
  const count = owned.filter((i) => i.boardId === board.id).length;
  const path = board.repoPath.replace(/^\/+|\/+$/g, "");
  return (
    <div className="side-ws-container">
      <button
        type="button"
        className="side-row is-workstream"
        data-board={board.id}
        aria-current={current}
        title={t("sidebar.openWorkstreamTitle", { name: board.name })}
        onClick={() => !current && openWorkstream(board.id)}
      >
        <Icon className="ico" name={viewIcon(board.icon)} size={15} />
        <span className="side-ws-text">
          <span className="side-name">{board.name}</span>
          <span className={`side-ws-repo num${repo ? "" : " is-none"}`}>
            <Icon name="i-branch" size={11} />
            <span className="side-ws-repo-name">{repo ? (path ? `${repo.name}/${path}` : repo.name) : t("sidebar.noRepo")}</span>
          </span>
        </span>
        <span className="side-count num">{count}</span>
      </button>
      <button
        type="button"
        className="btn btn-icon side-ws-edit"
        aria-haspopup="dialog"
        title={repo ? t("sidebar.editWorkstream") : t("sidebar.connectRepo")}
        aria-label={t("sidebar.editWorkstreamAria", { name: board.name })}
        onClick={onEdit}
      >
        <Icon name={repo ? "i-sliders" : "i-link"} size={13} />
      </button>
    </div>
  );
}

/** Creating a workstream is a real write: it becomes an option of the Workstream field at once, and stays undoable. */
function NewWorkstreamRow({ onEdit }: { onEdit: (boardId: string) => void }) {
  const { t, tx } = useI18n();
  const { project } = useWorkspace();
  const create = useCreateBoard(project.id);
  const undoWrite = useToastUndo(project.id);
  const toast = useToast();
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <button type="button" className="side-row side-add side-new-workstream" style={{ marginTop: 2 }} onClick={() => setEditing(true)}>
        <Icon className="ico" name="i-plus" size={14} />
        <span className="side-name">{t("sidebar.newWorkstream")}</span>
      </button>
    );
  }

  const commit = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return setEditing(false);
    create.mutate(
      { name: trimmed, icon: "i-board" },
      {
        onSuccess: (board) => {
          setEditing(false);
          toast({
            body: <>{tx("sidebar.createdWorkstreamToast", { name: <span className="num">{trimmed}</span> })}</>,
            onUndo: () => undoWrite({ id: board.id, stamp: board.updatedAt }),
            // a new workstream has no code yet; say where that is set, right when it matters
            actions: [{ label: t("sidebar.connectRepo"), run: () => onEdit(board.id) }]
          });
        },
        onError: (err) => toast(errorSpec(err))
      }
    );
  };

  return <InlineNameRow icon="i-board" ariaLabel={t("sidebar.newWorkstreamNameAria")} placeholder={t("sidebar.workstreamNamePlaceholder")} onCommit={commit} onCancel={() => setEditing(false)} />;
}

/**
 * What a workstream is and what binding a repository buys — opened in place
 * beside the list it explains, so the sidebar's scroll box never clips it.
 */
function WorkstreamsHelp({ onManage, onClose }: { onManage: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const card = useRef<HTMLDivElement>(null);
  // opened low in a long sidebar, it would land below the fold
  useEffect(() => {
    card.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <div ref={card} className="side-ws-help" role="note" aria-label={t("sidebar.workstreamsHelpTitle")}>
      <div className="side-ws-help-head">
        <strong>{t("sidebar.workstreamsHelpTitle")}</strong>
        <Spacer />
        <button type="button" className="btn btn-icon side-ws-help-close" aria-label={t("sidebar.closeHelp")} onClick={onClose}>
          <Icon name="i-close" size={12} />
        </button>
      </div>
      <p>{t("sidebar.workstreamsHelpWhat")}</p>
      <p>
        <Icon name="i-branch" size={12} /> {t("sidebar.workstreamsHelpRepo")}
      </p>
      <p className="side-ws-help-example">{t("sidebar.workstreamsHelpExample")}</p>
      <button type="button" className="btn btn-ghost side-ws-help-manage" onClick={onManage}>
        <Icon name="i-sliders" size={13} />
        {t("sidebar.manageWorkstreams")}
      </button>
    </div>
  );
}

/** The backlog's head is its door: it lands on the first view. */
function BacklogHead() {
  const { t } = useI18n();
  const { views, openView, filePath, routines } = useWorkspace();
  const here = filePath === null && !routines;
  return (
    <>
      <button type="button" className="side-label-btn side-module-btn side-backlog-home" aria-current={here} onClick={() => !here && views[0] && openView(views[0].id)}>
        <Icon name="i-board" size={14} />
        <Eyebrow className="side-label side-module-title">{t("sidebar.backlogEyebrow")}</Eyebrow>
      </button>
      <Spacer />
    </>
  );
}

/** The backlog's saved views and the workstreams it is split into (its fields open from the view head). */
function BacklogBody({ onOpenFields }: { onOpenFields: (fieldId?: string, boardId?: string) => void }) {
  const { t } = useI18n();
  const { project, boards } = useWorkspace();
  const repos = useRepos(project.id);
  const [helpOpen, setHelpOpen] = useState(false);
  const editWorkstream = (boardId?: string) => onOpenFields("board", boardId);
  const repoOf = (b: Board) => (repos.data ?? []).find((r) => r.id === b.repoId) ?? null;

  return (
    <>
      <div className="side-sub side-views">
        <div className="side-sub-label">
          <span>{t("sidebar.viewsEyebrow")}</span>
        </div>
        <ViewList />
        <NewViewRow />
      </div>
      <div className="side-sub side-workstreams">
        <div className="side-sub-label">
          <span>{t("sidebar.workstreamsEyebrow")}</span>
          <button
            type="button"
            className="btn btn-icon side-ws-help-btn"
            aria-expanded={helpOpen}
            title={t("sidebar.workstreamsHelpTitle")}
            aria-label={t("sidebar.workstreamsHelpTitle")}
            onClick={() => setHelpOpen(!helpOpen)}
          >
            <Icon name="i-info" size={13} />
          </button>
          <Spacer />
          <button type="button" className="btn btn-icon side-ws-manage" aria-haspopup="dialog" title={t("sidebar.manageWorkstreams")} aria-label={t("sidebar.manageWorkstreams")} onClick={() => editWorkstream()}>
            <Icon name="i-sliders" size={13} />
          </button>
        </div>
        {helpOpen && <WorkstreamsHelp onManage={() => (setHelpOpen(false), editWorkstream())} onClose={() => setHelpOpen(false)} />}
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {boards.map((b) => (
            <WorkstreamRow key={b.id} board={b} repo={repoOf(b)} onEdit={() => editWorkstream(b.id)} />
          ))}
        </div>
        <NewWorkstreamRow onEdit={editWorkstream} />
        {boards.length === 1 && <Hint id="hint.workstreams">{t("sidebar.workstreamsHint")}</Hint>}
      </div>
    </>
  );
}

/**
 * The modules in this machine's order. Each is drawn by the shared shell, so a
 * contributed module folds, drags and spaces exactly like a built-in one.
 */
function ModuleList({ onOpenFields, onOpenTemplates, onOpenSurface }: { onOpenFields: (fieldId?: string, boardId?: string) => void; onOpenTemplates: () => void; onOpenSurface: (surface: string) => void }) {
  const { t } = useI18n();
  const { project, routines } = useWorkspace();
  const layout = useSidebarLayout();
  const contributed = useSidebarModules(project.id).data ?? [];
  const ids = layout.arrange([...BUILTIN_MODULES, ...contributed.map((m) => `plugin:${m.id}`)]);
  // the drag shows its order live; the drop is what is saved
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const shown = dragOrder ?? ids;

  const moveBy = (id: string, by: -1 | 1) => {
    const next = [...ids];
    const at = next.indexOf(id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= next.length) return;
    [next[at], next[to]] = [next[to]!, next[at]!];
    layout.setOrder(next);
  };

  const shell = (id: string, index: number, name: string, head: ReactNode, body?: ReactNode, className?: string) => (
    <SidebarModule
      key={id}
      id={id}
      index={index}
      name={name}
      className={className}
      head={head}
      foldable={body !== undefined}
      folded={layout.folded(id)}
      onToggle={() => layout.toggle(id)}
      onMove={(by) => moveBy(id, by)}
      onResetOrder={layout.resetOrder}
      canMove={{ up: index > 0, down: index < shown.length - 1 }}
    >
      {body}
    </SidebarModule>
  );

  const render = (id: string, index: number) => {
    if (id === "files")
      return (
        <FilesTree key={id}>{(head, body) => shell(id, index, t("files.eyebrow"), head, body, "side-files")}</FilesTree>
      );
    if (id === "routines")
      return shell(
        id,
        index,
        t("templates.label"),
        <button type="button" className="side-label-btn side-module-btn side-templates" aria-current={routines} aria-label={t("templates.openAria")} data-testid="open-templates" onClick={onOpenTemplates}>
          <Icon name="i-alarm" size={14} />
          <Eyebrow className="side-label side-module-title">{t("templates.label")}</Eyebrow>
        </button>,
        undefined,
        "side-routines"
      );
    if (id === "backlog") return shell(id, index, t("sidebar.backlogEyebrow"), <BacklogHead />, <BacklogBody onOpenFields={onOpenFields} />, "side-backlog");
    const module = contributed.find((m) => `plugin:${m.id}` === id);
    if (!module) return null;
    return shell(id, index, module.title, <PluginModuleHead module={module} projectId={project.id} onOpen={onOpenSurface} />, module.rows ? <PluginModuleBody module={module} projectId={project.id} /> : undefined, "side-plugin");
  };

  return (
    <DragDropProvider
      onDragStart={() => setDragOrder(ids)}
      onDragOver={(event) => {
        // only modules reorder here; the views list keeps its own drags
        if (event.operation.source?.type !== "module") return;
        setDragOrder((current) => move(current ?? ids, event));
      }}
      onDragEnd={(event) => {
        const order = dragOrder;
        setDragOrder(null);
        if (!event.canceled && order && event.operation.source?.type === "module") layout.setOrder(order);
      }}
    >
      {shown.map(render)}
    </DragDropProvider>
  );
}

/**
 * The project's modules, each one door: its files, its routines, and its
 * backlog (views, workstreams).
 * Leaving the project is chrome work — home and the switcher, both in the
 * titlebar. Collapsed, it is the same rail the assistant folds to, and the view
 * head grows its own switcher.
 */
export function Sidebar({
  open,
  onToggle,
  onOpenFields,
  onOpenTemplates,
  onOpenProjectSettings,
  onOpenSurface
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  onOpenFields: (fieldId?: string, boardId?: string) => void;
  onOpenTemplates: () => void;
  onOpenProjectSettings: () => void;
  /** A renderer surface a contributed module opens ("inbox"). */
  onOpenSurface: (surface: string) => void;
}) {
  const { t } = useI18n();
  const sidebar = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(() => {
    const stored = localStorage.getItem(sidebarWidthKey);
    const saved = stored === null ? NaN : Number(stored);
    return Number.isFinite(saved) ? Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, saved)) : SIDEBAR_DEFAULT_W;
  });

  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startW = sidebar.current?.offsetWidth ?? width;
    document.body.style.userSelect = "none";
    const onMove = (e: MouseEvent) => {
      const next = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, startW + e.clientX - startX));
      setWidth(next);
      localStorage.setItem(sidebarWidthKey, String(next));
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [width]);

  if (!open) {
    return (
      <div className="rail side-rail">
        <button type="button" className="btn btn-icon" title={t("sidebar.expandSidebar")} aria-label={t("sidebar.expandSidebar")} onClick={() => onToggle(true)}>
          <Icon name="i-panel" size={15} style={{ transform: "scaleX(-1)" }} />
        </button>
        <span className="rail-label">{t("sidebar.projectRailLabel")}</span>
        <button type="button" className="btn btn-icon rail-project-settings" aria-haspopup="dialog" title={t("sidebar.projectSettings")} aria-label={t("sidebar.projectSettings")} onClick={onOpenProjectSettings}>
          <Icon name="i-gear" size={17} />
        </button>
      </div>
    );
  }

  return (
    <nav ref={sidebar} className="sidebar" style={{ width: `${width}px` }}>
      <div
        className="sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("sidebar.resizeSidebar")}
        aria-valuemin={SIDEBAR_MIN_W}
        aria-valuemax={SIDEBAR_MAX_W}
        aria-valuenow={Math.round(width)}
        title={t("sidebar.resizeSidebar")}
        onMouseDown={startResize}
      />
      <div className="side-scroll">
        <div className="side-head">
          <Spacer />
          <button type="button" className="btn btn-icon" title={t("sidebar.collapseSidebar")} aria-label={t("sidebar.collapseSidebar")} onClick={() => onToggle(false)}>
            <Icon name="i-panel" size={15} style={{ transform: "scaleX(-1)" }} />
          </button>
        </div>
        <ModuleList onOpenFields={onOpenFields} onOpenTemplates={onOpenTemplates} onOpenSurface={onOpenSurface} />
      </div>
      {/* pinned below the scrolling body so it is always where people look for it */}
      <div className="side-settings" data-surface-anchor="sidebar-foot">
        <button type="button" className="side-row side-project-settings" aria-haspopup="dialog" aria-label={t("sidebar.projectSettings")} onClick={onOpenProjectSettings}>
          <Icon className="ico" name="i-gear" size={17} />
          <span className="side-name">{t("sidebar.projectSettings")}</span>
        </button>
      </div>
    </nav>
  );
}

export const sidebarOpenKey = "tomrade.sidebar.open";
const sidebarWidthKey = "tomrade.sidebar.width";
const SIDEBAR_DEFAULT_W = 264;
const SIDEBAR_MIN_W = 220;
const SIDEBAR_MAX_W = 420;
