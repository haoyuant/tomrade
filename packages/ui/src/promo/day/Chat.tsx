import { Icon } from "~/components/icons";
import { say } from "~/lib/dicts";
import { clamp, span } from "../time";
import type { Lang } from "../words";
import { D, KEY, TYPED, rate } from "./story";
import { CHAT } from "./words";

/** A reply that arrives a few words at a time. */
function streamed(text: string, t: number, from: number): string {
  const parts = text.split(/(?<=[\s，。、：])/);
  return parts.slice(0, Math.ceil(parts.length * clamp(span(t, from, from + 0.55)))).join("");
}

/** The run's footer under a reply: what it changed, and the one click that takes it all back. A reverted run stays marked so. */
function RunFoot({ lang, count, reverted, cursor }: { lang: Lang; count: number; reverted: boolean; cursor?: string }) {
  return (
    <div className="run-wrap">
      <div className="run-foot">
        {reverted ? <span className="rf-note" data-cursor={cursor}>{say(lang, "agentPanel.revertedPlain")}</span> : (
          <>
            <span className="rf-note">{say(lang, count === 1 ? "agentPanel.changedOne" : "agentPanel.changedMany", { n: count })}</span>
            <button type="button" className="btn btn-ghost rf-btn" data-cursor={cursor}><Icon name="i-undo" size={12} /> {say(lang, "agentPanel.revert")}</button>
          </>
        )}
      </div>
    </div>
  );
}

/** The assistant's panel (workspace/AgentPanel.tsx): what was said, and the composer the next message is typed in. */
export function Chat({ t, lang, width }: { t: number; lang: Lang; width: number }) {
  const words = CHAT[lang];
  const typing = t < D.send ? { text: words.idea, from: TYPED.idea } : t < D.tidy ? { text: words.tidy, from: TYPED.tidy } : null;
  const typed = typing ? [...typing.text].slice(0, Math.max(0, Math.floor((t - typing.from) / (KEY * rate(lang))) + 1)).join("") : "";
  // The caret shows while a message is being typed, steady on the stroke and blinking between.
  const caret = typing !== null && t >= typing.from - 0.5 && (typed.length < [...typing.text].length || Math.floor(t * 2.6) % 2 === 0);
  return (
    <aside className="ai film-chat" style={{ width }}>
      <div className="ai-head">
        <span className="film-chat-title">{say(lang, "agentPanel.assistantLabel")}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-icon"><Icon name="i-keyboard" size={15} /></button>
        <button type="button" className="btn btn-icon"><Icon name="i-panel" size={15} /></button>
      </div>
      <div className="ai-scroll">
        <div className="turn turn-ai">
          <div className="turn-mark"><span className="prov-tick" style={{ height: 12 }} /></div>
          <div className="turn-body"><p>{say(lang, "agentPanel.introMessage")}</p></div>
        </div>
        {t >= D.send && <div className="turn turn-user"><span className="turn-rule" /><p>{words.idea}</p></div>}
        {t >= D.send + 0.55 && (
          <div className="turn turn-ai">
            <div className="turn-mark"><span className="prov-tick" style={{ height: 12 }} /></div>
            <div className="turn-body">
              <p>{streamed(words.filed, t, D.send + 0.55)}</p>
              {t >= D.ticket && <RunFoot lang={lang} count={1} reverted={false} />}
            </div>
          </div>
        )}
        {t >= D.tidy && <div className="turn turn-user"><span className="turn-rule" /><p>{words.tidy}</p></div>}
        {t >= D.tidy + 0.5 && (
          <div className="turn turn-ai">
            <div className="turn-mark"><span className="prov-tick" style={{ height: 12 }} /></div>
            <div className="turn-body">
              <p>{streamed(words.split, t, D.tidy + 0.5)}</p>
              {t >= D.split + 0.2 && <RunFoot lang={lang} count={6} reverted={t >= D.revert} cursor="revert" />}
            </div>
          </div>
        )}
      </div>
      <div className="ai-foot">
        <div className={`ai-composer${typing ? " is-typing" : ""}`}>
          <Icon name="i-plus" size={14} />
          <div className="ai-input film-chat-input">
            {typed ? <span>{typed}</span> : !caret && <span className="film-chat-hint">{say(lang, "agentPanel.messagePlaceholder")}</span>}
            {caret && <i className="film-chat-caret" />}
          </div>
          <button type="button" className="btn btn-icon" data-cursor="send"><Icon name="i-send" size={14} /></button>
        </div>
        <div className="ai-knobs" style={{ justifyContent: "space-between" }}>
          <span style={{ display: "flex", gap: 6 }}>
            <button type="button" className="tag chip-btn ctx-chip"><Icon name="i-stack" size={11} />{say(lang, "agentPanel.wholeProject")}<Icon name="i-chevdown" size={10} /></button>
          </span>
          <span style={{ display: "flex", gap: 6 }}>
            <button type="button" className="tag chip-btn">Tomrade<Icon name="i-chevdown" size={10} /></button>
          </span>
        </div>
      </div>
    </aside>
  );
}
