import { useEffect, useState } from "react";
import { Command } from "cmdk";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import { LAYOUTS } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { Kbd, StatusMark } from "~/components/ui/atoms";
import { LAYOUT_LABEL, isTicket, viewIcon } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useCommands, useRunCommand } from "~/lib/queries";
import { THEME_OPTIONS, useTheme } from "~/lib/theme";
import { useToast } from "~/lib/toast";
import { useWorkspace, viewCount } from "./context";

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
  openViewSettings: () => void;
  openFields: () => void;
  openProjectSettings: () => void;
  openProjectMenu: () => void;
  openCodeInbox: () => void;
}

/** One palette spanning every view, every issue and every action. */
export function CommandPalette({ open, onOpenChange, actions }: { open: boolean; onOpenChange: (open: boolean) => void; actions: PaletteActions }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { setPreference } = useTheme();
  const toast = useToast();
  const commands = useCommands();
  const runCommand = useRunCommand(ws.project.id);
  const [search, setSearch] = useState("");
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
      { id, scope: { projectId: ws.project.id, viewId: ws.view.id, itemId: ws.selectedId } },
      { onSuccess: (r) => r.toast && toast({ body: r.toast }), onError: (e) => toast({ body: e.message }) }
    );

  const actionRows = [
    { label: t("commandPalette.newIssue"), kb: "⌘N", run: actions.newIssue },
    { label: t("commandPalette.newView"), kb: undefined, run: actions.newView },
    ...(ws.dirty ? [{ label: t("commandPalette.saveView"), kb: undefined, run: ws.saveView }, { label: t("commandPalette.discardChanges"), kb: undefined, run: ws.discardChanges }] : []),
    { label: t("commandPalette.toggleAssistant"), kb: "⌘J", run: actions.toggleAssistant },
    { label: t("commandPalette.toggleSidebar"), kb: "⌘B", run: actions.toggleSidebar },
    { label: t("commandPalette.undoLastWrite"), kb: "⌘Z", run: actions.undo },
    { label: t("commandPalette.redoLastUndo"), kb: "⇧⌘Z", run: actions.redo },
    { label: t("commandPalette.history"), kb: undefined, run: actions.openHistory },
    ...LAYOUTS.map((l) => ({ label: t("commandPalette.layoutAction", { layout: LAYOUT_LABEL[l].label }), kb: undefined, run: () => ws.setLayout(l) })),
    { label: t("commandPalette.clearFilters"), kb: undefined, run: () => ws.setQuery({ ...ws.query, filter: [] }) },
    { label: t("commandPalette.viewSettings"), kb: undefined, run: actions.openViewSettings },
    { label: t("commandPalette.fields"), kb: undefined, run: actions.openFields },
    { label: t("commandPalette.codeInbox"), kb: undefined, run: actions.openCodeInbox },
    { label: t("commandPalette.switchProject"), kb: "⌘P", run: actions.openProjectMenu },
    { label: t("commandPalette.allProjects"), kb: undefined, run: () => void navigate({ to: "/" }) },
    { label: t("commandPalette.settings"), kb: "⌘,", run: actions.openSettings },
    { label: t("commandPalette.plugins"), kb: undefined, run: actions.openPlugins },
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
        <RadixDialog.Content className="palette" aria-label={t("commandPalette.ariaLabel")}>
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
              <Command.Empty className="palette-empty">{t("commandPalette.noMatches", { query: search })}</Command.Empty>

              <Command.Group heading={t("commandPalette.viewsGroup")} className="eyebrow palette-group">
                {ws.views.map((view) => (
                  <Command.Item key={view.id} value={`${view.name} ${LAYOUT_LABEL[view.layout].label}`} className="palette-row" onSelect={() => run(() => ws.openView(view.id))}>
                    <Icon name={viewIcon(view.icon)} size={14} style={{ color: "var(--meta)" }} />
                    <span className="p-label">
                      {view.name} <span className="meta-txt">· {LAYOUT_LABEL[view.layout].label}</span>
                    </span>
                    <span className="card-id">{viewCount(ws.items, view)}</span>
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
                {ws.items.filter(isTicket).slice(0, 60).map((item) => (
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
