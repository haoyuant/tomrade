import { useEffect, useState } from "react";
import { Command } from "cmdk";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import type { GroupBy } from "@tomrade/domain";
import { Icon, type IconId } from "~/components/icons";
import { Kbd, StatusMark } from "~/components/ui/atoms";
import { GROUPS, isTicket, queryWithGroup } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useCommands, useRunCommand } from "~/lib/queries";
import { THEME_OPTIONS, useTheme } from "~/lib/theme";
import { useToast } from "~/lib/toast";
import { useWorkspace, viewCount } from "./context";

export interface PaletteActions {
  newIssue: () => void;
  toggleAssistant: () => void;
  toggleSidebar: () => void;
  undo: () => void;
  openSettings: () => void;
  openPlugins: () => void;
  openBoardSettings: () => void;
  openProjectSettings: () => void;
  openProjectMenu: () => void;
}

/** One palette spanning every board·view pair, every issue and every action. */
export function CommandPalette({ open, onOpenChange, actions }: { open: boolean; onOpenChange: (open: boolean) => void; actions: PaletteActions }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { setPreference } = useTheme();
  const toast = useToast();
  const commands = useCommands();
  const runCommand = useRunCommand(ws.project.id);
  const epicColumns = [...ws.epics.map((e) => e.id), "none"];
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  const setGroup = (group: GroupBy) => ws.setQuery(queryWithGroup(ws.query, group, ws.savedQuery, epicColumns));

  // Plugin commands arrive as data and run in the main process against the current scope.
  const pluginGroups = new Map<string, NonNullable<typeof commands.data>>();
  for (const c of commands.data ?? []) {
    const group = c.group ?? "Plugins";
    pluginGroups.set(group, [...(pluginGroups.get(group) ?? []), c]);
  }
  const runPlugin = (id: string) =>
    runCommand.mutate(
      { id, scope: { projectId: ws.project.id, boardId: ws.board.id, viewId: ws.view.id, itemId: ws.selectedId } },
      { onSuccess: (r) => r.toast && toast({ body: r.toast }), onError: (e) => toast({ body: e.message }) }
    );

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="scrim" />
        <RadixDialog.Content className="palette" aria-label="Command palette">
          <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
          <Command loop>
            <Command.Input
              className="palette-input"
              placeholder="Jump to a board, an issue, or run a command…"
              aria-label="Search"
              value={search}
              onValueChange={setSearch}
            />
            <Command.List className="palette-list">
              <Command.Empty className="palette-empty">Nothing matches “{search}”.</Command.Empty>

              <Command.Group heading="Spaces & views" className="eyebrow palette-group">
                {ws.boards.flatMap((board) =>
                  ws.views
                    .filter((v) => v.boardId === board.id)
                    .map((view) => (
                      <Command.Item
                        key={`${board.id}:${view.id}`}
                        value={`${board.name} ${view.name}`}
                        className="palette-row"
                        onSelect={() => run(() => ws.openSpace(board.id, view.id))}
                      >
                        <Icon name={view.icon as IconId} size={14} style={{ color: "var(--meta)" }} />
                        <span className="p-label">
                          {board.name} · {view.name}
                        </span>
                        <span className="card-id">{viewCount(ws.items, board, view, epicColumns)}</span>
                      </Command.Item>
                    ))
                )}
              </Command.Group>

              <Command.Group heading="Issues" className="eyebrow palette-group">
                {ws.items.filter(isTicket).slice(0, 60).map((item) => (
                  <Command.Item
                    key={item.id}
                    value={`${item.key} ${item.title}`}
                    className="palette-row"
                    // the pane looks the issue up across the project and names its
                    // owning board, so opening it in place beats navigating away
                    onSelect={() => run(() => ws.select(item.id))}
                  >
                    <StatusMark status={item.status} size={14} />
                    <span className="p-label">{item.title}</span>
                    <span className="card-id">{item.key}</span>
                  </Command.Item>
                ))}
              </Command.Group>

              <Command.Group heading="Actions" className="eyebrow palette-group">
                {[
                  { label: "New issue", kb: "⌘N", run: actions.newIssue },
                  { label: "Toggle assistant panel", kb: "⌘J", run: actions.toggleAssistant },
                  { label: "Toggle sidebar", kb: "⌘B", run: actions.toggleSidebar },
                  { label: "Undo last write", kb: "⌘Z", run: actions.undo },
                  ...(Object.keys(GROUPS) as GroupBy[]).map((g) => ({ label: `Group by ${GROUPS[g].label.toLowerCase()}`, kb: undefined, run: () => setGroup(g) })),
                  { label: "Clear all filters", kb: undefined, run: () => ws.setQuery({ ...ws.query, labels: [], epics: [], priorities: [], provenance: [] }) },
                  { label: "Switch project", kb: "⌘P", run: actions.openProjectMenu },
                  { label: "All projects", kb: undefined, run: () => void navigate({ to: "/" }) },
                  { label: "Settings", kb: "⌘,", run: actions.openSettings },
                  { label: "Plugins", kb: undefined, run: actions.openPlugins },
                  { label: "Board settings", kb: undefined, run: actions.openBoardSettings },
                  { label: "Project settings", kb: undefined, run: actions.openProjectSettings },
                  ...THEME_OPTIONS.filter((opt) => opt.value !== "system").map((opt) => ({ label: `Theme · ${t(opt.labelKey)}`, kb: undefined, run: () => setPreference(opt.value) }))
                ].map((action) => (
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
