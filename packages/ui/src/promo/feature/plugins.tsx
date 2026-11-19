import type { ReactNode } from "react";
import { Icon } from "~/components/icons";
import { Eyebrow, Spacer, Tag } from "~/components/ui/atoms";
import { say } from "~/lib/dicts";
import { clamp, ease, span } from "../time";
import type { Lang } from "../words";
import nini from "./assets/nini-waiting.webp";
import { Dot, Sheet, Toast, feature, pop, press, typed } from "./kit";
import { MOMENTS, step } from "./scripts";
import { PLUGIN_WORDS } from "./words";

const [OFF, ON, START, LOAD] = MOMENTS.plugins.clicks;
const TABS = [["installed", "plugins.tabInstalled"], ["modules", "plugins.tabModules"], ["browse", "plugins.tabBrowse"], ["updates", "plugins.tabUpdates"], ["mine", "plugins.tabMine"]] as const;
/** Four of the plugins the app is made of, by the names their rows carry (packages/README.md): the pet, the inbox, routines, notes. */
const BUILT_IN = ["pet", "inbox", "schedules", "notes"];

/** Settings › Manage plugins (components/dialogs/PluginsPanel.tsx): its tabs, and what the open one shows. */
function Panel({ lang, tab, show, w = 740, children }: { lang: Lang; tab: (typeof TABS)[number][0]; show: number; /** Narrower where the cat sits beside it. */ w?: number; children: ReactNode }) {
  return (
    <Sheet x={110} y={228} w={w} k={2.3} show={show}>
      {/* the pane's title shares a row with its tabs here, to leave the rows their room */}
      <div className="feat-head">
        <strong className="feat-title">{say(lang, "settingsDialog.manageLabel")}</strong>
        <div className="seg plug-tabs" role="tablist">
          {TABS.map(([id, key]) => <button key={id} type="button" role="tab" aria-selected={tab === id} aria-pressed={tab === id}>{say(lang, key)}</button>)}
        </div>
      </div>
      {children}
    </Sheet>
  );
}

/** The cat who is a plugin too: she is there while hers is on. */
function Cat({ here }: { here: number }) {
  return <img className="feat-cat" src={nini} alt="" style={{ transform: `translate3d(0, ${(1 - here) * 110}%, 0)` }} />;
}

function Scene({ index, u, q, lang }: { index: number; u: number; q: number; lang: Lang }) {
  const words = PLUGIN_WORDS[lang];
  if (index === 0) {
    const petOn = q < OFF || q >= ON;
    return (
      <>
        <Panel lang={lang} tab="installed" show={pop(u, 0)} w={640}>
          <div className="stack-2">
            {BUILT_IN.map((id, n) => {
              const on = id !== "pet" || petOn;
              return (
                <div className={on ? "cfg-row" : "cfg-row off"} key={id} style={{ opacity: clamp((u - 0.4 - n * 0.3) * 5) }}>
                  <Icon name="i-plug" size={15} style={{ color: on ? "var(--accent)" : "var(--meta)" }} />
                  <div className="cfg-name">{id} <span className="meta-txt mono">@tomradex/{id}</span><div className="meta-txt dense">{say(lang, "pluginsPanel.provides", { list: id })}</div></div>
                  <Tag tone={on ? "strong" : "neutral"}>{say(lang, on ? "pluginsPanel.stateRunning" : "pluginsPanel.stateOff")}</Tag>
                  <button type="button" className="switch" role="switch" aria-checked={on} data-cursor={id === "pet" ? "pet" : undefined} style={{ transform: id === "pet" ? `scale(${Math.min(press(q, OFF), press(q, ON))})` : undefined }} />
                </div>
              );
            })}
          </div>
        </Panel>
        <Cat here={q < OFF ? ease.outQuint(span(u, 0.6, 1.4)) : q < ON ? 1 - ease.in(span(q, OFF, OFF + 0.5)) : ease.outQuint(span(q, ON, ON + 0.6))} />
        <Dot q={q} route={[[OFF - 1.3, [1000, 1050]], [OFF - 0.2, "pet"], [ON + 1.2, "pet"]]} click={[OFF, ON]} />
      </>
    );
  }
  if (index === 1) {
    const describe = say(lang, "plugins.describePlaceholder");
    const started = q >= START;
    const loaded = q >= LOAD;
    return (
      <>
        <Panel lang={lang} tab="mine" show={1}>
          {!started ? (
            <div className="stack-3">
              <div className="field"><label>{say(lang, "plugins.nameLabel")}</label><div className="input mono">{words.name}</div></div>
              <div className="field"><label>{say(lang, "plugins.describeLabel")}</label><div className="input feat-draft">{typed(describe, u, 0.3, 2.8)}</div></div>
              <div className="row"><Spacer /><button type="button" className="btn btn-primary" data-cursor="start" style={{ transform: `scale(${press(q, START)})` }}>{say(lang, "plugins.startBuilding")}</button></div>
            </div>
          ) : (
            <div className="stack-3">
              <div className="plug-ext">
                <div className="cfg-row">
                  <Icon name="i-plug" size={15} style={{ color: loaded ? "var(--accent)" : "var(--meta)" }} />
                  <div className="cfg-name">{words.name} <span className="meta-txt">{say(lang, "plugins.version", { version: "0.1.0" })}</span><div className="meta-txt dense">{describe}</div></div>
                  <Tag tone="strong">{say(lang, loaded ? "pluginsPanel.stateRunning" : "plugins.pending")}</Tag>
                </div>
              </div>
              {q >= START + 1 && !loaded && (
                <div className="panel stack-2" style={{ transform: `scale(${0.96 + 0.04 * pop(q, START + 1)})`, transformOrigin: "50% 0" }}>
                  <strong>{say(lang, "plugins.confirmTitle", { title: words.name })}</strong>
                  <p className="meta-txt dense">{say(lang, "plugins.confirmLede")}</p>
                  <p className="meta-txt dense">{say(lang, "plugins.noFindings")}</p>
                  <div className="row"><Spacer /><button type="button" className="btn btn-ghost">{say(lang, "plugins.notNow")}</button><button type="button" className="btn btn-primary" data-cursor="load" style={{ transform: `scale(${press(q, LOAD)})` }}>{say(lang, "plugins.load")}</button></div>
                </div>
              )}
            </div>
          )}
        </Panel>
        <Dot q={q} route={[[START - 1.2, [1300, 1050]], [START - 0.2, "start"], [START + 0.1, "start"]]} click={START} />
        <Dot q={q} route={[[START + 1.2, [1500, 1050]], [LOAD - 0.3, "load"], [LOAD + 0.2, "load"]]} click={LOAD} />
        <Toast x={130} y={960} k={2.2} show={pop(q, LOAD + 0.3)}>{say(lang, "plugins.loaded", { title: words.name })}</Toast>
      </>
    );
  }
  return (
    <Panel lang={lang} tab="browse" show={1}>
      <div className="stack-3">
        <section className="stack-2">
          <Eyebrow>{say(lang, "plugins.groupOfficial")}</Eyebrow>
          {words.store.map(([title, about], n) => (
            <button type="button" className="cfg-row plug-listing" key={title} style={{ transform: `scale(${pop(q, MOMENTS.plugins.lands[n])})`, transformOrigin: "0 50%" }}>
              <Icon name="i-plug" size={15} style={{ color: "var(--accent)" }} />
              <div className="cfg-name" style={{ textAlign: "left" }}>
                {title} <span className="meta-txt">{say(lang, "plugins.by", { publisher: "Tomrade" })}</span>
                <div className="meta-txt dense">{about}</div>
                <div className="row plug-tags" style={{ gap: 6, marginTop: 3 }}><Tag tone="strong">{say(lang, "plugins.tierOfficial")}</Tag><span className="meta-txt">{say(lang, "plugins.fromOfficial")}</span></div>
              </div>
            </button>
          ))}
        </section>
        <section className="stack-2" style={{ opacity: clamp((u - 3.4) * 4) }}>
          <Eyebrow>{say(lang, "plugins.groupCommunity")}</Eyebrow>
          <p className="meta-txt">{say(lang, "plugins.browseLede")}</p>
        </section>
      </div>
    </Panel>
  );
}

/** "Everything is a plugin. Even the cat." */
export const plugins = feature({
  id: "plugins", poster: step(0) + 2.6, words: PLUGIN_WORDS, Scene, pictures: [nini],
  Hook: ({ q }) => (q >= 2 ? <Cat here={ease.outQuint(span(q, 2, 2.7))} /> : null)
});
