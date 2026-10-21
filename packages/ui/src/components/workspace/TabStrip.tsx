import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { Icon } from "~/components/icons";
import { ContextMenu, ContextMenuActionItem } from "~/components/ui/menu";
import { useI18n } from "~/lib/i18n";
import { useFilesTree } from "~/lib/files";
import { hits } from "~/lib/keybindings";
import { closeTabs, openTab, openTabWindow, rememberBacklog, setRoutinesTab, useTabs, type FileTab } from "~/lib/tabs";
import { errorSpec, useToast } from "~/lib/toast";
import { useWorkspace } from "./context";
import { isCommitKey } from "~/lib/keys";

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The project's tabs, above whatever the workspace is showing. Backlog comes
 * first and stays, then Routines once opened; each file opened adds a tab,
 * folders share one. The route
 * is still the truth for what is shown — the strip follows it, and a click is
 * a navigation. Any tab can leave for a window of its own, from its menu or
 * by being dragged out of the window; Backlog, which never closes, is copied.
 */
export function TabStrip() {
  const ws = useWorkspace();
  const projectId = ws.project.id;
  const { t } = useI18n();
  const navigate = useNavigate();
  const router = useRouter();
  const toast = useToast();
  const search = useSearch({ strict: false }) as { id?: string; v?: string };
  const tree = useFilesTree(projectId);
  const state = useTabs(projectId);
  const filePath = ws.filePath;
  const onRoutines = ws.routines;
  const onBacklog = filePath === null && !onRoutines;
  const pin = search.id && search.v ? { id: search.id, v: search.v } : undefined;

  // What a path is decides its tab; until the tree says, the path waits. Without Files at all, only "" is a folder.
  const entries = tree.data;
  const kindOf = useCallback(
    (path: string): FileTab["kind"] | null => {
      if (path === "") return "folder";
      if (!entries) return tree.isError ? "file" : null;
      return entries.find((e) => e.path === path)?.kind === "dir" ? "folder" : "file";
    },
    [entries, tree.isError]
  );

  // The tab a new file opens beside: the one it was opened from.
  const lastActive = useRef<string | null>(null);
  const pinId = pin?.id;
  const pinV = pin?.v;
  const workstreamId = ws.workstream?.id;
  useEffect(() => {
    if (onRoutines) {
      setRoutinesTab(projectId, true);
      lastActive.current = null;
      return;
    }
    if (filePath === null) {
      rememberBacklog(projectId, ws.virtual && workstreamId !== undefined ? { kind: "workstream", id: workstreamId } : { kind: "view", id: ws.view.id });
      lastActive.current = null;
      return;
    }
    const kind = kindOf(filePath);
    if (!kind) return;
    openTab(projectId, { kind, path: filePath, ...(kind === "file" && pinId && pinV ? { pin: { id: pinId, v: pinV } } : {}) }, lastActive.current);
    lastActive.current = filePath;
  }, [projectId, onRoutines, filePath, kindOf, pinId, pinV, ws.virtual, workstreamId, ws.view.id]);

  // A file deleted out from under its tab takes the tab with it — never the one on screen. Only a
  // fresh tree decides: a tab just renamed is not in the tree it was renamed against.
  const shown = useRef(filePath);
  shown.current = filePath;
  useEffect(() => {
    if (!entries) return;
    const present = new Set(entries.map((e) => e.path));
    closeTabs(projectId, (tab) => tab.path !== shown.current && tab.path !== "" && !present.has(tab.path));
  }, [entries, projectId]);

  const activeIndex = filePath === null ? -1 : state.tabs.findIndex((tab) => tab.path === filePath);

  const goBacklog = useCallback(() => {
    const place = state.backlog;
    if (place?.kind === "workstream") ws.openWorkstream(place.id);
    else if (place) ws.openView(place.id);
    else void navigate({ to: "/p/$projectId", params: { projectId } });
  }, [state.backlog, ws, navigate, projectId]);

  const goTab = useCallback(
    (tab: FileTab) =>
      void navigate({ to: "/p/$projectId/f/$", params: { projectId, _splat: tab.path }, search: tab.pin ? { id: tab.pin.id, v: tab.pin.v } : {} }),
    [navigate, projectId]
  );

  const goRoutines = ws.openRoutines;

  /** Closing the tab on screen shows its right-hand neighbour, else the left, else Routines, else Backlog. */
  const close = useCallback(
    (drop: (tab: FileTab, index: number) => boolean) => {
      const before = state.tabs;
      const active = before[activeIndex];
      closeTabs(projectId, drop);
      if (!active || !drop(active, activeIndex)) return;
      const right = before.slice(activeIndex + 1).find((tab, i) => !drop(tab, activeIndex + 1 + i));
      const left = before.slice(0, activeIndex).reverse().find((tab, i) => !drop(tab, activeIndex - 1 - i));
      const next = right ?? left;
      if (next) goTab(next);
      else if (state.routines) goRoutines();
      else goBacklog();
    },
    [state.tabs, state.routines, activeIndex, projectId, goTab, goRoutines, goBacklog]
  );

  /** Closing Routines on screen shows the first file tab, else Backlog. */
  const closeRoutines = useCallback(() => {
    setRoutinesTab(projectId, false);
    if (!onRoutines) return;
    const next = state.tabs[0];
    if (next) goTab(next);
    else goBacklog();
  }, [projectId, onRoutines, state.tabs, goTab, goBacklog]);

  // The window opens a moment after the ask; by then the strip may have moved on.
  const latest = useRef({ close, closeRoutines });
  latest.current = { close, closeRoutines };

  const backlogRoute = () => {
    const place = state.backlog;
    if (place?.kind === "workstream") return router.buildLocation({ to: "/p/$projectId/w/$boardId", params: { projectId, boardId: place.id } }).publicHref;
    if (place) return router.buildLocation({ to: "/p/$projectId/v/$viewId", params: { projectId, viewId: place.id } }).publicHref;
    return router.buildLocation({ to: "/p/$projectId", params: { projectId } }).publicHref;
  };
  const tabRoute = (tab: FileTab) =>
    router.buildLocation({ to: "/p/$projectId/f/$", params: { projectId, _splat: tab.path }, search: tab.pin ? { id: tab.pin.id, v: tab.pin.v } : {} }).publicHref;

  /** A window of its own on `route`; once it is open, `then` closes the tab here when it moved. */
  const popOut = (route: string, dropped: boolean, then?: () => void) =>
    void openTabWindow(route, dropped).then(
      () => then?.(),
      (error: unknown) => toast(errorSpec(error))
    );
  const backlogOut = (dropped = false) => popOut(backlogRoute(), dropped);
  const routinesOut = (dropped = false) => popOut(router.buildLocation({ to: "/p/$projectId/r", params: { projectId } }).publicHref, dropped, () => latest.current.closeRoutines());
  const tabOut = (tab: FileTab, dropped = false) => popOut(tabRoute(tab), dropped, () => latest.current.close((t) => t.kind === tab.kind && t.path === tab.path));

  /** Set while a tab is dragged, so the click that ends the drag does not also open it. */
  const dragged = useRef(false);
  /**
   * A tab pulled out of the window and let go there leaves for a window of its own,
   * under the pointer. The press captures the pointer, so the release is heard out there.
   */
  const dragOut = useCallback((e: ReactPointerEvent<HTMLElement>, leave: () => void) => {
    if (e.button !== 0 || e.pointerType !== "mouse" || (e.target as HTMLElement).closest(".tab-close")) return;
    const tab = e.currentTarget;
    const start = { x: e.clientX, y: e.clientY };
    dragged.current = false;
    tab.setPointerCapture(e.pointerId);
    const outside = (ev: PointerEvent) => ev.clientX < 0 || ev.clientY < 0 || ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight;
    const move = (ev: PointerEvent) => {
      if (!dragged.current && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      dragged.current = true;
      tab.dataset.drag = outside(ev) ? "out" : "on";
    };
    const end = (ev: PointerEvent) => {
      tab.removeEventListener("pointermove", move);
      tab.removeEventListener("pointerup", end);
      tab.removeEventListener("pointercancel", end);
      delete tab.dataset.drag;
      if (ev.type === "pointerup" && dragged.current && outside(ev)) leave();
      // cleared only after the click this release may still fire
      setTimeout(() => (dragged.current = false));
    };
    tab.addEventListener("pointermove", move);
    tab.addEventListener("pointerup", end);
    tab.addEventListener("pointercancel", end);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.documentElement.classList.contains("overlay-open")) return;
      // In the note editor a Mac's Ctrl chords move the caret; only ⌘ is ours there.
      const lenientCtrl = !(document.activeElement as HTMLElement | null)?.isContentEditable;
      const order: (FileTab | "backlog" | "routines")[] = ["backlog", ...(state.routines ? (["routines"] as const) : []), ...state.tabs];
      const at = onRoutines ? 1 : activeIndex >= 0 ? activeIndex + order.length - state.tabs.length : 0;
      if (hits(e, "closeTab", { lenientCtrl })) {
        e.preventDefault();
        if (onRoutines) closeRoutines();
        else if (activeIndex >= 0) close((_, i) => i === activeIndex);
      } else if (hits(e, "nextTab") || hits(e, "prevTab")) {
        e.preventDefault();
        const step = hits(e, "nextTab") ? 1 : -1;
        const target = order[(at + step + order.length) % order.length]!;
        if (target === "backlog") goBacklog();
        else if (target === "routines") goRoutines();
        else goTab(target);
      } else if (hits(e, "backlogTab", { lenientCtrl })) {
        e.preventDefault();
        if (!onBacklog) goBacklog();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.tabs, state.routines, activeIndex, close, closeRoutines, goTab, goBacklog, goRoutines, onRoutines, onBacklog]);

  // The tab on screen is always in view, however many are open.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeIndex, filePath, onRoutines]);

  const backlogName = ws.virtual && ws.workstream ? ws.workstream.name : onBacklog ? ws.view.name : null;

  const windowIcon = <Icon name="i-popout" size={13} />;

  return (
    <div className="tab-strip" role="tablist" aria-label={t("tabs.strip")} ref={strip}>
      <ContextMenu
        label={t("tabs.backlog")}
        trigger={
          <button
            type="button"
            role="tab"
            className="tab is-backlog"
            data-tab="backlog"
            aria-selected={onBacklog}
            title={backlogName ? `${t("tabs.backlog")} · ${backlogName}` : t("tabs.backlog")}
            onClick={() => !dragged.current && !onBacklog && goBacklog()}
            onPointerDown={(e) => dragOut(e, () => backlogOut(true))}
          >
            <Icon className="tab-ico" name="i-board" size={13} />
            <span className="tab-name">{t("tabs.backlog")}</span>
          </button>
        }
      >
        <ContextMenuActionItem icon={windowIcon} name={t("tabs.openInWindow")} onSelect={() => backlogOut()} />
      </ContextMenu>
      {state.routines && (
        <ContextMenu
          label={t("templates.title")}
          trigger={
            <div
              role="tab"
              tabIndex={0}
              className="tab is-routines"
              data-tab="routines"
              aria-selected={onRoutines}
              title={t("templates.title")}
              onClick={() => !dragged.current && !onRoutines && goRoutines()}
              onPointerDown={(e) => dragOut(e, () => routinesOut(true))}
              onKeyDown={(e) => {
                if (isCommitKey(e) || e.key === " ") {
                  e.preventDefault();
                  if (!onRoutines) goRoutines();
                }
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                closeRoutines();
              }}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            >
              <Icon className="tab-ico" name="i-alarm" size={13} />
              <span className="tab-name">{t("templates.title")}</span>
              <button
                type="button"
                className="tab-close"
                aria-label={t("tabs.close", { name: t("templates.title") })}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  closeRoutines();
                }}
              >
                <Icon name="i-close" size={11} />
              </button>
            </div>
          }
        >
          <ContextMenuActionItem icon={windowIcon} name={t("tabs.moveToWindow")} onSelect={() => routinesOut()} />
          <ContextMenuActionItem icon={<Icon name="i-close" size={13} />} name={t("tabs.close", { name: t("templates.title") })} onSelect={closeRoutines} />
        </ContextMenu>
      )}
      {state.tabs.map((tab, i) => {
        const name = tab.path === "" ? t("files.home") : nameOf(tab.path);
        const selected = i === activeIndex;
        return (
          <ContextMenu
            key={`${tab.kind}:${tab.path}`}
            label={name}
            trigger={
              <div
                role="tab"
                tabIndex={0}
                className={`tab is-${tab.kind}`}
                data-tab={tab.path}
                data-kind={tab.kind}
                aria-selected={selected}
                title={tab.path || name}
                onClick={() => !dragged.current && !selected && goTab(tab)}
                onPointerDown={(e) => dragOut(e, () => tabOut(tab, true))}
                onKeyDown={(e) => {
                  if (isCommitKey(e) || e.key === " ") {
                    e.preventDefault();
                    if (!selected) goTab(tab);
                  }
                }}
                // the middle button closes, as it does in a browser
                onAuxClick={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  close((_, j) => j === i);
                }}
                onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              >
                <Icon className="tab-ico" name={tab.kind === "folder" ? "i-folder" : "i-file"} size={13} />
                <span className="tab-name">{name}</span>
                {tab.pin && <Icon className="tab-pin" name="i-clock" size={11} />}
                <button
                  type="button"
                  className="tab-close"
                  aria-label={t("tabs.close", { name })}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    close((_, j) => j === i);
                  }}
                >
                  <Icon name="i-close" size={11} />
                </button>
              </div>
            }
          >
            <ContextMenuActionItem icon={windowIcon} name={t("tabs.moveToWindow")} onSelect={() => tabOut(tab)} />
            <ContextMenuActionItem icon={<Icon name="i-close" size={13} />} name={t("tabs.close", { name })} onSelect={() => close((_, j) => j === i)} />
            <ContextMenuActionItem icon={<Icon name="i-close" size={13} />} name={t("tabs.closeOthers")} disabled={state.tabs.length < 2} onSelect={() => close((_, j) => j !== i)} />
            <ContextMenuActionItem icon={<Icon name="i-close" size={13} />} name={t("tabs.closeRight")} disabled={i === state.tabs.length - 1} onSelect={() => close((_, j) => j > i)} />
            <ContextMenuActionItem icon={<Icon name="i-close" size={13} />} name={t("tabs.closeAll")} onSelect={() => close(() => true)} />
          </ContextMenu>
        );
      })}
    </div>
  );
}
