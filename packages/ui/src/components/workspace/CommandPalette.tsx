import { useEffect, useState } from "react";
import { Command } from "cmdk";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import type { GroupBy } from "@tomrade/core";
import { Icon, type IconId } from "~/components/icons";
import { Kbd, StatusMark } from "~/components/ui/atoms";
import { GROUPS, isTicket, queryWithGroup } from "~/lib/domain";
import { THEME_OPTIONS, useTheme } from "~/lib/theme";
import { useWorkspace, viewCount } from "./context";

export interface PaletteActions {
  newIssue: () => void;
  toggleAssistant: () => void;
  undo: () => void;
  openSettings: () => void;
  openBoardSettings: () => void;
  openProjectMenu: () => void;
}

/** One palette spanning every board·view pair, every issue and every action. */
export function CommandPalette({ open, onOpenChange, actions }: { open: boolean; onOpenChange: (open: boolean) => void; actions: PaletteActions }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { setPreference } = useTheme();
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
                  { label: "Undo last write", kb: "⌘Z", run: actions.undo },
                  ...(Object.keys(GROUPS) as GroupBy[]).map((g) => ({ label: `Group by ${GROUPS[g].label.toLowerCase()}`, kb: undefined, run: () => setGroup(g) })),
                  { label: "Clear all filters", kb: undefined, run: () => ws.setQuery({ ...ws.query, labels: [], epics: [], priorities: [], provenance: [] }) },
                  { label: "Switch project", kb: "⌘P", run: actions.openProjectMenu },
                  { label: "All projects", kb: undefined, run: () => void navigate({ to: "/" }) },
                  { label: "Settings", kb: "⌘,", run: actions.openSettings },
                  { label: "Board settings", kb: undefined, run: actions.openBoardSettings },
                  ...THEME_OPTIONS.filter((t) => t.value !== "system").map((t) => ({ label: `Theme · ${t.label}`, kb: undefined, run: () => setPreference(t.value) }))
                ].map((action) => (
                  <Command.Item key={action.label} value={action.label} className="palette-row" onSelect={() => run(action.run)}>
                    <Icon name="i-chev" size={14} style={{ color: "var(--meta)" }} />
                    <span className="p-label">{action.label}</span>
                    {action.kb && <Kbd>{action.kb}</Kbd>}
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
