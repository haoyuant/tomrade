import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Icon } from "~/components/icons";
import { BoardSettingsDialog } from "~/components/dialogs/BoardSettingsDialog";
import { DeleteIssueDialog } from "~/components/dialogs/DeleteIssueDialog";
import { NewIssueDialog } from "~/components/dialogs/NewIssueDialog";
import { PluginsDialog } from "~/components/dialogs/PluginsDialog";
import { SettingsDialog } from "~/components/dialogs/SettingsDialog";
import { ViewSettingsDialog } from "~/components/dialogs/ViewSettingsDialog";
import { ProjectSettingsDialog } from "~/components/projects/ProjectSettingsDialog";
import { StatusBar } from "~/components/chrome/StatusBar";
import { usePanelOpen } from "~/lib/panel";
import { useUndo } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { AiPanel, aiOpenKey } from "./AiPanel";
import { Board } from "./Board";
import { CommandPalette } from "./CommandPalette";
import { DetailPane } from "./DetailPane";
import { QueryBar } from "./QueryBar";
import { Sidebar, sidebarOpenKey } from "./Sidebar";
import { BoardHead, TitleBar } from "./TitleBar";
import { useWorkspace } from "./context";

/** Below this the three panes cannot all hold their minimum. */
const THREE_PANE_FLOOR = 1380;

function ConflictBanner({ title, onDismiss }: { title: string; onDismiss: () => void }) {
  return (
    <div className="banner" role="alert">
      <Icon className="b-mark" name="i-warn" size={15} />
      <span>
        Version conflict on “{title}”. An agent wrote to it while this board was open — the board re-fetched, so try the move again.
      </span>
      <button type="button" className="btn btn-ghost" style={{ marginLeft: "auto", padding: "3px 8px" }} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

export function Workspace() {
  const ws = useWorkspace();
  const undo = useUndo(ws.project.id);
  const toast = useToast();
  const navigate = useNavigate();

  const [aiOpen, setAiOpen] = usePanelOpen(aiOpenKey);
  const [sideOpen, setSideOpen] = usePanelOpen(sidebarOpenKey);
  const [expanded, setExpanded] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [newIssue, setNewIssue] = useState(false);
  const [settings, setSettings] = useState(false);
  const [plugins, setPlugins] = useState(false);
  const [viewSettings, setViewSettings] = useState(false);
  const [boardSettings, setBoardSettings] = useState(false);
  const [projectSettings, setProjectSettings] = useState(false);
  const [projectMenu, setProjectMenu] = useState(false);
  /** The issue the confirmation is open on, held by id so it can go stale. */
  const [deleting, setDeleting] = useState<string | null>(null);

  const selected = ws.items.find((i) => i.id === ws.selectedId) ?? null;
  const deleteTarget = ws.items.find((i) => i.id === deleting) ?? null;

  // The sheet is rendered from a live lookup, so an agent deleting the issue out
  // from under it unmounts the dialog without ever calling onOpenChange — and a
  // `deleting` id left set would hold `anyOverlay` true and wedge the Escape
  // stack behind an overlay that is not on screen.
  useEffect(() => {
    if (deleting && !deleteTarget) setDeleting(null);
  }, [deleting, deleteTarget]);

  const runUndo = useCallback(() => {
    undo.mutate(undefined, {
      onSuccess: (result) => toast({ body: result ? result.summary : "Nothing left to undo" })
    });
  }, [undo, toast]);

  // Opening the detail below the three-pane floor rails the assistant, so
  // every pane stays in normal flow and nothing ever overlaps.
  // keyed on the selection, not the item object: a write re-creates the object
  // and would re-rail a panel the user had just re-opened
  useEffect(() => {
    if (ws.selectedId && !expanded && window.innerWidth < THREE_PANE_FLOOR) setAiOpen(false);
  }, [ws.selectedId, expanded, setAiOpen]);

  const anyOverlay = palette || newIssue || settings || viewSettings || boardSettings || projectSettings || !!deleteTarget;

  // Both entry points are inside a closing overlay — the switcher menu or the
  // palette — and Radix hands focus back to the trigger as that one goes. Open
  // the sheet after that, or the two fight over the focus.
  const openProjectSettings = useCallback(() => {
    setProjectMenu(false);
    requestAnimationFrame(() => setProjectSettings(true));
  }, []);

  // A cross-board space borrows every board and owns nothing to configure.
  const openBoardSettings = useCallback(() => {
    if (ws.board.across) {
      toast({ body: <><span className="num">{ws.board.name}</span> borrows every board — nothing to configure</> });
      return;
    }
    setBoardSettings(true);
  }, [ws.board.across, ws.board.name, toast]);

  // .overlay-open is how the stylesheet demotes the chrome's primary button
  useEffect(() => {
    document.documentElement.classList.toggle("overlay-open", anyOverlay || expanded);
    return () => document.documentElement.classList.remove("overlay-open");
  }, [anyOverlay, expanded]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement as HTMLElement | null)?.tagName ?? "");
      const key = e.key.toLowerCase();
      if (meta && key === "k") {
        e.preventDefault();
        setPalette(true);
      } else if (meta && key === "j") {
        e.preventDefault();
        setAiOpen((v) => !v);
      } else if (meta && key === "b") {
        e.preventDefault();
        setSideOpen((v) => !v);
      } else if (meta && key === "n") {
        e.preventDefault();
        setNewIssue(true);
      } else if (meta && key === "p") {
        e.preventDefault();
        setProjectMenu(true);
      } else if (meta && e.key === ",") {
        e.preventDefault();
        setSettings(true);
      } else if (meta && key === "z" && !e.shiftKey) {
        // a text field owns its own undo stack; never preventDefault over it
        if (typing) return;
        e.preventDefault();
        runUndo();
      } else if (e.key === "Escape" && !anyOverlay && !e.defaultPrevented) {
        // Radix and the inline composers consume Escape first; defaultPrevented
        // is how an inner layer says it already handled it
        // innermost first: an expanded detail collapses before it closes
        if (expanded) setExpanded(false);
        else if (ws.selectedId) ws.select(null);
      } else if (key === "n" && !meta && !typing && !anyOverlay) {
        e.preventDefault();
        setNewIssue(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anyOverlay, expanded, runUndo, ws]);

  return (
    <div className="app">
      <TitleBar
        onOpenPalette={() => setPalette(true)}
        onNewIssue={() => setNewIssue(true)}
        onOpenSettings={() => setSettings(true)}
        onOpenProjectSettings={openProjectSettings}
        projectMenuOpen={projectMenu}
        setProjectMenuOpen={setProjectMenu}
      />

      <div className={sideOpen ? "workspace" : "workspace side-railed"}>
        <Sidebar open={sideOpen} onToggle={setSideOpen} />
        <section className="board-region">
          <BoardHead onOpenBoardSettings={openBoardSettings} />
          <QueryBar onOpenViewSettings={() => setViewSettings(true)} />
          {conflict && <ConflictBanner title={conflict} onDismiss={() => setConflict(null)} />}
          <Board onConflict={setConflict} />
        </section>

        {selected && (
          <DetailPane
            item={selected}
            expanded={expanded}
            onToggleExpand={() => setExpanded((v) => !v)}
            onClose={() => {
              setExpanded(false);
              ws.select(null);
            }}
            onDelete={() => setDeleting(selected.id)}
          />
        )}

        <AiPanel
          open={aiOpen}
          onToggle={setAiOpen}
          scope={{
            projectId: ws.project.id,
            label: `${ws.board.name} · ${ws.view.name}${ws.dirty ? " (filtered)" : ""} · ${ws.visible.length}`,
            trace: `list_items · board=${ws.board.name} view=${ws.view.name}${ws.filterCount ? ` · ${ws.filterCount} filter${ws.filterCount > 1 ? "s" : ""}` : ""}`,
            placeholder: `Ask about ${ws.board.name}…`
          }}
        />
      </div>

      <StatusBar projectId={ws.project.id} onUndo={runUndo} />

      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        actions={{
          newIssue: () => setNewIssue(true),
          toggleAssistant: () => setAiOpen((v) => !v),
          toggleSidebar: () => setSideOpen((v) => !v),
          undo: runUndo,
          openSettings: () => setSettings(true),
          openPlugins: () => setPlugins(true),
          openBoardSettings,
          openProjectSettings,
          openProjectMenu: () => setProjectMenu(true)
        }}
      />
      <NewIssueDialog open={newIssue} onOpenChange={setNewIssue} />
      <SettingsDialog
        open={settings}
        onOpenChange={setSettings}
        onOpenPlugins={() => {
          setSettings(false);
          setPlugins(true);
        }}
      />
      <PluginsDialog open={plugins} onOpenChange={setPlugins} />
      <ViewSettingsDialog
        open={viewSettings}
        onOpenChange={setViewSettings}
        onOpenBoardSettings={() => {
          setViewSettings(false);
          openBoardSettings();
        }}
      />
      <BoardSettingsDialog open={boardSettings} onOpenChange={setBoardSettings} />
      <ProjectSettingsDialog
        project={projectSettings ? ws.project : null}
        projects={ws.projects}
        onOpenChange={setProjectSettings}
        // The route names the project that no longer exists, so leave before the
        // caches it was rendered from are dropped.
        onDeleted={() => void navigate({ to: "/" })}
      />
      <DeleteIssueDialog
        item={deleteTarget}
        items={ws.items}
        projectId={ws.project.id}
        onOpenChange={(open) => !open && setDeleting(null)}
        onDeleted={() => {
          setExpanded(false);
          ws.select(null);
        }}
      />
    </div>
  );
}
