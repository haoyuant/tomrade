import { useCallback, useEffect, useRef } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Icon } from "~/components/icons";
import { ContextMenu, ContextMenuActionItem } from "~/components/ui/menu";
import { useI18n } from "~/lib/i18n";
import { useFilesTree } from "~/lib/files";
import { hits } from "~/lib/keybindings";
import { closeTabs, openTab, rememberBacklog, useTabs, type FileTab } from "~/lib/tabs";
import { useWorkspace } from "./context";

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The project's tabs, above whatever the workspace is showing. Backlog comes
 * first and stays; each file opened adds a tab, folders share one. The route
 * is still the truth for what is shown — the strip follows it, and a click is
 * a navigation.
 */
export function TabStrip() {
  const ws = useWorkspace();
  const projectId = ws.project.id;
  const { t } = useI18n();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { id?: string; v?: string };
  const tree = useFilesTree(projectId);
  const state = useTabs(projectId);
  const filePath = ws.filePath;
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
  useEffect(() => {
    if (filePath === null) {
      rememberBacklog(projectId, ws.virtual && ws.workstream ? { kind: "workstream", id: ws.workstream.id } : { kind: "view", id: ws.view.id });
      lastActive.current = null;
      return;
    }
    const kind = kindOf(filePath);
    if (!kind) return;
    openTab(projectId, { kind, path: filePath, ...(kind === "file" && pin ? { pin } : {}) }, lastActive.current);
    lastActive.current = filePath;
  }, [projectId, filePath, kindOf, pin?.id, pin?.v, ws.virtual, ws.workstream?.id, ws.view.id]);

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

  /** Closing the tab on screen shows its right-hand neighbour, else the left, else Backlog. */
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
      else goBacklog();
    },
    [state.tabs, activeIndex, projectId, goTab, goBacklog]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.documentElement.classList.contains("overlay-open")) return;
      const order: (FileTab | null)[] = [null, ...state.tabs];
      const at = activeIndex + 1;
      if (hits(e, "closeTab", { lenientCtrl: true })) {
        e.preventDefault();
        if (activeIndex >= 0) close((_, i) => i === activeIndex);
      } else if (hits(e, "nextTab") || hits(e, "prevTab")) {
        e.preventDefault();
        const step = hits(e, "nextTab") ? 1 : -1;
        const target = order[(at + step + order.length) % order.length];
        if (target) goTab(target);
        else goBacklog();
      } else if (hits(e, "backlogTab", { lenientCtrl: true })) {
        e.preventDefault();
        if (filePath !== null) goBacklog();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.tabs, activeIndex, close, goTab, goBacklog, filePath]);

  // The tab on screen is always in view, however many are open.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeIndex, filePath]);

  const backlogName = ws.virtual && ws.workstream ? ws.workstream.name : filePath === null ? ws.view.name : null;

  return (
    <div className="tab-strip" role="tablist" aria-label={t("tabs.strip")} ref={strip}>
      <button
        type="button"
        role="tab"
        className="tab is-backlog"
        data-tab="backlog"
        aria-selected={filePath === null}
        title={backlogName ? `${t("tabs.backlog")} · ${backlogName}` : t("tabs.backlog")}
        onClick={() => filePath !== null && goBacklog()}
      >
        <Icon className="tab-ico" name="i-board" size={13} />
        <span className="tab-name">{t("tabs.backlog")}</span>
      </button>
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
                onClick={() => !selected && goTab(tab)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
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
