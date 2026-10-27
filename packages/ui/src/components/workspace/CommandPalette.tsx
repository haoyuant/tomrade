import { useDeferredValue, useEffect, useState } from "react";
import { Command } from "cmdk";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import { LAYOUTS } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { Kbd, StatusMark } from "~/components/ui/atoms";
import { LAYOUT_LABEL, isTicket, viewIcon } from "~/lib/domain";
import { requestStart } from "~/lib/codeLink";
import { useTemplateActions, useTemplates } from "~/lib/templates";
import { useI18n } from "~/lib/i18n";
import { mergeById } from "~/lib/closedWindow";
import { useClosedFound, useCommands, useItem, useRunCommand } from "~/lib/queries";
import { useFilesTree } from "~/lib/files";
import { notesSearch, useNotesEnabled } from "~/lib/notes";
import { useNoteActions } from "~/components/files/useNoteActions";
import { THEME_OPTIONS, useTheme } from "~/lib/theme";
import { errorSpec, useToast } from "~/lib/toast";
import { useSelectedId, useWorkspace } from "./context";
import { useOptionalAgentDock } from "~/components/chrome/ProjectShell";
import { keyLabel } from "~/lib/keybindings";
import { isComposing } from "~/lib/keys";
import { openSettingsPane } from "~/lib/settingsHost";

const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export interface PaletteActions {
  newIssue: () => void;
  newView: () => void;
  toggleAssistant: () => void;
  toggleSidebar: () => void;
  undo: () => void;
  redo: () => void;
  openHistory: () => void;
  openSettings: () => void;
  openPlugins: () => void;
  openAbout: () => void;
  openViewSettings: () => void;
  openFields: () => void;
  openTemplates: () => void;
  openProjectSettings: () => void;
  openProjectMenu: () => void;
  openCodeInbox: () => void;
  /** A renderer surface a plugin command's result names ("feedback"). */
  openSurface: (surface: string) => void;
  openShortcuts: () => void;
  searchTickets: () => void;
}

/** One palette spanning every view, every issue and every action. */
export function CommandPalette({ open, onOpenChange, actions }: { open: boolean; onOpenChange: (open: boolean) => void; actions: PaletteActions }) {
  const ws = useWorkspace();
  const selectedId = useSelectedId();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { setPreference } = useTheme();
  const toast = useToast();
  const dock = useOptionalAgentDock();
  const commands = useCommands();
  const templates = useTemplates(ws.project.id);
  const templateActions = useTemplateActions(ws.project.id);
  const runCommand = useRunCommand(ws.project.id);
  const [search, setSearch] = useState("");
  const tree = useFilesTree(ws.project.id);
  const notesOn = useNotesEnabled();
  const noteActions = useNoteActions();
  const files = (tree.data ?? []).filter((e) => e.kind === "file");
  // cmdk only filters what is rendered, so with a query the whole project is searched first and the best few rendered
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => terms.every((term) => text.toLowerCase().includes(term));
  // The window holds only the newest done and cancelled tickets; older ones are searched for, or opened by key.
  const typed = useDeferredValue(search.trim());
  const foundClosed = useClosedFound(ws.project.id, typed);
  const byKey = useItem(ws.project.id, typed, TICKET_KEY.test(typed) && !ws.items.some((i) => i.key.toLowerCase() === typed.toLowerCase()));
  const tickets = mergeById([ws.items, foundClosed.data, byKey.data ? [byKey.data] : undefined]).filter(isTicket);
  const shownTickets = (terms.length ? tickets.filter((i) => matches(`${i.key} ${i.title}`)) : tickets).slice(0, 60);
  const shownFiles = (terms.length ? files.filter((f) => matches(f.path)) : files).slice(0, 400);
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  // Plugin commands arrive as data and run in the main process against the current scope.
  const pluginGroups = new Map<string, NonNullable<typeof commands.data>>();
  for (const c of commands.data ?? []) {
    const group = c.group ?? t("commandPalette.pluginsGroupFallback");
    pluginGroups.set(group, [...(pluginGroups.get(group) ?? []), c]);
  }
  const runPlugin = (id: string) =>
    runCommand.mutate(
      { id, scope: { projectId: ws.project.id, viewId: ws.view.id, itemId: selectedId } },
      { onSuccess: (r) => {
        if (r.startDialog && selectedId && requestStart(selectedId, r.startDialog)) return;
        if (r.toast) toast({ body: r.toast });
        if (r.showThread) dock?.showThread(r.showThread);
        if (r.settingsPane) openSettingsPane(r.settingsPane);
        if (r.opens) actions.openSurface(r.opens);
      }, onError: (e) => toast(errorSpec(e)) }
    );

  const actionRows = [
    { label: t("commandPalette.newIssue"), kb: keyLabel("newTicket"), run: actions.newIssue },
    { label: t("notes.newNote"), kb: undefined, run: () => void noteActions.createNote("") },
    ...(notesOn ? [{ label: t("notes.today"), kb: undefined, run: () => void noteActions.openToday() }, { label: t("notes.search"), kb: keyLabel("searchNotes"), run: () => notesSearch.open() }] : []),
    { label: t("commandPalette.newView"), kb: undefined, run: actions.newView },
    ...(ws.dirty ? [{ label: t("commandPalette.saveView"), kb: undefined, run: ws.saveView }, { label: t("commandPalette.discardChanges"), kb: undefined, run: ws.discardChanges }] : []),
    { label: t("commandPalette.toggleAssistant"), kb: keyLabel("assistant"), run: actions.toggleAssistant },
    { label: t("commandPalette.toggleSidebar"), kb: keyLabel("sidebar"), run: actions.toggleSidebar },
    { label: t("commandPalette.undoLastWrite"), kb: keyLabel("undo"), run: actions.undo },
    { label: t("commandPalette.redoLastUndo"), kb: keyLabel("redo"), run: actions.redo },
    { label: t("commandPalette.history"), kb: undefined, run: actions.openHistory },
    ...LAYOUTS.map((l) => ({ label: t("commandPalette.layoutAction", { layout: LAYOUT_LABEL[l].label }), kb: undefined, run: () => ws.setLayout(l) })),
    ...(ws.filePath === null && !ws.routines ? [{ label: t("commandPalette.searchTickets"), kb: keyLabel("searchTickets"), run: actions.searchTickets }] : []),
    { label: t("commandPalette.clearFilters"), kb: undefined, run: () => ws.setQuery({ ...ws.query, filter: [] }) },
    { label: t("commandPalette.viewSettings"), kb: undefined, run: actions.openViewSettings },
    { label: t("commandPalette.fields"), kb: undefined, run: actions.openFields },
    { label: t("templates.paletteOpen"), kb: undefined, run: actions.openTemplates },
    ...(templates.data ?? []).map((tpl) => ({
      label: t("templates.paletteRun", { name: tpl.name }),
      kb: undefined,
      run: () =>
        templateActions.run.mutate(tpl.id, {
          onSuccess: (r) =>
            toast({
              body: r.ok
                ? r.itemIds.length
                  ? t(r.itemIds.length === 1 ? "templates.ranTicket" : "templates.ranTickets", { name: tpl.name, n: r.itemIds.length })
                  : t("templates.ran", { name: tpl.name })
                : t("templates.failed", { name: tpl.name, error: r.error ?? "" })
            })
        })
    })),
    { label: t("commandPalette.codeInbox"), kb: undefined, run: actions.openCodeInbox },
    { label: t("commandPalette.switchProject"), kb: keyLabel("switchProject"), run: actions.openProjectMenu },
    { label: t("commandPalette.allProjects"), kb: undefined, run: () => void navigate({ to: "/" }) },
    { label: t("commandPalette.settings"), kb: keyLabel("settings"), run: actions.openSettings },
    { label: t("commandPalette.plugins"), kb: undefined, run: actions.openPlugins },
    { label: t("commandPalette.about"), kb: undefined, run: actions.openAbout },
    { label: t("shortcuts.title"), kb: "?", run: actions.openShortcuts },
    { label: t("commandPalette.projectSettings"), kb: undefined, run: actions.openProjectSettings },
    ...THEME_OPTIONS.map((opt) => ({
      label: t("commandPalette.themeAction", { label: t(opt.labelKey) }),
      kb: undefined,
      run: () => setPreference(opt.value)
    }))
  ];

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="scrim" />
        <RadixDialog.Content
          className="palette"
          aria-label={t("commandPalette.ariaLabel")}
          // that Escape dismisses an IME candidate list, not the palette
          onEscapeKeyDown={(e) => { if (isComposing(e)) e.preventDefault(); }}
        >
          <RadixDialog.Title className="sr-only">{t("commandPalette.title")}</RadixDialog.Title>
          <Command loop>
            <Command.Input
              className="palette-input"
              placeholder={t("commandPalette.searchPlaceholder")}
              aria-label={t("commandPalette.searchAria")}
              value={search}
              onValueChange={setSearch}
            />
            <Command.List className="palette-list">
              <Command.Empty>
                <div className="palette-empty">{t("commandPalette.noMatches", { query: search })}</div>
                {/* Nothing is called that — it may still be written somewhere. */}
                {notesOn && search.trim() && (
                  <button type="button" className="btn btn-ghost palette-search-notes" onClick={() => run(() => notesSearch.open(search.trim()))}>
                    <Icon name="i-search" size={13} />
                    {t("notes.paletteSearch", { query: search.trim() })}
                  </button>
                )}
              </Command.Empty>

              <Command.Group heading={t("commandPalette.viewsGroup")} className="eyebrow palette-group">
                {ws.views.map((view) => (
                  <Command.Item key={view.id} value={`${view.name} ${LAYOUT_LABEL[view.layout].label}`} className="palette-row" onSelect={() => run(() => ws.openView(view.id))}>
                    <Icon name={viewIcon(view.icon)} size={14} style={{ color: "var(--meta)" }} />
                    <span className="p-label">
                      {view.name} <span className="meta-txt">· {LAYOUT_LABEL[view.layout].label}</span>
                    </span>
                    <span className="card-id">{ws.viewCounts[view.id] ?? ""}</span>
                  </Command.Item>
                ))}
              </Command.Group>

              <Command.Group heading={t("commandPalette.workstreamsGroup")} className="eyebrow palette-group">
                {ws.boards.map((b) => (
                  <Command.Item key={b.id} value={b.name} className="palette-row" onSelect={() => run(() => ws.openWorkstream(b.id))}>
                    <Icon name={viewIcon(b.icon)} size={14} style={{ color: "var(--meta)" }} />
                    <span className="p-label">{b.name}</span>
                    <span className="card-id">{ws.owned.filter((i) => i.boardId === b.id).length}</span>
                  </Command.Item>
                ))}
              </Command.Group>

              <Command.Group heading={t("commandPalette.issuesGroup")} className="eyebrow palette-group">
                {shownTickets.map((item) => (
                  <Command.Item
                    key={item.id}
                    value={`${item.key} ${item.title}`}
                    className="palette-row"
                    // the pane looks the issue up across the project, so opening it in place beats navigating away
                    onSelect={() => run(() => ws.select(item.id))}
                  >
                    <StatusMark status={item.status} size={14} />
                    <span className="p-label">{item.title}</span>
                    <span className="card-id">{item.key}</span>
                  </Command.Item>
                ))}
              </Command.Group>

              {shownFiles.length > 0 && (
                <Command.Group heading={t("notes.paletteFiles")} className="eyebrow palette-group">
                  {shownFiles.map((file) => (
                    <Command.Item key={file.path} value={`file ${file.path}`} keywords={[file.name]} className="palette-row" data-file={file.path} onSelect={() => run(() => ws.openFile(file.path))}>
                      <Icon name="i-file" size={14} style={{ color: "var(--meta)" }} />
                      <span className="p-label">{file.name}</span>
                      <span className="card-id">{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              <Command.Group heading={t("commandPalette.actionsGroup")} className="eyebrow palette-group">
                {actionRows.map((action) => (
                  <Command.Item key={action.label} value={action.label} className="palette-row" onSelect={() => run(action.run)}>
                    <Icon name="i-chev" size={14} style={{ color: "var(--meta)" }} />
                    <span className="p-label">{action.label}</span>
                    {action.kb && <Kbd>{action.kb}</Kbd>}
                  </Command.Item>
                ))}
              </Command.Group>

              {[...pluginGroups].map(([group, list]) => (
                <Command.Group key={group} heading={group} className="eyebrow palette-group">
                  {list.map((c) => (
                    <Command.Item key={c.id} value={c.title} className="palette-row" onSelect={() => run(() => runPlugin(c.id))}>
                      <Icon name="i-plug" size={14} style={{ color: "var(--meta)" }} />
                      <span className="p-label">{c.title}</span>
                      {c.shortcut && <Kbd>{c.shortcut}</Kbd>}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
