import type { ReactNode } from "react";
import { Icon } from "~/components/icons";
import { Tag } from "~/components/ui/atoms";
import { say } from "~/lib/dicts";
import type { Variant } from "../sim";
import type { Lang } from "../words";
import { Dot, Put, Sheet, Ticket, feature, pop, press } from "./kit";
import { MOMENTS, step } from "./scripts";
import { IM_WORDS } from "./words";

const [PAIR, CONFIRM] = MOMENTS.im.clicks;
const [CODE_SENT, PAIRED, ASKED, FILED, LANDED, START, STARTED, TOPIC, ...NEWS] = MOMENTS.im.lands;

/** A conversation in the chat app, drawn plainly: it is someone else's program. Who it is with, and what was said. */
function Chat({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="feat-im">
      <div className="feat-im-head"><i className="feat-im-face" aria-hidden="true" /><b>{title}</b><span>{sub}</span></div>
      <div className="feat-im-log">{children}</div>
    </div>
  );
}

/** One message: the person's on the right, the bot's on the left under its name. */
function Said({ q, at, who, children }: { q: number; at: number; /** The bot's name; none for the person's own. */ who?: string; children: ReactNode }) {
  if (q < at) return null;
  return (
    <div className={who ? "feat-im-msg" : "feat-im-msg is-mine"} style={{ transform: `scale(${pop(q, at)})` }}>
      {who && <b>{who}</b>}
      <p>{children}</p>
    </div>
  );
}

function Scene({ index, u, q, lang }: { index: number; u: number; q: number; lang: Lang }) {
  const words = IM_WORDS[lang];
  const [key, title, label] = words.ticket;
  if (index === 0) {
    const paired = q >= CONFIRM;
    return (
      <>
        {/* Settings › IM (components/dialogs/ImPane.tsx): the bot that is connected, and who is paired with it */}
        <Sheet x={110} y={228} w={400} k={2.5} show={pop(u, 0)}>
          <div className="feat-head"><strong className="feat-title">{say(lang, "imSettings.label")}</strong></div>
          <div className="stack-2">
            <div className="eyebrow">{say(lang, "imSettings.connections")}</div>
            <div className="cfg-row">
              <Icon name="i-plug" size={15} style={{ color: "var(--accent)" }} />
              <div className="cfg-name">{words.platform} <span className="meta-txt mono">{words.id}</span><div className="meta-txt dense">{say(lang, "imSettings.signedInAs", { name: words.bot })}</div></div>
              <Tag tone="strong">{say(lang, "imSettings.stateConnected")}</Tag>
              <button type="button" className="switch" role="switch" aria-checked />
            </div>
            <div className="eyebrow" style={{ marginTop: 6 }}>{say(lang, "imSettings.pairing")}</div>
            {paired ? (
              <div className="cfg-row" style={{ transform: `scale(${pop(q, CONFIRM)})`, transformOrigin: "0 50%" }}>
                <Icon name="i-check" size={13} style={{ color: "var(--accent)" }} />
                <div className="cfg-name">{words.me}<div className="meta-txt dense mono">u_48213907</div></div>
                <button type="button" className="btn btn-ghost">{say(lang, "imSettings.revoke")}</button>
              </div>
            ) : q >= CODE_SENT + 0.6 ? (
              <div className="panel row" style={{ gap: 8, flexWrap: "wrap" }} role="status">
                <span>{say(lang, "imSettings.pairClaim", { name: words.me })}</span>
                <button type="button" className="btn btn-secondary" data-cursor="confirm" style={{ transform: `scale(${press(q, CONFIRM)})` }}>{say(lang, "imSettings.pairConfirm")}</button>
                <button type="button" className="btn btn-ghost">{say(lang, "imSettings.pairReject")}</button>
              </div>
            ) : q >= PAIR ? (
              <div className="panel" role="status" style={{ display: "flex", flexDirection: "column", gap: 6, transform: `scale(${0.96 + 0.04 * pop(q, PAIR)})`, transformOrigin: "0 0" }}>
                <span className="meta-txt">{say(lang, "imSettings.pairCode")}</span>
                <span className="mono" style={{ fontSize: 18 }}>/pair {words.code}</span>
                <span className="meta-txt">{say(lang, "imSettings.pairExpires", { time: "10:12" })} · {say(lang, "imSettings.pairWaiting")}</span>
              </div>
            ) : (
              <>
                <div><button type="button" className="btn btn-secondary" data-cursor="pair" style={{ transform: `scale(${press(q, PAIR)})` }}>{say(lang, "imSettings.pairStart")}</button></div>
                <p className="meta-txt" style={{ margin: 0 }}>{say(lang, "imSettings.pairHelp")}</p>
              </>
            )}
          </div>
        </Sheet>
        <Put x={1150} y={250} w={290} k={2.5 * pop(u, 0.5)}>
          <Chat title={words.bot} sub={`${words.platform} · ${words.dm}`}>
            <Said q={q} at={CODE_SENT}>/pair {words.code}</Said>
            <Said q={q} at={CODE_SENT + 0.6} who={words.bot}>{words.received}</Said>
            <Said q={q} at={PAIRED} who={words.bot}>{words.paired}</Said>
          </Chat>
        </Put>
        {q < CODE_SENT && <Dot q={q} route={[[PAIR - 1.4, [900, 1050]], [PAIR - 0.2, "pair"], [PAIR + 1.2, "pair"]]} click={PAIR} />}
        {q >= CODE_SENT + 0.6 && <Dot q={q} route={[[CONFIRM - 0.9, [900, 1050]], [CONFIRM - 0.15, "confirm"], [CONFIRM + 0.3, "confirm"]]} click={CONFIRM} />}
      </>
    );
  }
  if (index === 1) {
    const started = q >= STARTED;
    return (
      <>
        <Put x={110} y={240} w={380} k={2.4 * pop(u, 0)}>
          <Chat title={words.bot} sub={`${words.platform} · ${words.dm}`}>
            <Said q={q} at={ASKED}>{words.ask}</Said>
            <Said q={q} at={FILED} who={words.bot}>{words.filed}</Said>
            <Said q={q} at={START}><span className="film-mono">{words.start}</span></Said>
            <Said q={q} at={STARTED} who={words.bot}>{words.started} {words.follow}</Said>
          </Chat>
        </Put>
        <div className="feat-column" style={{ left: 1070, top: 250 }}>
          <div className="feat-column-head"><b className="num">{q >= LANDED ? "01" : "00"}</b>{started ? words.doing : words.column}</div>
          {q >= LANDED && <div className="feat-column-card" style={{ transform: `scale(${started ? 1 + 0.06 * Math.sin(Math.PI * Math.min(1, (q - STARTED) / 0.5)) : pop(q, LANDED)})` }}><Ticket id={key} title={title} label={label} variant={started ? "doing" : "todo"} lang={lang} /></div>}
        </div>
      </>
    );
  }
  const said = NEWS.filter((at) => q >= at).length;
  const state = Math.max(0, said - 1);
  const variant: Variant = (["doing", "verifying", "done"] as const)[state];
  return (
    <>
      <Put x={110} y={232} w={440} k={2.15 * pop(u, 0)}>
        <Chat title={words.channel} sub={words.platform}>
          {/* the ticket's own thread: its title follows the ticket's status, and it is archived once the ticket is done */}
          <div className="feat-im-thread">
            <Icon name="i-tag" size={12} /><b>{key} {title}</b><Tag tone={state === 2 ? "faint" : "strong"}>{words.states[state]}</Tag>{state === 2 && <Tag tone="faint">{words.archived}</Tag>}
          </div>
          <Said q={q} at={TOPIC} who={words.bot}>{words.topic}</Said>
          {NEWS.map((at, n) => <Said q={q} at={at} who={words.bot} key={at}>{words.news[n]}</Said>)}
        </Chat>
      </Put>
      <Put x={1150} y={330} w={330} k={2.1}><Ticket id={key} title={title} label={label} variant={variant} lang={lang} pr={236} /></Put>
    </>
  );
}

/** "Opening the laptop just to say one thing? Say it in your chat app." */
export const im = feature({ id: "im", poster: step(1) + 4.2, words: IM_WORDS, Scene });
