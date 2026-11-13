import type { Format } from "../stage";
import { clamp, ease, span } from "../time";
import { CODE_WORDS, type Lang } from "../words";
import { D, LAY, LINES } from "./story";
import { TERMINAL } from "./words";

const PANES = [{ id: "claude", title: "claude", mark: "⏺" }, { id: "codex", title: "codex", mark: "•" }] as const;

/**
 * The person's own terminal, in front of the app: two agents at work in its panes. Nothing here is Tomrade's, which
 * is the point: the agents stay where they were, and the board behind follows what they do.
 */
export function Terminal({ t, f, lang }: { t: number; f: Format; lang: Lang }) {
  if (t < D.build - 0.05 || t > D.merge + 0.4) return null;
  const box = LAY[f.id].terminal;
  const wide = f.id === "wide";
  const up = ease.back(span(t, D.build, D.build + 0.6));
  const leave = ease.in(span(t, D.merge - 0.3, D.merge + 0.3));
  const most = wide ? 4 : 6;
  return (
    <div className={`film-term${wide ? " is-rows" : ""}`} style={{ left: box.x, top: box.y + (1 - up) * 90 + leave * (f.h - box.y + 40), width: box.w, height: box.h, fontSize: wide ? box.w / 44 : box.w / 55, opacity: clamp(span(t, D.build, D.build + 0.18)) }}>
      {PANES.map(({ id, title, mark }) => {
        const at = LINES[id];
        const waiting = id === "codex" && t >= D.ask && t < D.answered;
        const shown = at.filter((time) => t >= time).length;
        return (
          <div className="film-term-pane" key={id}>
            <div className="film-pane-head">
              <i className={`film-pane-dot${waiting ? "" : " is-running"}`} />
              <span>{title} · ~/paperplane</span>
              {waiting && <span className="film-pane-state">{CODE_WORDS[lang].waitingForYou}</span>}
            </div>
            <div className="film-term-lines">
              {TERMINAL[lang][id].slice(0, shown).map((line, i) => {
                if (i < shown - most) return null;
                const age = t - at[i];
                const typed = line.startsWith("$ ");
                // What the person types comes a letter at a time; what the agent writes comes at once, lit for a moment.
                const text = typed ? `${line.slice(0, 2)}${[...line.slice(2)].slice(0, Math.ceil(clamp(age / 0.4) * (line.length - 2))).join("")}` : line;
                const call = !typed && line.startsWith("tomrade");
                const good = i === at.length - 1;
                return (
                  <div className={`film-term-line${typed ? " is-typed" : ""}${good ? " is-good" : ""}`} key={i} style={typed ? undefined : { opacity: clamp(age / 0.12), backgroundColor: `color-mix(in srgb, var(--accent) ${Math.round(26 * (1 - clamp(age / 0.9)))}%, transparent)` }}>
                    {!typed && <b>{good ? "✓" : mark}</b>}
                    {call ? <><em>tomrade</em>{text.slice(7)}</> : text}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
