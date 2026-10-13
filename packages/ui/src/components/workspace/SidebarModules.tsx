import { useCallback, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSortable } from "@dnd-kit/react/sortable";
import type { SidebarModuleView, SidebarRow } from "@tomradex/contributions";
import { ICON_IDS, Icon, type IconId } from "~/components/icons";
import { Eyebrow, Spacer } from "~/components/ui/atoms";
import { ContextMenu, ContextMenuActionItem } from "~/components/ui/menu";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { useRunCommand } from "~/lib/queries";
import { openSettingsPane } from "~/lib/settingsHost";
import { openExternal } from "~/lib/shell";
import { useErrorToast, useToast } from "~/lib/toast";
import { useOptionalAgentDock } from "~/components/chrome/ProjectShell";

/** Built-in modules, in their default order; contributed ones follow, `plugin:<id>`. */
export const BUILTIN_MODULES = ["files", "routines", "backlog"] as const;

const layoutKey = "tomrade.sidebar.layout";

interface Layout {
  order: string[];
  folded: string[];
}

const readLayout = (): Layout => {
  try {
    const raw = JSON.parse(localStorage.getItem(layoutKey) ?? "null") as Partial<Layout> | null;
    return { order: Array.isArray(raw?.order) ? raw.order : [], folded: Array.isArray(raw?.folded) ? raw.folded : [] };
  } catch {
    return { order: [], folded: [] };
  }
};

/**
 * Where the modules sit and which are folded — this machine's preference, kept
 * in local storage, never synced. A module the saved order has not met yet
 * (a plugin installed since) lands after the ones it has.
 */
export function useSidebarLayout() {
  const [layout, setLayout] = useState(readLayout);
  const save = useCallback((next: Layout) => {
    setLayout(next);
    try {
      localStorage.setItem(layoutKey, JSON.stringify(next));
    } catch {
      // a preference only: without storage it lasts the session
    }
  }, []);
  const arrange = useCallback(
    (ids: string[]) => {
      const rank = new Map(layout.order.map((id, i) => [id, i]));
      return [...ids].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
    },
    [layout.order]
  );
  return {
    arrange,
    setOrder: (order: string[]) => save({ ...layout, order }),
    resetOrder: () => save({ ...layout, order: [] }),
    folded: (id: string) => layout.folded.includes(id),
    toggle: (id: string) => save({ ...layout, folded: layout.folded.includes(id) ? layout.folded.filter((f) => f !== id) : [...layout.folded, id] })
  };
}

/**
 * One module of the sidebar. The head is its door and its drag handle; a
 * module with something under it folds from the chevron on the left, and one
 * without keeps the chevron's room so every title starts at the same x.
 */
export function SidebarModule({
  id,
  index,
  name,
  className,
  head,
  foldable,
  folded,
  onToggle,
  onMove,
  onResetOrder,
  canMove,
  children
}: {
  id: string;
  index: number;
  /** Said by the fold button and the move menu. */
  name: string;
  className?: string;
  head: ReactNode;
  foldable: boolean;
  folded: boolean;
  onToggle: () => void;
  onMove: (by: -1 | 1) => void;
  onResetOrder: () => void;
  canMove: { up: boolean; down: boolean };
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const { ref, handleRef, isDragging } = useSortable({ id, index, type: "module", accept: "module" });
  return (
    <div ref={ref as (node: HTMLElement | null) => void} className={`side-group side-module${className ? ` ${className}` : ""}${isDragging ? " dragging" : ""}`} data-module={id}>
      <ContextMenu
        label={t("sidebar.moduleMenu", { name })}
        trigger={
          <div ref={handleRef as (node: HTMLElement | null) => void} className="side-label-row side-module-head" title={t("sidebar.dragToReorder")}>
            {foldable ? (
              <button
                type="button"
                className="btn btn-icon side-module-fold"
                aria-expanded={!folded}
                aria-label={t(folded ? "sidebar.unfoldModule" : "sidebar.foldModule", { name })}
                title={t(folded ? "sidebar.unfoldModule" : "sidebar.foldModule", { name })}
                onClick={onToggle}
              >
                <Icon name="i-chevdown" size={12} style={folded ? { transform: "rotate(-90deg)" } : undefined} />
              </button>
            ) : (
              <span className="side-module-fold-space" aria-hidden />
            )}
            {head}
          </div>
        }
      >
        <ContextMenuActionItem icon={<Icon name="i-chev" size={13} style={{ transform: "rotate(-90deg)" }} />} name={t("sidebar.moveModuleUp")} disabled={!canMove.up} onSelect={() => onMove(-1)} />
        <ContextMenuActionItem icon={<Icon name="i-chev" size={13} style={{ transform: "rotate(90deg)" }} />} name={t("sidebar.moveModuleDown")} disabled={!canMove.down} onSelect={() => onMove(1)} />
        <ContextMenuActionItem icon={<Icon name="i-undo" size={13} />} name={t("sidebar.resetModuleOrder")} onSelect={onResetOrder} />
      </ContextMenu>
      {foldable && !folded && <div className="side-module-body">{children}</div>}
    </div>
  );
}

export const useSidebarModules = (projectId: string) =>
  useQuery({ queryKey: ["contributions", "sidebar", projectId], queryFn: (): Promise<SidebarModuleView[]> => invoke("contributions.sidebarModules", projectId) });

const iconOf = (icon: string | undefined): IconId | null => (icon && (ICON_IDS as readonly string[]).includes(icon) ? (icon as IconId) : null);

/** A contributed command's result, handled as the palette and the status bar handle it. */
function useRunContributed(projectId: string) {
  const runCommand = useRunCommand(projectId);
  const dock = useOptionalAgentDock();
  const toast = useToast();
  const reportError = useErrorToast();
  return (id: string) =>
    runCommand.mutate(
      { id, scope: { projectId } },
      {
        onSuccess: (r) => {
          if (r.toast) toast({ body: r.toast });
          if (r.settingsPane) openSettingsPane(r.settingsPane);
          if (r.showThread) dock?.showThread(r.showThread);
        },
        onError: reportError
      }
    );
}

/** A contributed module's head: its icon and title, a door when it names a command. */
export function PluginModuleHead({ module, projectId }: { module: SidebarModuleView; projectId: string }) {
  const run = useRunContributed(projectId);
  const icon = iconOf(module.icon) ?? "i-plug";
  const title = (
    <>
      <Icon name={icon} size={14} />
      <Eyebrow className="side-label side-module-title">{module.title}</Eyebrow>
    </>
  );
  return (
    <>
      {module.command ? (
        <button type="button" className="side-label-btn side-module-btn" onClick={() => run(module.command!)}>
          {title}
        </button>
      ) : (
        <span className="side-label-btn side-module-btn is-static">{title}</span>
      )}
      <Spacer />
    </>
  );
}

function PluginRow({ row, projectId }: { row: SidebarRow; projectId: string }) {
  const run = useRunContributed(projectId);
  const icon = iconOf(row.icon);
  const act = row.command ? () => run(row.command!) : row.href ? () => openExternal(row.href!) : undefined;
  return (
    <button type="button" className={`side-row is-plugin${row.detail ? " has-detail" : ""}`} data-row={row.id} disabled={!act} onClick={act}>
      {icon ? <Icon className="ico" name={icon} size={15} /> : <span className="ico side-row-noico" />}
      <span className="side-ws-text">
        <span className="side-name">{row.label}</span>
        {row.detail && <span className="side-ws-repo side-row-detail">{row.detail}</span>}
      </span>
      {row.count !== undefined && <span className="side-count num">{row.count}</span>}
    </button>
  );
}

export function PluginModuleBody({ module, projectId }: { module: SidebarModuleView; projectId: string }) {
  const { t } = useI18n();
  const rows = module.rows ?? [];
  return (
    <div className="side-list" style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {rows.map((r) => (
        <PluginRow key={r.id} row={r} projectId={projectId} />
      ))}
      {!rows.length && <p className="side-module-empty">{t("sidebar.moduleEmpty")}</p>}
    </div>
  );
}
