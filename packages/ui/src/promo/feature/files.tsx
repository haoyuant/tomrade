import type { ReactNode } from "react";
import { Icon } from "~/components/icons";
import { Eyebrow, Spacer } from "~/components/ui/atoms";
import { say } from "~/lib/dicts";
import { hit } from "../beat/kit";
import { clamp } from "../time";
import type { Lang } from "../words";
import { Dot, Put, Sheet, Ticket, feature, pop } from "./kit";
import { MOMENTS, step } from "./scripts";
import { FILE_WORDS } from "./words";

const [OPENED, ASKED] = MOMENTS.files.clicks;
const [LINKED, ATTACHED, ANSWERED] = MOMENTS.files.lands;

/** A line of a note as the reader draws it: a [[wiki link]] in it is a link. */
const linked = (text: string): ReactNode => text.split(/(\[\[[^\]]+\]\])/).map((part, i) => (part.startsWith("[[") ? <a className="wikilink" key={i}>{part.slice(2, -2)}</a> : part));

/** The Files sidebar's tree (components/files/FilesTree.tsx): folders open, one file current. */
function Tree({ lang, shown, current }: { lang: Lang; shown: number; current: boolean }) {
  const words = FILE_WORDS[lang];
  return (
    <div className="feat-files-side">
      <Eyebrow className="side-label side-module-title">{say(lang, "files.eyebrow")}</Eyebrow>
      <div className="side-list side-files-list">
        {words.tree.slice(0, shown).map(([name, depth, dir], n) => (
          <div className="side-file-row-container" key={name}>
            <button type="button" className={`side-row is-file${dir ? " is-dir" : ""}`} data-depth={depth} style={{ ["--depth" as string]: depth }} aria-current={current && n === words.open} data-cursor={n === words.open ? "note" : undefined}>
              {dir ? <span className="ico chev"><Icon name="i-chevdown" size={12} /></span> : <Icon className="ico" name="i-file" size={14} />}
              <span className="side-name">{name}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The note in the reader (components/files/FileView.tsx): the mode bar, then the page; `mark` lights the line an agent found. */
function Note({ lang, lines = 9, pulse = 0, mark = false, bar = true, children }: { lang: Lang; lines?: number; pulse?: number; mark?: boolean; bar?: boolean; children?: ReactNode }) {
  const note = FILE_WORDS[lang].note;
  return (
    <div className="feat-files-main">
      {bar && (
        <div className="row file-view-bar files-mode-bar">
          <div className="seg quiet files-mode" role="group">
            <button type="button" aria-pressed><Icon className="ico" name="i-eye" size={13} />{say(lang, "notes.read")}</button>
            <button type="button" aria-pressed={false}><Icon className="ico" name="i-pen" size={13} />{say(lang, "notes.edit")}</button>
            <button type="button" aria-pressed={false}><Icon className="ico" name="i-split" size={13} />{say(lang, "notes.split")}</button>
          </div>
          <Spacer />
          <span className="meta-txt files-save-state">{say(lang, "notes.saved")}</span>
        </div>
      )}
      <div className="md-view feat-note-page">
        <h1>{note.title}</h1>
        {lines >= 1 && <p>{mark ? <mark>{note.lines[0]}</mark> : note.lines[0]}</p>}
        {lines >= 2 && <p>{note.lines[1]}</p>}
        {lines >= 3 && <p>{note.see}<a className="wikilink" style={{ boxShadow: `0 0 0 ${6 * pulse}px color-mix(in srgb, var(--accent) 35%, transparent)`, borderRadius: 4 }}>{note.link}</a>{lang === "zh" ? "。" : "."} <a className="hashtag">{note.tag}</a></p>}
      </div>
      {children}
    </div>
  );
}

function Scene({ index, u, q, lang }: { index: number; u: number; q: number; lang: Lang }) {
  const words = FILE_WORDS[lang];
  if (index < 2) {
    const opened = q >= OPENED;
    return (
      <>
        <Sheet x={110} y={228} w={850} k={2} show={index === 0 ? pop(u, 0) : 1} className="feat-files">
          <Tree lang={lang} shown={index === 0 ? Math.floor(clamp(u / 1.6) * words.tree.length + 0.001) : words.tree.length} current={opened} />
          {opened ? (
            <Note lang={lang} lines={index === 0 ? Math.floor((q - OPENED) / 0.7) : 9} pulse={index === 1 ? hit(u, 0.8, 1.6) : 0}>
              {q >= LINKED && (
                <section className="note-backlinks feat-backlinks" style={{ opacity: clamp((q - LINKED) * 4) }}>
                  <div className="note-backlinks-head"><Icon name="i-link" size={13} /><Eyebrow>{say(lang, "notes.linked")}</Eyebrow><span className="meta-txt num">{words.backlinks.length}</span></div>
                  <div className="mention-list" data-kind="linked">
                    {words.backlinks.map(([name, path, text], n) => (q >= LINKED + 0.5 + n * 0.6 ? (
                      <div className="mention-row" key={name}>
                        <button type="button" className="mention-open"><span className="mention-name">{name}</span><span className="mention-path meta-txt num">{path}</span><span className="mention-text">{linked(text)}</span></button>
                      </div>
                    ) : null))}
                  </div>
                </section>
              )}
            </Note>
          ) : <div className="feat-files-main" />}
        </Sheet>
        {index === 0 && <Dot q={q} route={[[OPENED - 1.3, [1300, 1040]], [OPENED - 0.2, "note"], [OPENED + 1.2, "note"]]} click={OPENED} />}
        {q >= ATTACHED && (
          <Put x={1190} y={440} w={290} k={2.1 * pop(q, ATTACHED)}>
            <Ticket id={words.ticket[0]} title={words.ticket[1]} label={words.ticket[2]} lang={lang} />
            <span className="tag strong feat-attached"><Icon name="i-file" size={12} /> {words.tree[words.open][0]} · {say(lang, "files.attachAsMaterial")}</span>
          </Put>
        )}
      </>
    );
  }
  const asked = q >= ASKED;
  const answer = words.answer.split(/(?<=[\s，。：.:,])/);
  return (
    <>
      <Sheet x={110} y={250} w={330} k={2.8} show={pop(u, 0)} className="feat-chat">
        {asked && <div className="turn turn-user"><span className="turn-rule" /><p>{words.ask}</p></div>}
        {q >= ASKED + 0.8 && <div className="feat-tool"><Icon name="i-search" size={12} /><span className="film-mono">search_notes</span><span className="meta-txt">{words.from}</span></div>}
        {q >= ANSWERED && (
          <div className="turn turn-ai">
            <div className="turn-mark"><span className="prov-tick" style={{ height: 12 }} /></div>
            <div className="turn-body"><p>{answer.slice(0, Math.ceil(answer.length * clamp((q - ANSWERED) / 1.4))).join("")}</p></div>
          </div>
        )}
        <div className={`ai-composer feat-composer${asked ? "" : " is-typing"}`}>
          <Icon name="i-plus" size={14} />
          <div className="ai-input film-chat-input">{asked ? <span className="film-chat-hint">{say(lang, "agentPanel.messagePlaceholder")}</span> : <><span>{[...words.ask].slice(0, Math.ceil(clamp(u / 1.2) * [...words.ask].length)).join("")}</span><i className="film-chat-caret" /></>}</div>
          <button type="button" className="btn btn-icon" data-cursor="send"><Icon name="i-send" size={14} /></button>
        </div>
      </Sheet>
      <Sheet x={1110} y={250} w={250} k={2.8} show={pop(u, 0.4)} className="feat-files is-alone">
        <Note lang={lang} bar={false} mark={q >= ASKED + 0.8} />
      </Sheet>
      <Dot q={q} route={[[ASKED - 1.1, [800, 1050]], [ASKED - 0.2, "send"], [ASKED + 0.9, "send"]]} click={ASKED} />
    </>
  );
}

/** "Notes in one app, to-dos in another? Your notebook sits beside the board." */
export const files = feature({ id: "files", poster: step(1) + 6.5, words: FILE_WORDS, Scene });
