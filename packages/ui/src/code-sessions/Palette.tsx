import { Command } from "cmdk";
import * as RadixDialog from "@radix-ui/react-dialog";
import type { SessionRow } from "@tomradex/code-sessions";
import { isComposing } from "~/lib/keys";
import { Mark, rowAgent, rowName, rowSaid, rowTitle } from "./cards";
import { keyLabel } from "./keys";
import { sessionStatus, statusOf, type HereRow } from "./lists";
import { useSay } from "./say";

export interface PaletteAction {
  id: string;
  label: string;
  kb?: string;
  run: () => void;
}

/**
 * ⌘K in the Terminal window: the app's palette for this window — its sessions waiting and in progress, what to do,
 * and what ran before. ↵ goes to a session's cell; one with no cell here opens in the app window.
 */
export function Palette({ open, onOpenChange, here, away, ended, actions, onRow, onAway }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  here: HereRow[];
  away: SessionRow[];
  /** Ended sessions this window knows of: the ones cells show and the ones panes ran before, newest first. */
  ended: SessionRow[];
  actions: PaletteAction[];
  onRow: (row: HereRow) => void;
  onAway: (session: SessionRow) => void;
}) {
  const say = useSay();
  const choose = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };
  const live = here.filter((r) => statusOf(r) !== "done");
  const waiting = live.filter((r) => statusOf(r) === "wait");
  const going = live.filter((r) => statusOf(r) !== "wait");
  const awayWaiting = away.filter((s) => sessionStatus(s) === "wait");
  const awayGoing = away.filter((s) => sessionStatus(s) !== "wait");
  const row = (r: HereRow, onSelect: () => void = () => onRow(r)) => {
    const status = statusOf(r);
    const name = rowName(r, say);
    const title = rowTitle(r, say);
    const said = rowSaid(r, status, say);
    return (
      <Command.Item key={r.id} value={`${name} ${title ?? ""} ${rowAgent(r) ?? ""} ${said ?? ""} ${r.id}`} className="palette-row" data-row={r.id} onSelect={() => choose(onSelect)}>
        <span className="palette-mark"><Mark status={status} /></span>
        <span className="p-label">
          {name}
          {title && <span className="meta-txt"> · {title}</span>}
          {said && <span className="meta-txt palette-said"> · {said}</span>}
        </span>
        <span className="card-id">{rowAgent(r)}</span>
      </Command.Item>
    );
  };
  const asRow = (s: SessionRow): HereRow => ({ kind: "session", id: s.id, session: s });
  // A session in another terminal app has no cell here: the app window shows it.
  const awayRow = (s: SessionRow) => row(asRow(s), () => onAway(s));

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="scrim" />
        <RadixDialog.Content className="palette" aria-label={say("paletteTitle")} data-testid="cs-palette" onEscapeKeyDown={(e) => { if (isComposing(e)) e.preventDefault(); }}>
          <RadixDialog.Title className="sr-only">{say("paletteTitle")}</RadixDialog.Title>
          <Command loop>
            <Command.Input className="palette-input" placeholder={say("paletteSearch")} aria-label={say("paletteSearch")} />
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
              <Command.Group heading={say("paletteDo")} className="eyebrow palette-group" data-testid="cs-palette-do">
                {actions.map((a) => (
                  <Command.Item key={a.id} value={a.label} className="palette-row" data-do={a.id} onSelect={() => choose(a.run)}>
                    <span className="p-label">{a.label}</span>
                    {a.kb && <kbd className="kbd">{a.kb}</kbd>}
                  </Command.Item>
                ))}
              </Command.Group>
              {ended.length > 0 && (
                <Command.Group heading={say("paletteHistory")} className="eyebrow palette-group" data-testid="cs-palette-history">
                  {ended.map((s) => row(asRow(s)))}
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
