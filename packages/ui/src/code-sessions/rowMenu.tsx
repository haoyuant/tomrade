import { Fragment, type ReactElement } from "react";
import { ContextMenu, ContextMenuActionItem, ContextMenuSeparator } from "~/components/ui/menu";
import { send } from "./bridge";
import { showChanges } from "./changes";
import type { HereRow } from "./lists";
import { useSay, type SayKey } from "./say";

export type RowAction = "open" | "openBeside" | "openTicket" | "changes" | "openThread" | "openWorktree" | "openPr" | "switchTo" | "copyKey" | "copyBranch" | "copyFolder" | "closeTerminal";

const NAME: Record<RowAction, SayKey> = {
  open: "menuOpen",
  openBeside: "menuOpenBeside",
  openTicket: "menuOpenTicket",
  changes: "changes",
  openThread: "openThread",
  openWorktree: "openWorktree",
  openPr: "openPr",
  switchTo: "switchTo",
  copyKey: "menuCopyKey",
  copyBranch: "menuCopyBranch",
  copyFolder: "menuCopyFolder",
  closeTerminal: "closeTerminal"
};

/** What right-clicking a row of the bar offers, in groups: where to show it, its ticket's things, what to copy, closing it. */
export function rowActions(r: HereRow): RowAction[][] {
  const s = r.session;
  const itemId = r.kind === "thread" ? r.thread.itemId : (s?.itemId ?? null);
  const key = r.kind === "thread" ? r.thread.key : (s?.key ?? null);
  const folder = r.kind === "terminal" ? r.terminal.cwd : (s?.cwd ?? s?.worktree ?? null);
  // a conversation opens in the app window; a session with a pane here can go beside the selected one
  const beside = r.kind === "terminal" || (r.kind === "session" && !!r.session.pane);
  const groups: RowAction[][] = [
    ["open", ...(beside ? ["openBeside" as const] : []), ...(s?.where === "outside" && s.switchable && s.endedAt === null ? ["switchTo" as const] : [])],
    [
      ...(itemId ? (["openTicket", "changes"] as const) : []),
      ...(s?.threadId && r.kind !== "thread" ? ["openThread" as const] : []),
      ...(s && (s.worktree || s.itemId) ? ["openWorktree" as const] : []),
      ...(s?.itemId ? ["openPr" as const] : [])
    ],
    [...(key ? ["copyKey" as const] : []), ...(s?.branch ? ["copyBranch" as const] : []), ...(folder ? ["copyFolder" as const] : [])],
    r.kind === "terminal" && !s ? ["closeTerminal"] : []
  ];
  return groups.filter((g) => g.length);
}

/** A row of the bar with its right-click menu; `onOpen` shows it as a click would, `beside` as a ⌘-click. */
export function RowMenu({ row, label, onOpen, trigger }: { row: HereRow; label: string; onOpen: (beside: boolean) => void; trigger: ReactElement }) {
  const say = useSay();
  const s = row.session;
  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => undefined);
  const run = (a: RowAction) => {
    const itemId = row.kind === "thread" ? row.thread.itemId : s?.itemId;
    const key = row.kind === "thread" ? row.thread.key : (s?.key ?? null);
    if (a === "open" || a === "openBeside") return onOpen(a === "openBeside");
    if (a === "openTicket") return itemId && send({ type: "openItem", itemId });
    if (a === "changes") return itemId && showChanges(itemId, key);
    if (a === "copyKey") return key && copy(key);
    if (a === "copyBranch") return s && copy(s.branch);
    if (a === "copyFolder") return copy(row.kind === "terminal" ? row.terminal.cwd : (s?.cwd ?? s?.worktree ?? ""));
    if (a === "closeTerminal") return row.kind === "terminal" && send({ type: "closeTerminal", terminalId: row.terminal.id });
    if (s) send({ type: a, sessionId: s.id });
  };
  const name = (a: RowAction) => (a === "open" && row.kind === "thread" ? say("openInMain") : a === "switchTo" ? say("switchTo", { terminal: s?.terminal ?? say("outsideTerminal") }) : say(NAME[a]));
  return (
    <ContextMenu label={label} trigger={trigger}>
      {rowActions(row).map((group, i) => (
        <Fragment key={i}>
          {i > 0 && <ContextMenuSeparator />}
          {group.map((a) => <ContextMenuActionItem key={a} icon={null} name={name(a)} onSelect={() => void run(a)} />)}
        </Fragment>
      ))}
    </ContextMenu>
  );
}
