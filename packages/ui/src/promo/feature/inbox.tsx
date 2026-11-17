import { Icon } from "~/components/icons";
import { Spacer, Tag } from "~/components/ui/atoms";
import { say } from "~/lib/dicts";
import type { Lang } from "../words";
import { Dot, Sheet, Toast, feature, pop, press, typed } from "./kit";
import { MOMENTS, step } from "./scripts";
import { INBOX_WORDS } from "./words";

const [OPEN, CONFIRM] = MOMENTS.inbox.clicks;
const [, , , SUGGESTED] = MOMENTS.inbox.lands;
const TABS = ["new", "activity", "accepted", "merged", "closed"] as const;
const kindOf = (kind: string) => (kind === "bug" ? "inbox.kind_bug" : "inbox.kind_idea") as "inbox.kind_bug" | "inbox.kind_idea";

/**
 * The project's inbox as its dialog draws it (components/dialogs/InboxDialog.tsx): the tabs with their counts, the
 * entries on the left, and on the right the open one with the worker model's suggestion, then what became of it.
 */
function Scene({ index, u, q, lang }: { index: number; u: number; q: number; lang: Lang }) {
  const words = INBOX_WORDS[lang];
  const arrived = index === 0 ? MOMENTS.inbox.lands.slice(0, 3).filter((at) => q >= at).length : 3;
  const settled = q >= CONFIRM;
  const opened = q >= OPEN;
  const counts = { new: settled ? 2 : arrived, activity: 1, accepted: 12, merged: settled ? 6 : 5, closed: 4 };
  const entries = words.entries.slice(0, arrived).filter((_, n) => !(settled && n === 0));
  const [ref, kind, title, ago] = words.entries[0];
  const draft = typed(words.reply, q, step(1) + 3.6, step(1) + 5.6);
  return (
    <>
      <Sheet x={110} y={224} w={944} k={1.8} show={index === 0 ? pop(u, 0) : 1}>
        <div className="inbox-body">
          {/* the dialog's title and its buttons share a row with the tabs here, to leave the entry its room */}
          <div className="feat-head">
            <strong className="feat-title">{say(lang, "inbox.title")}</strong>
            <div className="seg quiet inbox-tabs" role="group">
              {TABS.map((tab) => <button type="button" key={tab} aria-pressed={tab === "new"}>{say(lang, `inbox.tab_${tab}`)}{!!counts[tab] && <span className="side-count num">{counts[tab]}</span>}</button>)}
            </div>
            <Spacer />
            <button type="button" className="btn btn-secondary"><Icon name="i-sync" size={13} /> {say(lang, "inbox.pull")}</button>
          </div>
          <div className="inbox-split feat-inbox">
            <ul className="inbox-entries">
              {entries.map(([id, k, name, when], n) => (
                <li key={id} style={{ transform: index === 0 ? `scale(${pop(q, MOMENTS.inbox.lands[n])})` : undefined, transformOrigin: "0 50%" }}>
                  <button type="button" className="inbox-entry" aria-current={opened && !settled && id === ref} data-cursor={id === ref ? "entry" : undefined}>
                    <span className="inbox-entry-title">{name}</span>
                    <span className="inbox-entry-meta"><Tag tone={k === "bug" ? "neutral" : "faint"}>{say(lang, kindOf(k))}</Tag><span className="num">{id}</span><span>{when}</span></span>
                  </button>
                </li>
              ))}
            </ul>
            {!opened ? <p className="meta-txt inbox-pick">{say(lang, "inbox.pick")}</p> : (
              <article className="inbox-detail">
                <h3 className="inbox-detail-title">{title}</h3>
                <p className="inbox-detail-meta meta-txt">
                  <Tag tone="neutral">{say(lang, kindOf(kind))}</Tag>
                  <span>{say(lang, "inbox.from", { source: words.source })}</span>
                  <button type="button" className="link-inline num">{ref}</button>
                  <span>{say(lang, "inbox.by", { who: words.who })}</span>
                  <span>{ago}</span>
                </p>
                <pre className="inbox-detail-body">{words.body}</pre>
                {index >= 1 && q < SUGGESTED && (
                  <div className="row inbox-suggestion"><Icon name="i-pen" size={14} /><span className="meta-txt">{say(lang, "inbox.suggesting")}</span></div>
                )}
                {q >= SUGGESTED && !settled && (
                  <div className="panel stack-2 inbox-suggestion" style={{ transform: `scale(${0.96 + 0.04 * pop(q, SUGGESTED)})`, transformOrigin: "50% 0" }}>
                    <div className="row">
                      <Icon name="i-pen" size={14} />
                      <span className="meta-txt">{say(lang, "inbox.suggestion", { by: words.by })}</span>
                      <Spacer />
                      <button type="button" className="btn btn-ghost"><Icon name="i-sync" size={13} /> {say(lang, "inbox.suggestAgain")}</button>
                    </div>
                    <strong className="inbox-suggestion-head">{say(lang, "inbox.suggestMerge", { key: words.ticket[0], title: words.ticket[1] })}</strong>
                    {q >= step(1) + 2.4 && <p className="meta-txt dense">{words.reason}</p>}
                    {q >= step(1) + 3.4 && (
                      <>
                        <label className="row inbox-suggestion-send"><input type="checkbox" checked readOnly /><span className="meta-txt">{say(lang, "inbox.suggestSendReply")}</span></label>
                        <div className="input report-note feat-draft">{draft}</div>
                      </>
                    )}
                    <div className="row">
                      <Spacer />
                      <button type="button" className="btn btn-ghost">{say(lang, "inbox.suggestEdit")}</button>
                      <button type="button" className="btn btn-primary" data-cursor="confirm" style={{ transform: `scale(${press(q, CONFIRM)})` }}><Icon name="i-check" size={13} /> {say(lang, "inbox.suggestAdopt")}</button>
                    </div>
                  </div>
                )}
                {settled && (
                  <>
                    <div className="row inbox-status"><Icon name="i-check" size={14} /><span>{say(lang, "inbox.status_merged", { key: words.ticket[0] })}</span><button type="button" className="link-inline">{say(lang, "inbox.openTicket")}</button></div>
                    <div className="my-report-reply inbox-reply"><span className="meta-txt">{say(lang, "inbox.yourReply")}</span> {words.reply}</div>
                  </>
                )}
              </article>
            )}
          </div>
        </div>
      </Sheet>
      {index === 0 && <Dot q={q} route={[[OPEN - 1.4, [1500, 1040]], [OPEN - 0.2, "entry"], [OPEN + 1.4, "entry"]]} click={OPEN} />}
      {index === 2 && <Dot q={q} route={[[step(2) + 1.2, [1300, 1050]], [CONFIRM - 0.3, "confirm"], [CONFIRM + 0.2, "confirm"]]} click={CONFIRM} />}
      <Toast x={130} y={960} k={2.2} show={index === 2 ? pop(q, CONFIRM + 0.4) : 0}>{say(lang, "inbox.adopted")}</Toast>
    </>
  );
}

/** "Feedback comes in, the backlog fills up? Make it wait at the door." */
export const inbox = feature({ id: "inbox", poster: step(1) + 6, words: INBOX_WORDS, Scene });
