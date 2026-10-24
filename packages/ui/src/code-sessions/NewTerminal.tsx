import { useState } from "react";
import type { TerminalPlace } from "@tomradex/code-sessions";
import { pickDirectory } from "./bridge";
import { useSay } from "./say";

/** The directory, including one chosen outside the project, then the button that opens its terminal. */
export function NewTerminal({ places, initial, ready, onOpen }: { places: TerminalPlace[]; initial?: string | null; ready: boolean; onOpen: (cwd: string) => void }) {
  const say = useSay();
  const [cwd, setCwd] = useState(initial ?? "");
  const [browsing, setBrowsing] = useState(false);
  const where = cwd || places[0]?.cwd || "";
  const options = where && !places.some((p) => p.cwd === where) ? [{ label: where, cwd: where }, ...places] : places;
  const browse = async () => {
    setBrowsing(true);
    try {
      const chosen = await pickDirectory(say("pickTerminalFolder"), say("useFolder"));
      if (chosen) setCwd(chosen);
    } finally {
      setBrowsing(false);
    }
  };
  return (
    <div className="cs-new-terminal">
      <div className="cs-new-terminal-where">
        <label>
          <span>{say("startIn")}</span>
          <select className="select" data-testid="cs-new-terminal-where" value={where} title={where} disabled={!options.length} onChange={(e) => setCwd(e.target.value)}>
            {options.map((p) => (
              <option key={p.cwd} value={p.cwd} title={p.cwd}>{p.label}</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-browse-folder" disabled={browsing} onClick={() => void browse()}>
          {say("browseFolder")}
        </button>
      </div>
      <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-new-terminal" disabled={!ready || !where || browsing} onClick={() => onOpen(where)}>
        {say("newTerminal")}
      </button>
    </div>
  );
}
