import { Icon } from "~/components/icons";
import { Eyebrow, Tag } from "~/components/ui/atoms";
import { interpolate, say } from "~/lib/dicts";
import { clamp, ease, span } from "../time";
import type { Lang } from "../words";
import nini from "./assets/nini-idle.webp";
import { Dot, Put, Sheet, Ticket, Toast, feature, pop, press } from "./kit";
import { MOMENTS, step } from "./scripts";
import { TAKEOVER_SOURCE, TAKEOVER_WORDS } from "./words";

const [OPEN, SCAN, TICK_0, TICK_1, TICK_2, APPLY] = MOMENTS.takeover.clicks;
const [FOUND, ...ADDED] = MOMENTS.takeover.lands;
const TICKS = [TICK_0, TICK_1, TICK_2];

/** Where an entry came from, as the draft says it: a branch and how far ahead it is, a worktree and what is uncommitted in it, an issue and who opened it. */
function source(lang: Lang, [kind, ref, n, date]: [string, string, string, string]) {
  const words = TAKEOVER_SOURCE[lang];
  const detail = kind === "branch" ? interpolate(words.branchDetail, { base: TAKEOVER_WORDS[lang].base, ahead: n, date }) : kind === "worktree" ? interpolate(words.worktreeDirty, { n }) : interpolate(words.issueDetail, { who: n });
  return <span className="meta-txt" key={ref}><Tag tone="faint">{words[kind as "branch" | "worktree" | "issue"]}</Tag>{" "}<span className="num">{ref}</span> · {detail}</span>;
}

/** The draft the scan comes back with (components/dialogs/TakeoverDialog.tsx): nothing is ticked until the person ticks it. */
function Draft({ lang, q, shown, show = 1 }: { lang: Lang; q: number; /** How many entries have come. */ shown: number; show?: number }) {
  const words = TAKEOVER_WORDS[lang];
  const ticked = TICKS.filter((at) => q >= at).length;
  return (
    <Sheet x={110} y={214} w={900} k={1.8} show={show}>
      <div className="feat-head"><strong className="feat-title">{say(lang, "takeover.title")}</strong></div>
      <div className="row" style={{ justifyContent: "space-between", gap: "var(--space-3)", marginBottom: 10 }}>
        <span className="meta-txt">{shown ? `${say(lang, "takeover.summary", { n: words.entries.length, picked: ticked })} · ${say(lang, "takeover.factsOnly")}` : say(lang, "takeover.scanning")}</span>
        {shown > 0 && (
          <span className="row" style={{ gap: "var(--space-2)" }}>
            <button type="button" className="btn btn-ghost">{say(lang, "takeover.tickAll")}</button>
            <button type="button" className="btn btn-ghost">{say(lang, "takeover.tickNone")}</button>
          </span>
        )}
      </div>
      <div className="inbox-list feat-takeover">
        {words.entries.slice(0, shown).map((entry, n) => (
          <div className="inbox-row" key={entry.title} style={{ justifyContent: "flex-start", transform: `scale(${pop(q, FOUND + n * 0.3)})`, transformOrigin: "0 50%" }}>
            <input type="checkbox" checked={n < 3 && q >= TICKS[n]} readOnly data-cursor={`tick${n}`} style={{ marginTop: 3, flexShrink: 0 }} />
            <div className="inbox-main">
              <span className="inbox-title" style={{ whiteSpace: "normal" }}>{entry.title}</span>
              {entry.sources.map((one) => source(lang, one))}
            </div>
          </div>
        ))}
      </div>
      <div className="row feat-foot">
        <span className="spacer" />
        <button type="button" className="btn btn-ghost">{say(lang, "takeover.back")}</button>
        <button type="button" className="btn btn-primary" disabled={!ticked} data-cursor="apply" style={{ transform: `scale(${press(q, APPLY)})` }}>{say(lang, "takeover.apply", { n: ticked })}</button>
      </div>
    </Sheet>
  );
}

function Scene({ index, u, q, lang }: { index: number; u: number; q: number; lang: Lang }) {
  const words = TAKEOVER_WORDS[lang];
  if (index === 0) {
    const opened = q >= OPEN;
    return (
      <>
        {/* what an empty backlog offers first (components/workspace/TakeoverBanner.tsx) */}
        <Put x={110} y={236} w={880} k={1.93} style={{ opacity: clamp(u * 4) }}>
          <div className="banner feat-banner" role="status">
            <Icon className="b-mark" name="i-branch" size={15} />
            <span>{say(lang, "takeover.bannerText")}</span>
            <button type="button" className="btn btn-secondary" data-cursor="open" style={{ marginLeft: "auto", padding: "3px 8px", flexShrink: 0, transform: `scale(${press(q, OPEN)})` }}>{say(lang, "takeover.bannerAction")}</button>
            <button type="button" className="btn btn-ghost" style={{ padding: "3px 8px", flexShrink: 0 }}>{say(lang, "workspace.dismiss")}</button>
          </div>
        </Put>
        {/* the dialog's first step: what will be read, before anything is */}
        <Sheet x={110} y={384} w={680} k={2} show={opened ? pop(q, OPEN + 0.2) : 0}>
          <div className="feat-head"><strong className="feat-title">{say(lang, "takeover.title")}</strong></div>
          <div className="stack-3">
            <p className="meta-txt" style={{ margin: 0 }}>{say(lang, "takeover.lede")}</p>
            <Eyebrow>{say(lang, "takeover.reposHeading")}</Eyebrow>
            <div className="row" style={{ gap: "var(--space-2)" }}>
              <Tag tone="neutral">{words.repo}</Tag>
              <button type="button" className="btn btn-ghost">{say(lang, "takeover.addRepo")}</button>
            </div>
            <Eyebrow>{say(lang, "takeover.readsHeading")}</Eyebrow>
            <p className="meta-txt" style={{ margin: 0 }}>{say(lang, "takeover.readsFacts")}</p>
          </div>
          <div className="row feat-foot">
            <span className="spacer" />
            <button type="button" className="btn btn-primary" data-cursor="scan" style={{ transform: `scale(${press(q, SCAN)})` }}>{say(lang, q >= SCAN ? "takeover.scanning" : "takeover.scan")}</button>
          </div>
        </Sheet>
        <Dot q={q} route={[[OPEN - 1.4, [1500, 1040]], [OPEN - 0.2, "open"], [OPEN + 0.3, "open"], [SCAN - 0.25, "scan"], [SCAN + 1.2, "scan"]]} click={[OPEN, SCAN]} />
      </>
    );
  }
  if (index === 1) {
    const shown = q < FOUND ? 0 : Math.min(words.entries.length, 1 + Math.floor((q - FOUND) / 0.3));
    return (
      <>
        <Draft lang={lang} q={q} shown={shown} show={pop(u, 0)} />
        <Dot q={q} route={[[TICK_0 - 1.2, [1500, 1040]], [TICK_0 - 0.2, "tick0"], [TICK_0 + 0.3, "tick0"], [TICK_1 - 0.2, "tick1"], [TICK_1 + 0.3, "tick1"], [TICK_2 - 0.2, "tick2"], [TICK_2 + 1.2, "tick2"]]} click={TICKS} />
      </>
    );
  }
  const gone = ease.in(span(q, APPLY + 0.25, APPLY + 0.7));
  const landed = ADDED.filter((at) => q >= at).length;
  return (
    <>
      {gone < 1 && <Draft lang={lang} q={q} shown={words.entries.length} show={1 - gone} />}
      {q >= APPLY + 0.5 && (
        <div className="feat-column" style={{ left: 110, top: 240 }}>
          <div className="feat-column-head"><b className="num">{String(landed).padStart(2, "0")}</b>{words.column}</div>
          {words.entries.slice(0, 3).map((entry, n) => (q >= ADDED[n] ? <div className="feat-column-card" key={entry.title} style={{ transform: `scale(${pop(q, ADDED[n])})` }}><Ticket id={`APP-${59 + n}`} title={entry.title} label={words.label} lang={lang} /></div> : null))}
        </div>
      )}
      <Toast x={1010} y={420} k={2.2} show={pop(q, ADDED[2] + 0.5)}>{say(lang, "takeover.applied", { n: 3 })}</Toast>
      <img className="feat-cat" src={nini} alt="" style={{ right: 150, transform: `translate3d(0, ${(1 - ease.outQuint(span(q, ADDED[0], ADDED[0] + 0.8))) * 110}%, 0)` }} />
      <Dot q={q} route={[[APPLY - 1.3, [1500, 1050]], [APPLY - 0.2, "apply"], [APPLY + 0.25, "apply"]]} click={APPLY} />
    </>
  );
}

/** "How much unfinished work is lying in that repository? Let it dig it up." */
export const takeover = feature({ id: "takeover", poster: step(1) + 6, words: TAKEOVER_WORDS, Scene, pictures: [nini] });
