import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Icon } from "~/components/icons";
import { DeleteIssueDialog } from "~/components/dialogs/DeleteIssueDialog";
import { CodeInboxDialog } from "~/components/dialogs/CodeInboxDialog";
import { FieldsDialog } from "~/components/dialogs/FieldsDialog";
import { HistoryDialog } from "~/components/dialogs/HistoryDialog";
import { NewIssueDialog } from "~/components/dialogs/NewIssueDialog";
import { SettingsDialog } from "~/components/dialogs/SettingsDialog";
import { ViewSettingsDialog } from "~/components/dialogs/ViewSettingsDialog";
import { ProjectSettingsDialog } from "~/components/projects/ProjectSettingsDialog";
import { StatusBar } from "~/components/chrome/StatusBar";
import { useScreenBinding, useAgentDock, type ScreenBinding } from "~/components/chrome/ProjectShell";
import { useI18n } from "~/lib/i18n";
import { usePlaybookConflictNotice } from "~/lib/agent";
import { usePanelOpen } from "~/lib/panel";
import { useSettingsHost } from "~/lib/settingsHost";
import { useCreateView, useRedo, useUndo } from "~/lib/queries";
import { errorSpec, useToast, useToastDismiss } from "~/lib/toast";
import { useHintToast } from "~/lib/onboarding";
import { FilesRegion } from "~/components/files/FilesRegion";
import { RoutinesRegion } from "~/components/routines/RoutinesRegion";
import { Board } from "./Board";
import { CommandPalette } from "./CommandPalette";
import { DetailPane } from "./DetailPane";
import { GraphView } from "./GraphView";
import { QueryBar, focusTicketSearch } from "./QueryBar";
import { Sidebar, sidebarOpenKey } from "./Sidebar";
import { TabStrip } from "./TabStrip";
import { Table } from "./Table";
import { TitleBar, ViewHead } from "./TitleBar";
import { ShortcutsDialog } from "~/components/dialogs/ShortcutsDialog";
import { hitChord, isBare, type CommandId } from "~/lib/keybindings";

// Opening a ticket re-renders this screen for its detail pane; the regions beside it hold still.
const SidebarRegion = memo(Sidebar);
const ViewHeadRegion = memo(ViewHead);
const QueryBarRegion = memo(QueryBar);
const BoardRegion = memo(Board);
const TableRegion = memo(Table);
const GraphRegion = memo(GraphView);
import { useSelectedId, useWorkspace } from "./context";
import { notesSearch, useNotesSearchState } from "~/lib/notes";
import { useToastUndo } from "~/lib/undo";

/** Below this the three panes cannot all hold their minimum. */
const THREE_PANE_FLOOR = 1380;

function ConflictBanner({ title, onDismiss }: { title: string; onDismiss: () => void }) {
  const { t, tx } = useI18n();
  return (
    <div className="banner" role="alert">
      <Icon className="b-mark" name="i-warn" size={15} />
      <span>{tx("workspace.conflictBanner", { title })}</span>
      <button type="button" className="btn btn-ghost" style={{ marginLeft: "auto", padding: "3px 8px" }} onClick={onDismiss}>
        {t("workspace.dismiss")}
      </button>
    </div>
  );
}

export function Workspace() {
  const ws = useWorkspace();
  const selectedId = useSelectedId();
  usePlaybookConflictNotice(ws.project.id);
  // The sample teaches the graph with a ticket of its own; elsewhere, the first dependency points at it.
  useHintToast("hint.graph", !ws.project.sample && ws.layout !== "graph" && ws.items.some((i) => i.blocks.length > 0), "onboarding.graphHint");
  const { t, tx } = useI18n();
  const undo = useUndo(ws.project.id);
  const undoWrite = useToastUndo(ws.project.id);
  const redo = useRedo(ws.project.id);
  const createView = useCreateView(ws.project.id);
  const toast = useToast();
  const dismissToast = useToastDismiss();
  const navigate = useNavigate();

  const { setAiOpen, showThread } = useAgentDock();
  const [sideOpen, setSideOpen] = usePanelOpen(sidebarOpenKey);
  // The note search lives in the sidebar: asking for it, from anywhere, unfolds the sidebar.
  const searchFocus = useNotesSearchState().focus;
  useEffect(() => {
    if (searchFocus) setSideOpen(true);
  }, [searchFocus, setSideOpen]);
  const [expanded, setExpanded] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [newIssue, setNewIssue] = useState(false);
  /** null when shut; the pane to land on when open, "" for wherever it was left. */
  const [settings, setSettings] = useState<string | null>(null);
  /** The engine row Settings opens unfolded on, when sent there to set one up. */
  const [settingsEngine, setSettingsEngine] = useState<string>();
  useSettingsHost(setSettings);
  const [viewSettings, setViewSettings] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [codeInbox, setCodeInbox] = useState(false);
  const [history, setHistory] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** Which field the Fields sheet lands on; null for the list. */
  const [fieldsFocus, setFieldsFocus] = useState<string | null>(null);
  const openFields = useCallback((fieldId?: string) => {
    setFieldsFocus(fieldId ?? null);
    setFieldsOpen(true);
  }, []);
  /** false: closed; true: the sheet; a name: the sheet scrolled to that block. */
  const [projectSettings, setProjectSettings] = useState<boolean | "repositories" | "files">(false);
  const [projectMenu, setProjectMenu] = useState(false);
  /** The issue the confirmation is open on, held by id so it can go stale. */
  const [deleting, setDeleting] = useState<string | null>(null);

  const selected = ws.items.find((i) => i.id === selectedId) ?? null;
  const deleteTarget = ws.items.find((i) => i.id === deleting) ?? null;

  // What the global panel should know while this screen is up: chips select
  // into the sidebar detail, and "this" means the open detail, then the view.
  const binding = useMemo<ScreenBinding>(
    () => ({
      openIssue: ws.select,
      openSettings: (engineId) => {
        setSettingsEngine(engineId);
        setSettings("assistant");
      },
      focus: [
        ...(selected ? [{ kind: "item", id: selected.id, key: selected.key, title: selected.title }] : []),
        ws.filePath !== null
          ? { kind: "file", id: ws.filePath || "/", title: ws.filePath ? ws.filePath.slice(ws.filePath.lastIndexOf("/") + 1) : t("files.home") }
          : ws.routines
            ? { kind: "routines", id: "routines", title: t("templates.title") }
            : { kind: "view", id: ws.view.id, title: ws.view.name }
      ],
      boardId: ws.workstream?.id ?? null,
      onOpenRepositories: () => setProjectSettings("repositories")
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws.select, selected?.id, selected?.key, selected?.title, ws.view.id, ws.view.name, ws.workstream?.id, ws.filePath, ws.routines]
  );
  useScreenBinding(binding);

  // The sheet is rendered from a live lookup, so an agent deleting the issue out
  // from under it unmounts the dialog without ever calling onOpenChange — and a
  // `deleting` id left set would hold `anyOverlay` true and wedge the Escape
  // stack behind an overlay that is not on screen.
  useEffect(() => {
    if (deleting && !deleteTarget) setDeleting(null);
  }, [deleting, deleteTarget]);

  // One step at a time. A step that restores files can wait on the store — a
  // save, a sync — so the second ⌘Z of an impatient hand must not queue a
  // second undo behind the first; and once it drags on, the wait is announced.
  const stepping = useRef(false);
  const [busy, setBusy] = useState<"undo" | "redo" | null>(null);
  const runStep = useCallback(
    (direction: "undo" | "redo") => {
      if (stepping.current) return;
      stepping.current = true;
      setBusy(direction);
      let notice: number | null = null;
      const soon = window.setTimeout(() => {
        notice = toast({ body: t(direction === "undo" ? "workspace.undoing" : "workspace.redoing"), sticky: true });
      }, 400);
      const long = window.setTimeout(() => {
        if (notice !== null) dismissToast(notice);
        notice = toast({ body: t(direction === "undo" ? "workspace.undoingLong" : "workspace.redoingLong"), sticky: true });
      }, 4000);
      (direction === "undo" ? undo : redo).mutate(undefined, {
        onSuccess: (result) => toast({ body: result ? result.summary : t(direction === "undo" ? "workspace.nothingToUndo" : "workspace.nothingToRedo") }),
        onError: (error) => toast(errorSpec(error)),
        onSettled: () => {
          window.clearTimeout(soon);
          window.clearTimeout(long);
          if (notice !== null) dismissToast(notice);
          stepping.current = false;
          setBusy(null);
        }
      });
    },
    [undo, redo, toast, dismissToast, t]
  );
  const runUndo = useCallback(() => runStep("undo"), [runStep]);
  const openViewSettings = useCallback(() => setViewSettings(true), []);
  const runRedo = useCallback(() => runStep("redo"), [runStep]);

  // Opening the detail below the three-pane floor rails the assistant, so
  // every pane stays in normal flow and nothing ever overlaps.
  // keyed on the selection, not the item object: a write re-creates the object
  // and would re-rail a panel the user had just re-opened
  useEffect(() => {
    if (selectedId && !expanded && window.innerWidth < THREE_PANE_FLOOR) setAiOpen(false);
  }, [selectedId, expanded, setAiOpen]);

  const anyOverlay = palette || newIssue || settings !== null || viewSettings || fieldsOpen || codeInbox || history || shortcutsOpen || !!projectSettings || !!deleteTarget;

  // Both entry points are inside a closing overlay — the switcher menu or the
  // palette — and Radix hands focus back to the trigger as that one goes. Open
  // the sheet after that, or the two fight over the focus.
  const openProjectSettings = useCallback(() => {
    setProjectMenu(false);
    requestAnimationFrame(() => setProjectSettings(true));
  }, []);

  // The palette cannot ask for a name, so a view made from it opens under a
  // placeholder and is renamed in the head.
  const newView = useCallback(() => {
    const name = t("workspace.untitledView", { n: ws.views.length + 1 });
    createView.mutate(
      { name, icon: "i-board", layout: "board", query: { columnBy: "status" } },
      {
        onSuccess: (view) => {
          ws.openView(view.id);
          toast({ body: <>{tx("workspace.createdViewToast", { name: <span className="num">{name}</span> })}</>, onUndo: () => undoWrite({ id: view.id, stamp: view.updatedAt }) });
        },
        onError: (err) => toast(errorSpec(err))
      }
    );
  }, [createView, t, tx, toast, undo, ws]);

  // .overlay-open is how the stylesheet demotes the chrome's primary button
  useEffect(() => {
    document.documentElement.classList.toggle("overlay-open", anyOverlay || expanded);
    return () => document.documentElement.classList.remove("overlay-open");
  }, [anyOverlay, expanded]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const focused = document.activeElement as HTMLElement | null;
      // The note editor is contenteditable: its keys, ⌘Z among them, are its own — and so is any
      // key it already handled, and on a Mac every Ctrl chord (Ctrl-K, -N, -P, -B move the caret there).
      const editing = !!focused?.isContentEditable;
      if (editing && e.defaultPrevented) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(focused?.tagName ?? "") || editing;
      // A bare key ("N", "/") is a letter being typed anywhere text goes, and behind a sheet it is the sheet's.
      const on = (id: CommandId) => {
        const chord = hitChord(e, id, { lenientCtrl: !editing });
        return !!chord && (!isBare(chord) || (!typing && !anyOverlay));
      };
      if (on("palette")) {
        e.preventDefault();
        setPalette(true);
      } else if (on("searchNotes")) {
        e.preventDefault();
        notesSearch.open();
      } else if (on("searchTickets") && !anyOverlay) {
        if (focusTicketSearch()) e.preventDefault();
      } else if (on("sidebar")) {
        e.preventDefault();
        setSideOpen((v) => !v);
      } else if (on("newTicket")) {
        e.preventDefault();
        setNewIssue(true);
      } else if (on("switchProject")) {
        e.preventDefault();
        setProjectMenu(true);
      } else if (on("settings")) {
        e.preventDefault();
        setSettings("");
      } else if (on("undo")) {
        // a text field owns its own undo stack; never preventDefault over it
        if (typing) return;
        e.preventDefault();
        runUndo();
      } else if (on("redo")) {
        if (typing) return;
        e.preventDefault();
        runRedo();
      } else if (on("shortcuts") && !anyOverlay) {
        e.preventDefault();
        setShortcutsOpen(true);
      } else if (e.key === "Escape" && !anyOverlay && !e.defaultPrevented) {
        // Radix and the inline composers consume Escape first; defaultPrevented
        // is how an inner layer says it already handled it
        // innermost first: an expanded detail collapses before it closes
        if (expanded) setExpanded(false);
        else if (selectedId) {
          // closing the pane from inside it gives focus back to the card it came from
          const fromPane = !!(document.activeElement as HTMLElement | null)?.closest?.("aside.detail");
          ws.select(null);
          if (fromPane) requestAnimationFrame(() => document.querySelector<HTMLElement>(`.card[data-id="${selectedId}"], .tbl-row[data-id="${selectedId}"] .tbl-title`)?.focus());
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anyOverlay, expanded, runUndo, runRedo, ws, selectedId]);

  return (
    <div className="app">
      <TitleBar
        onOpenPalette={() => setPalette(true)}
        onNewIssue={() => setNewIssue(true)}
        onOpenSettings={() => setSettings("")}
        onOpenUsage={() => setSettings("usage")}
        projectMenuOpen={projectMenu}
        setProjectMenuOpen={setProjectMenu}
      />

      <div className={sideOpen ? "workspace" : "workspace side-railed"}>
        <SidebarRegion open={sideOpen} onToggle={setSideOpen} onOpenFields={openFields} onOpenTemplates={ws.openRoutines} onOpenProjectSettings={openProjectSettings} />
        <div className="main-col">
          <TabStrip />
          {ws.filePath !== null ? (
            <FilesRegion path={ws.filePath} onOpenSharing={() => setProjectSettings("files")} />
          ) : ws.routines ? (
            <RoutinesRegion projectId={ws.project.id} onOpenIssue={ws.select} onOpenThread={showThread} />
          ) : (
            <section className="board-region" data-layout={ws.layout}>
              <ViewHeadRegion onOpenViewSettings={openViewSettings} />
              <QueryBarRegion />
              {conflict && <ConflictBanner title={conflict} onDismiss={() => setConflict(null)} />}
              {ws.itemsError ? (
                <div className="items-error" role="alert">
                  <p>{t("workspace.itemsReadFailed")}</p>
                  <code className="route-error-detail">{ws.itemsError}</code>
                  <button type="button" className="btn btn-secondary" onClick={ws.retryItems}>
                    {t("common.tryAgain")}
                  </button>
                </div>
              ) : ws.layout === "graph" ? (
                <GraphRegion />
              ) : ws.layout === "table" ? (
                <TableRegion onConflict={setConflict} />
              ) : (
                <BoardRegion onConflict={setConflict} />
              )}
            </section>
          )}
        </div>

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
            onOpenRepositories={openProjectSettings}
          />
        )}
      </div>

      <StatusBar projectId={ws.project.id} onUndo={runUndo} onRedo={runRedo} onHistory={() => setHistory(true)} busy={busy} onOpen={(surface) => surface === "code-inbox" && setCodeInbox(true)} />

      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        onCustomize={() => {
          setShortcutsOpen(false);
          setSettings("keybindings");
        }}
      />
      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        actions={{
          newIssue: () => setNewIssue(true),
          newView,
          toggleAssistant: () => setAiOpen((v) => !v),
          toggleSidebar: () => setSideOpen((v) => !v),
          undo: runUndo,
          redo: runRedo,
          openHistory: () => setHistory(true),
          openShortcuts: () => setShortcutsOpen(true),
          openSettings: () => setSettings(""),
          openPlugins: () => setSettings("plugins"),
          openAbout: () => setSettings("about"),
          openViewSettings: () => setViewSettings(true),
          openFields: () => openFields(),
          openTemplates: ws.openRoutines,
          openProjectSettings,
          openProjectMenu: () => setProjectMenu(true),
          openCodeInbox: () => setCodeInbox(true),
          // the closing palette hands focus back to its trigger; take it after that
          searchTickets: () => requestAnimationFrame(() => focusTicketSearch())
        }}
      />
      <FieldsDialog projectId={ws.project.id} projectName={ws.project.name} open={fieldsOpen} onOpenChange={setFieldsOpen} initialFieldId={fieldsFocus} onOpenRepositories={() => setProjectSettings("repositories")} />
      <CodeInboxDialog
        projectId={ws.project.id}
        open={codeInbox}
        onOpenChange={setCodeInbox}
        onOpenIssue={(id) => {
          setCodeInbox(false);
          ws.select(id);
        }}
      />
      <HistoryDialog projectId={ws.project.id} open={history} onOpenChange={setHistory} />
      <NewIssueDialog open={newIssue} onOpenChange={setNewIssue} />
      <SettingsDialog
        open={settings !== null}
        pane={settings ?? ""}
        engine={settingsEngine}
        onOpenChange={(o) => {
          setSettings(o ? "" : null);
          if (!o) setSettingsEngine(undefined);
        }}
      />
      <ViewSettingsDialog open={viewSettings} onOpenChange={setViewSettings} />
      <ProjectSettingsDialog
        project={projectSettings ? ws.project : null}
        projects={ws.projects}
        section={typeof projectSettings === "string" ? projectSettings : undefined}
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
