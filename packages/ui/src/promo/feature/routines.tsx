import { Icon } from "~/components/icons";
import { Spacer, Tag } from "~/components/ui/atoms";
import { say } from "~/lib/dicts";
import { hit } from "../beat/kit";
import { clamp } from "../time";
import type { Lang } from "../words";
import { Dot, Put, Sheet, Ticket, Toast, feature, pop } from "./kit";
import { MOMENTS, step } from "./scripts";
import { ROUTINE_WORDS } from "./words";

const [ON] = MOMENTS.routines.clicks;
const KIND = ["tickets", "tickets", "assistant"] as const;
/** Each routine's schedule in the app's own words (lib/templates.ts cadenceLabel): every day, a day of the week. */
const when = (lang: Lang, n: number): string => {
  const at = ROUTINE_WORDS[lang].routines[n].at;
  return n === 0 ? say(lang, "cadence.daily", { at }) : say(lang, "cadence.weekly", { days: say(lang, n === 1 ? "cadence.day5" : "cadence.day4"), at });
};

/** One routine as the Routines screen draws it (components/routines/RoutinesRegion.tsx RoutineCard). */
function Routine({ lang, n, on, ran, cursor }: { lang: Lang; n: number; on: boolean; ran?: boolean; cursor?: string }) {
  const one = ROUTINE_WORDS[lang].routines[n];
  return (
    <div className={on ? "panel routine-card is-on" : "panel routine-card"}>
      <div className="row routine-card-top">
        <button type="button" className="routine-card-open cfg-name">{one.name}</button>
        <Tag tone="faint">{say(lang, KIND[n] === "assistant" ? "templates.kindAssistant" : "templates.kindTickets")}</Tag>
        <Spacer />
        <button type="button" className="switch" role="switch" aria-checked={on} data-cursor={cursor} />
        <button type="button" className="btn btn-icon is-danger routine-card-del"><Icon name="i-trash" size={14} /></button>
      </div>
      <p className="meta-txt dense routine-card-desc">{one.about}</p>
      <div className="routine-card-when">
        <Icon name="i-alarm" size={13} />
        <span>{when(lang, n)}</span>
        <span className="meta-txt">· {on ? say(lang, "templates.next", { when: one.next }) : say(lang, "templates.paused")}</span>
      </div>
      <p className="meta-txt dense">{ran ? say(lang, "templates.lastRun", { when: say(lang, "domain.time_now") }) : say(lang, "templates.never")}</p>
    </div>
  );
}

/** The hour a step turns on: a minute before it, then on it. */
function Hour({ before, at, struck, day }: { before: string; at: string; struck: number; day?: string }) {
  return <div className="feat-clock num" style={{ transform: `scale(${1 + 0.1 * struck})` }}><Icon name="i-alarm" size={40} />{day && <small>{day}</small>}<b>{struck > 0 ? at : before}</b></div>;
}

function Scene({ index, u, q, lang }: { index: number; u: number; q: number; lang: Lang }) {
  const words = ROUTINE_WORDS[lang];
  if (index === 0) {
    return (
      <>
        <Sheet x={110} y={228} w={850} k={2} show={pop(u, 0)}>
          <div className="board-head routines-head feat-head">
            <Icon className="view-ico" name="i-alarm" size={16} />
            <h1 className="board-title">{say(lang, "templates.title")}</h1>
            <Spacer />
            <button type="button" className="btn btn-secondary"><Icon name="i-plus" size={13} /> {say(lang, "templates.new")}</button>
          </div>
          <div className="routine-grid feat-routines" style={{ gridTemplateColumns: "1fr 1fr" }}>
            {[0, 1, 2].map((n) => <div key={n} style={{ transform: `scale(${pop(u, 0.5 + n * 0.5)})`, transformOrigin: "50% 60%" }}><Routine lang={lang} n={n} on={n === 0 ? q >= ON : true} cursor={n === 0 ? "on" : undefined} /></div>)}
          </div>
        </Sheet>
        <Dot q={q} route={[[ON - 1.6, [1500, 1040]], [ON - 0.2, "on"], [ON + 1.4, "on"]]} click={ON} />
      </>
    );
  }
  const struck = u >= 2 ? 0.0001 + clamp(1.4 * hit(u, 2, 1.2)) : 0;
  const card = <Put x={110} y={250} w={360} k={2.4}><Routine lang={lang} n={index === 1 ? 0 : 2} on ran={u >= 2} /></Put>;
  if (index === 1) {
    return (
      <>
        {card}
        <Put x={110} y={650} k={2.6}><Hour before="07:59" at="08:00" struck={struck} /></Put>
        <p className="feat-note" style={{ left: 110, top: 860, opacity: clamp((u - 5) * 3) }}>{say(lang, "templates.schedulesLede")}</p>
        <div className="feat-column" style={{ left: 1030, top: 240 }}>
          <div className="feat-column-head"><b className="num">{String([2.8, 3.4, 4].filter((at) => u >= at).length).padStart(2, "0")}</b>{words.column}</div>
          {words.tickets.map((title, n) => (u >= 2.8 + n * 0.6 ? <div className="feat-column-card" key={title} style={{ transform: `scale(${pop(u, 2.8 + n * 0.6)})` }}><Ticket id={`HOME-${12 + n}`} title={title} label={words.label} lang={lang} /></div> : null))}
        </div>
        <Toast x={1030} y={962} k={2.2} show={pop(u, 4.6)}>{say(lang, "templates.ranTickets", { name: words.routines[0].name, n: 3 })}</Toast>
      </>
    );
  }
  const answer = words.answer.split(/(?<=[\s，。：.:,])/);
  return (
    <>
      {card}
      <Put x={110} y={650} k={2.6}><Hour before="16:59" at="17:00" struck={struck} day={words.friday} /></Put>
      <Sheet x={1030} y={250} w={290} k={2.7} show={pop(u, 2)} className="feat-chat">
        <div className="turn turn-user"><span className="turn-rule" /><p>{words.routines[2].about}</p></div>
        {u >= 3 && (
          <div className="turn turn-ai">
            <div className="turn-mark"><span className="prov-tick" style={{ height: 12 }} /></div>
            <div className="turn-body"><p>{answer.slice(0, Math.ceil(answer.length * clamp((u - 3) / 2.2))).join("")}</p></div>
          </div>
        )}
      </Sheet>
    </>
  );
}

/** "Something you ask for every single day? Say it once." */
export const routines = feature({ id: "routines", poster: step(1) + 5, words: ROUTINE_WORDS, Scene });
