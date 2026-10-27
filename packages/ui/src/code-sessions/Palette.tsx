import { useDeferredValue, useEffect, useState } from "react";
import { Command } from "cmdk";
import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReviewHit, SessionRow, TicketRow } from "@tomradex/code-sessions";
import { isComposing } from "~/lib/keys";
import { onReviewFound, send } from "./bridge";
import { Mark, rowAgent, rowName, rowSaid, rowTitle } from "./cards";
import { keyLabel } from "./keys";
import { sessionStatus, statusOf, type HereRow } from "./lists";
import { useSay, useWords } from "./say";

export interface PaletteAction {
  id: string;
  label: string;
  kb?: string;
  run: () => void;
}

/** Without anything typed, ⌘K lists this many of the open tickets; typed, it searches all it holds. */
const TICKETS_UNTYPED = 5;

/**
 * ⌘K in the Terminal window: the app's palette for this window — its sessions waiting and in progress, tickets to
 * start in a new cell, what to do, and what ran before, the look back searched as typed. ↵ goes to a session's cell;
 * one with no cell here opens in the app window; what ended is read-only. Each row says which.
 */
export function Palette({ open, onOpenChange, here, away, ended, actions, tickets, startAgent, cellOf, onRow, onAway, onStartTicket }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  here: HereRow[];
  away: SessionRow[];
  /** Ended sessions this window knows of: the ones cells show and the ones panes ran before, newest first. */
  ended: SessionRow[];
  actions: PaletteAction[];
  /** The project's open tickets. */
  tickets: TicketRow[];
  /** The agent a ticket starts with, by name; null when none can start one here. */
  startAgent: string | null;
  /** The number of the cell that shows a row, if one does. */
  cellOf: (row: HereRow) => number | null;
  onRow: (row: HereRow) => void;
  onAway: (session: SessionRow) => void;
  onStartTicket: (ticket: TicketRow) => void;
}) {
  const say = useSay();
  const words = useWords();
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<{ query: string; rows: ReviewHit[] } | null>(null);
  // Typed, the history reaches past what the window holds: the look back's search, a moment after the typing stops.
  const typed = useDeferredValue(search.trim());
  useEffect(() => onReviewFound((post) => setFound({ query: post.query.trim(), rows: post.rows })), []);
  useEffect(() => {
    if (!open || typed.length < 2) return;
    const timer = setTimeout(() => send({ type: "reviewSearch", query: typed }), 250);
    return () => clearTimeout(timer);
  }, [open, typed]);
  useEffect(() => {
    if (open) return;
    setSearch("");
    setFound(null);
  }, [open]);
  const choose = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };
  const live = here.filter((r) => statusOf(r) !== "done");
  const waiting = live.filter((r) => statusOf(r) === "wait");
  const going = live.filter((r) => statusOf(r) !== "wait");
  const awayWaiting = away.filter((s) => sessionStatus(s) === "wait");
  const awayGoing = away.filter((s) => sessionStatus(s) !== "wait");
  // What ↵ does on the row, said where the agent's name was.
  const enterDoes = (r: HereRow, inApp: boolean) => {
    if (statusOf(r) === "done") return say("paletteReadOnly");
    if (inApp || r.kind === "thread") return say("paletteInApp");
    const n = cellOf(r);
    return n ? say("paletteToCell", { n }) : say("paletteIntoCell");
  };
  const row = (r: HereRow, onSelect: () => void = () => onRow(r), inApp = false) => {
    const status = statusOf(r);
    const name = rowName(r, say);
    const title = rowTitle(r, say);
    const said = rowSaid(r, status, say, words);
    const agent = rowAgent(r);
    return (
      <Command.Item key={r.id} value={`${name} ${title ?? ""} ${agent ?? ""} ${said ?? ""} ${r.id}`} className="palette-row" data-row={r.id} onSelect={() => choose(onSelect)}>
        <span className="palette-mark"><Mark status={status} /></span>
        <span className="p-label">
          {name}
          {title && <span className="meta-txt"> · {title}</span>}
          {agent && <span className="meta-txt"> · {agent}</span>}
          {said && <span className="meta-txt palette-said"> · {said}</span>}
        </span>
        <span className="card-id" data-testid="cs-palette-enter">{enterDoes(r, inApp)}</span>
      </Command.Item>
    );
  };
  const asRow = (s: SessionRow): HereRow => ({ kind: "session", id: s.id, session: s });
  // A session in another terminal app has no cell here: the app window shows it.
  const awayRow = (s: SessionRow) => row(asRow(s), () => onAway(s), true);
  const shownTickets = startAgent ? (search.trim() ? tickets : tickets.slice(0, TICKETS_UNTYPED)) : [];
  const known = new Set(ended.map((s) => s.id));
  const older = found && found.query === typed ? found.rows.filter((r) => !known.has(r.id)) : [];

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="scrim" />
        <RadixDialog.Content className="palette" aria-label={say("paletteTitle")} data-testid="cs-palette" onEscapeKeyDown={(e) => { if (isComposing(e)) e.preventDefault(); }}>
          <RadixDialog.Title className="sr-only">{say("paletteTitle")}</RadixDialog.Title>
          <Command loop>
            <Command.Input className="palette-input" placeholder={say("paletteSearch")} aria-label={say("paletteSearch")} value={search} onValueChange={setSearch} />
            <Command.List className="palette-list">
              <Command.Empty>
                <div className="palette-empty">{say("paletteNone")}</div>
              </Command.Empty>
              {(waiting.length > 0 || awayWaiting.length > 0) && (
                <Command.Group heading={say("paletteWaiting")} className="eyebrow palette-group" data-testid="cs-palette-waiting">
                  {waiting.map((r) => row(r))}
                  {awayWaiting.map(awayRow)}
                </Command.Group>
              )}
              {(going.length > 0 || awayGoing.length > 0) && (
                <Command.Group heading={say("paletteActive")} className="eyebrow palette-group" data-testid="cs-palette-active">
                  {going.map((r) => row(r))}
                  {awayGoing.map(awayRow)}
                </Command.Group>
              )}
              {shownTickets.length > 0 && (
                <Command.Group heading={say("paletteTickets")} className="eyebrow palette-group" data-testid="cs-palette-tickets">
                  {shownTickets.map((ticket) => (
                    <Command.Item key={ticket.id} value={`${ticket.key} ${ticket.title} ticket:${ticket.id}`} className="palette-row" data-ticket={ticket.key} onSelect={() => choose(() => onStartTicket(ticket))}>
                      <span className="p-label">
                        {say("paletteStartTicket", { key: ticket.key, agent: startAgent ?? "" })}
                        <span className="meta-txt"> · {ticket.title}</span>
                      </span>
                      <kbd className="kbd">⌥↵</kbd>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading={say("paletteDo")} className="eyebrow palette-group" data-testid="cs-palette-do">
                {actions.map((a) => (
                  <Command.Item key={a.id} value={a.label} className="palette-row" data-do={a.id} onSelect={() => choose(a.run)}>
                    <span className="p-label">{a.label}</span>
                    {a.kb && <kbd className="kbd">{a.kb}</kbd>}
                  </Command.Item>
                ))}
              </Command.Group>
              {(ended.length > 0 || older.length > 0) && (
                <Command.Group heading={say("paletteHistory")} className="eyebrow palette-group" data-testid="cs-palette-history">
                  {ended.map((s) => row(asRow(s)))}
                  {older.map((r) => (
                    <Command.Item key={`review:${r.id}`} value={`${r.key ?? ""} ${r.title} ${r.agent ?? ""} ${r.said ?? ""} review:${r.id}`} className="palette-row" data-row={`review:${r.id}`} onSelect={() => choose(() => send(r.kind === "session" ? { type: "show", sessionId: r.id } : { type: "showThread", threadId: r.id }))}>
                      <span className="palette-mark"><Mark status={r.kind === "idle" ? "idle" : "done"} /></span>
                      <span className="p-label">
                        {r.key ?? r.title}
                        {r.key && r.title && <span className="meta-txt"> · {r.title}</span>}
                        {r.agent && <span className="meta-txt"> · {r.agent}</span>}
                        {r.said && <span className="meta-txt palette-said"> · {r.said}</span>}
                      </span>
                      <span className="card-id" data-testid="cs-palette-enter">{say(r.kind === "session" ? "paletteReadOnly" : "paletteInApp")}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
            <div className="palette-foot">{say("paletteFoot", { key: keyLabel("palette") })}</div>
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
