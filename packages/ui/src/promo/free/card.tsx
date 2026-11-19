import { film } from "../Film";
import { End } from "../Outro";
import { Caption } from "../parts";
import { movedAt, variantAt, type Plan } from "../sim";
import { WIDE } from "../stage";
import { clamp, ease, span } from "../time";
import { TicketCard } from "../Window";
import { Ready } from "./Ready";
import { C, CARD_SECONDS, cardCues } from "./scripts";
import { CAPTIONS, PANES, STEPS } from "./words";

/** The one ticket: claimed with its agent's first line, in review with the pull request, done with the merge. */
const PLAN: Plan = {
  key: "APP-53", agent: "Claude Code", priority: 2, start: "todo", pr: 231,
  moves: [{ at: C.steps[0], to: "doing" }, { at: C.steps[3], to: "verifying" }, { at: C.steps[4], to: "done" }]
};
const clock = (t: number): number => 600 + t * 7;
/** The word each of the agent's lines stamps beside the card. */
const VERBS = ["claim", "branch", "build", "pr", "merged"] as const;
/** Where the card and the terminal under it sit, and how large the card is drawn. */
const BOX = { x: 836, y: 300, w: 962, k: 2.915 };

/** "Nobody touched this card.": one ticket, large, taken from To Do to Done by what its agent does in a terminal. */
export const card = film<true>({
  id: "card",
  shelf: "3-features/card",
  seconds: CARD_SECONDS,
  poster: 6.6,
  formats: ["wide"],
  day: () => 0,
  rise: (t) => 0.12 + 0.3 * ease.out(span(t, C.steps[4], C.steps[4] + 1.2)) + 0.5 * ease.inOut(span(t, C.end - 0.2, C.end + 1.6)),
  skyTime: (t) => t,
  Prepare: Ready,
  Picture: ({ t, lang }) => {
    const words = CAPTIONS[lang];
    const leave = ease.in(span(t, C.end - 0.1, C.end + 0.45));
    const moved = movedAt(PLAN, t);
    const bump = moved < 0 ? 0 : Math.sin(Math.PI * span(t, moved, moved + 0.45));
    const lit = moved < 0 ? 0 : 1 - span(t, moved, moved + 1.1);
    const size = lang === "zh" ? 116 : 90;
    const verb = lang === "zh" ? 170 : 104;
    return (
      <>
        {leave < 1 && (
          <div className="film-free" style={{ opacity: 1 - leave, transform: `translate3d(0, ${leave * 140}px, 0) scale(${1 - 0.04 * leave})` }}>
            <div className={`film-card film-one${lit > 0 ? " is-lit" : ""}`} style={{ left: BOX.x, top: BOX.y, transformOrigin: "0 0", transform: `scale(${BOX.k * (1 + 0.035 * bump)})`, ["--lit" as string]: lit }}>
              <TicketCard plan={PLAN} words={PANES[lang][0]} variant={variantAt(PLAN, t)} t={t} lang={lang} clock={clock} age={130} />
            </div>
            <div className="film-term film-one-term" style={{ left: BOX.x, top: 668, width: BOX.w, height: 292, fontSize: 23 }}>
              <div className="film-term-pane">
                <div className="film-pane-head"><i className="film-pane-dot is-running" /><span>claude · ~/paperplane</span></div>
                <div className="film-term-lines">
                  {STEPS[lang].map((line, i) => {
                    if (t < C.steps[i]) return null;
                    const age = t - C.steps[i];
                    const last = i === STEPS[lang].length - 1;
                    return (
                      <div className={`film-term-line${last ? " is-good" : ""}`} key={i} style={{ opacity: clamp(age / 0.12), backgroundColor: `color-mix(in srgb, var(--accent) ${Math.round(28 * (1 - clamp(age / 0.9)))}%, transparent)` }}>
                        <b>{last ? "✓" : "⏺"}</b>{line.startsWith("tomrade") ? <><em>tomrade</em>{line.slice(7)}</> : line}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}
        <Caption t={t} at={-1.5} until={C.steps[0] - 0.08} text={words.card1} lang={lang} x={122} y={372} size={size} width={700} />
        <Caption t={t} at={0.8} until={C.steps[0] - 0.08} text={words.card2} lang={lang} x={122} y={372 + size * 1.1} size={size} width={700} />
        {VERBS.map((key, i) => (
          <Caption key={key} t={t} at={C.steps[i]} until={(C.steps[i + 1] ?? C.own) - 0.08} text={words[key]} lang={lang} x={122} y={420} size={verb} width={700} />
        ))}
        <Caption t={t} at={C.own} until={C.end} text={words.own1} lang={lang} x={122} y={372} size={size} width={700} />
        <Caption t={t} at={C.own + 0.35} until={C.end} text={words.own2} lang={lang} x={122} y={372 + size * 1.1} size={size} width={700} />
        <End d={t - C.end} f={WIDE} lang={lang} />
      </>
    );
  },
  pointer: { route: [], clicks: [] },
  cues: cardCues
});
