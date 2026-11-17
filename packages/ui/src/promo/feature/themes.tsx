import type { CSSProperties } from "react";
import { Icon } from "~/components/icons";
import { say } from "~/lib/dicts";
import { clamp, lerp } from "../time";
import type { Lang } from "../words";
import picture from "./assets/nini-idle.webp";
import { Dot, Put, Sheet, Ticket, Toast, feature, pop, press } from "./kit";
import { MOMENTS, step } from "./scripts";
import { THEME_WORDS } from "./words";

/** Paper's tokens, as the theme picker's own preview declares them (styles/modules/theme-preview.css .mode.paper-preview). */
const PAPER = { "--bg": "#f5f4ed", "--surface": "#faf9f5", "--surface-warm": "#e8e6dc", "--fg": "#141413", "--fg-2": "#3d3d3a", "--muted": "#504e49", "--meta": "#6b6a64", "--border": "#e8e6dc", "--border-soft": "#e5e3d8", "--border-input": "#8e8a7f", "--accent": "#1b365d", "--accent-on": "#faf9f5", "--accent-light": "#2d5a8a", "--accent-active": "#142a48" } as CSSProperties;
/** A theme made from the picture of the cat: her orange and white, and the pink she sleeps on. */
const FROM_PICTURE = { "--bg": "#fbf0e4", "--surface": "#fff9f1", "--surface-warm": "#f4e0cc", "--fg": "#40261a", "--fg-2": "#5a3a2a", "--muted": "#77523d", "--meta": "#977662", "--border": "#e6ccb4", "--border-soft": "#eedcc8", "--border-input": "#b89878", "--accent": "#d2691f", "--accent-on": "#fffaf4", "--accent-light": "#e2853f", "--accent-active": "#b15718", "--tag-bg-faint": "#f6e2d0", "--tag-bg-base": "#f2d6bf", "--tag-bg-strong": "#eec6a8", "--tag-fg": "#9a4a14", "--success": "#5d7a3a" } as CSSProperties;
/** The eight built-in themes in the picker's own order (components/dialogs/settings/ThemePane.tsx), each with the class that turns it on. */
const MODES: { id: "sunrise" | "daybreak" | "glass" | "sakura" | "dawn" | "paper" | "ink" | "matcha"; cls: string; hex: string; style?: CSSProperties }[] = [
  { id: "sunrise", cls: "sunrise", hex: "#f6f3f8" }, { id: "daybreak", cls: "daybreak", hex: "#120f24" }, { id: "glass", cls: "glass", hex: "#2b2826" }, { id: "sakura", cls: "sakura", hex: "#fbf3f4" },
  { id: "dawn", cls: "dawn", hex: "#f4ead7" }, { id: "paper", cls: "", hex: "#f5f4ed", style: PAPER }, { id: "ink", cls: "dark", hex: "#141413" }, { id: "matcha", cls: "matcha", hex: "oklch .275 .022 142" }
];
const PICKS = [step(0), ...MOMENTS.themes.clicks.slice(0, 7)];
const [GENERATE, BY_TIME] = MOMENTS.themes.clicks.slice(7);
const [DROPPED, TURNED] = MOMENTS.themes.lands;
/** Which built-in theme is picked at beat q of the first step. */
const picked = (q: number): number => Math.max(0, PICKS.filter((at) => q >= at).length - 1);

/** The whole frame wears the theme the film is on: that is what picking one does to the app. */
function frame(q: number): { className?: string; style?: CSSProperties } {
  if (q < step(0)) return { className: "feat-themes daybreak" };
  if (q < step(1)) return { className: `feat-themes ${MODES[picked(q)].cls}`, style: MODES[picked(q)].style };
  if (q < step(2)) return q < GENERATE ? { className: "feat-themes daybreak" } : { className: "feat-themes", style: FROM_PICTURE };
  if (q < step(2) + 8) return { className: `feat-themes ${q < TURNED ? "sunrise" : "daybreak"}` };
  return { className: "feat-themes daybreak" };
}

/** A column of the board, to see a theme on. */
function Piece({ lang, x, y, backdrop = false }: { lang: Lang; x: number; y: number; backdrop?: boolean }) {
  const words = THEME_WORDS[lang];
  return (
    <div className="feat-piece" style={{ left: x, top: y, background: backdrop ? `linear-gradient(color-mix(in srgb, var(--bg) 80%, transparent), color-mix(in srgb, var(--bg) 80%, transparent)), url("${picture}") center / cover no-repeat` : undefined }}>
      <div className="feat-column-head"><b className="num">03</b>{words.column}</div>
      {words.tickets.map((title, n) => <div className="feat-column-card" key={title}><Ticket id={`HOME-${12 + n}`} title={title} label={words.label} lang={lang} /></div>)}
    </div>
  );
}

function Scene({ index, u, q, lang }: { index: number; u: number; q: number; lang: Lang }) {
  if (index === 0) {
    const on = picked(q);
    return (
      <>
        <Sheet x={110} y={232} w={1214} k={1.4} show={pop(u, 0)}>
          <div className="mode-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
            {MODES.map((m, n) => (
              <button type="button" className={`mode ${m.id === "paper" ? "paper-preview" : m.cls}`} key={m.id} aria-pressed={n === on} data-cursor={`mode-${n}`} style={{ transform: `scale(${n === on ? press(q, PICKS[n]) : 1})` }}>
                <div className="mode-top"><span className="mode-name">{say(lang, `theme.${m.id}`)}</span><span className="mode-hex num">{m.hex}</span></div>
                <div className="mini-col"><span className="mini-num">02</span><span className="mini-lbl">{say(lang, "domain.status_doing")}</span></div>
                <div className="mini-card"><span /><span><span className="mini-m">TOM-31</span><br /><span className="mini-t">{say(lang, "settingsDialog.previewIssueA")}</span></span></div>
                <div className="mini-card"><span style={{ display: "flex", justifyContent: "center" }}><span className="prov-tick" style={{ height: 12 }} /></span><span><span className="mini-m">TOM-142</span><br /><span className="mini-t">{say(lang, "settingsDialog.previewIssueB")}</span></span></div>
                <div className="swatches">{["--surface", "--surface-warm", "--muted", "--accent"].map((tok) => <span key={tok} className="swatches__item" style={{ background: `var(${tok})` }} />)}</div>
              </button>
            ))}
          </div>
        </Sheet>
        <Dot q={q} route={[[step(0) + 0.2, "mode-0"], ...PICKS.slice(1).flatMap((at, n): [number, string][] => [[at - 0.15, `mode-${n + 1}`], [at + 0.3, `mode-${n + 1}`]])]} click={PICKS.slice(1)} />
      </>
    );
  }
  if (index === 1) {
    const dropped = q >= DROPPED;
    const made = q >= GENERATE;
    return (
      <>
        <Sheet x={110} y={240} w={465} k={1.85} show={pop(u, 0)}>
          <div className="panel picture-form feat-picture-form">
            <strong className="feat-title">{say(lang, "settingsDialog.themeFromImage")}</strong>
            <p className="meta-txt dense">{say(lang, "settingsDialog.themeFromImageNote")}</p>
            <div className="picture-slot">
              <span className="picture-slot-label">{say(lang, "settingsDialog.pictureMain")}</span>
              <div className="picture-slot-box">
                <button type="button" className="picture-slot-frame">
                  {dropped ? <img src={picture} alt="" style={{ transform: `scale(${pop(q, DROPPED)})` }} /> : <span className="picture-slot-empty"><Icon name="i-upload" size={16} />{say(lang, "settingsDialog.backdropChoose")}</span>}
                </button>
              </div>
            </div>
            <div className="theme-picture-veil"><span>{say(lang, "settingsDialog.pictureWho")}</span>
              <div className="theme-switch picture-who" role="group">
                <button type="button" className="theme-seg" aria-pressed={false}>{say(lang, "settingsDialog.pictureWhoAi")}</button>
                <button type="button" className="theme-seg" aria-pressed>{say(lang, "settingsDialog.pictureWhoLocal")}</button>
              </div>
            </div>
            <p className="picture-form-hint">{say(lang, "settingsDialog.pictureWhoLocalHint")}</p>
            <div className="picture-form-actions"><button type="button" className="btn btn-ghost">{say(lang, "common.cancel")}</button><button type="button" className="btn btn-primary" data-cursor="generate" style={{ transform: `scale(${press(q, GENERATE)})` }}>{say(lang, "settingsDialog.pictureGenerate")}</button></div>
          </div>
        </Sheet>
        <Piece lang={lang} x={1090} y={250} backdrop={made} />
        <Toast x={1090} y={950} show={pop(q, GENERATE + 0.3)}>{say(lang, "settingsDialog.themeFromImageLocal", { name: say(lang, "settingsDialog.customThemeName", { n: 1 }) })}</Toast>
        <Dot q={q} route={[[GENERATE - 1.4, [1000, 1050]], [GENERATE - 0.2, "generate"], [GENERATE + 1.2, "generate"]]} click={GENERATE} />
      </>
    );
  }
  const scheduled = q >= BY_TIME;
  const minutes = Math.round(lerp(16 * 60, 20 * 60, clamp((u - 2) / 6)) / 10) * 10;
  const names = { sunrise: say(lang, "theme.sunrise"), daybreak: say(lang, "theme.daybreak") };
  const AUTOMATION = [["none", "settingsDialog.automationNone", "i-stop"], ["system", "settingsDialog.automationSystem", "i-monitor"], ["schedule", "settingsDialog.automationSchedule", "i-clock"], ["shuffle", "settingsDialog.automationShuffle", "i-branch"]] as const;
  return (
    <>
      <Sheet x={110} y={250} w={548} k={1.83} show={pop(u, 0)}>
        <div className="theme-automation">
          <div className="theme-automation-row">
            <div className="theme-switch" role="group">
              {AUTOMATION.map(([value, label, icon]) => <button key={value} type="button" className="theme-seg" aria-pressed={scheduled ? value === "schedule" : value === "none"} data-cursor={value === "schedule" ? "bytime" : undefined}><Icon name={icon} size={13} />{say(lang, label)}</button>)}
            </div>
          </div>
          {scheduled && (
            <div className="automation-detail schedule-config" style={{ opacity: clamp((q - BY_TIME) * 4) }}>
              <div className="automation-detail-head"><div><span className="eyebrow">{say(lang, "settingsDialog.scheduleEyebrow")}</span><p>{say(lang, "settingsDialog.scheduleLede")}</p></div><label>{say(lang, "settingsDialog.scheduleDefault")} <span className="field-input feat-choice">{names.daybreak}</span></label></div>
              <div className="schedule-columns"><span>{say(lang, "settingsDialog.scheduleFrom")}</span><span>{say(lang, "settingsDialog.scheduleUntil")}</span><span>{say(lang, "settingsDialog.scheduleTheme")}</span><span /></div>
              {/* by day Sunrise; outside its hours the default, Daybreak */}
              {([["07:00", "18:00", "sunrise"]] as const).map(([from, until, theme]) => (
                <div className="schedule-row" key={from}>
                  <div className="field-input schedule-time">{from}</div>
                  <div className="field-input schedule-time">{until}</div>
                  <div className="field-input">{names[theme]}</div>
                  <button type="button" className="icon-btn"><Icon name="i-trash" size={13} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Sheet>
      <Piece lang={lang} x={1160} y={250} />
      <Put x={1160} y={945}><div className="feat-clock num"><Icon name={q < TURNED ? "i-sun" : "i-moon"} size={40} /><b>{String(Math.floor(minutes / 60)).padStart(2, "0")}:{String(minutes % 60).padStart(2, "0")}</b></div></Put>
      <Dot q={q} route={[[BY_TIME - 1, [900, 1050]], [BY_TIME - 0.15, "bytime"], [BY_TIME + 1.2, "bytime"]]} click={BY_TIME} />
    </>
  );
}

/** "Your dark mode says a lot about you. So have a few more." */
export const themes = feature({ id: "themes", poster: step(0) + 7.5, words: THEME_WORDS, Scene, pictures: [picture], bare: true, frame });
