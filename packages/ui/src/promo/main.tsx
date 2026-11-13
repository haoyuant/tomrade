import "./seed";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { setDomainLocale } from "~/lib/domain";
import { LocaleWords } from "~/lib/i18n";
import { Film, type Cue, type Song } from "./Film";
import { FILMS } from "./films";
import { TALL, WIDE } from "./stage";
import { FPS, clamp } from "./time";
import type { Lang } from "./words";
import "~/styles/app.css";
import "~/styles/sunrise.css";
import "~/code-sessions/code-sessions.css";
import "./promo.css";

declare global {
  interface Window {
    /** What the renderer drives: draw frame n, resolved once it is on screen. */
    __film?: { films: string[]; shelf: string; formats: string[]; poster: number; frames: number; fps: number; width: number; height: number; cues: Cue[]; song: Song | null; ready: () => boolean; seek: (frame: number) => Promise<void> };
  }
}

const params = new URLSearchParams(location.search);
const film = FILMS.find((one) => one.id === params.get("film")) ?? FILMS[0];
const FRAMES = Math.round(film.seconds * FPS);
const f = params.get("format") === "tall" ? TALL : WIDE;
const lang: Lang = params.get("lang") === "zh" ? "zh" : "en";
/** Filming: the stage at its own size, one frame at a time. Otherwise the film plays in the window, to look at. */
const capture = params.has("capture");
setDomainLocale(lang);
document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";

/** The end card's cat: a film is ready to be drawn once it has loaded. */
const logo = new Image();
logo.src = `${import.meta.env.BASE_URL}logo.png`;

/** The frame's number as a colour the renderer reads back: four bits a channel, so no rounding along the way can blur it. */
const mark = (frame: number): string => `rgb(${((frame >> 8) & 15) * 16 + 8}, ${((frame >> 4) & 15) * 16 + 8}, ${(frame & 15) * 16 + 8})`;

function Player() {
  const [frame, setFrame] = useState(() => clamp(Math.round(Number(params.get("frame") ?? 0)), 0, FRAMES - 1));
  const [playing, setPlaying] = useState(!capture && !params.has("frame"));
  const [fit, setFit] = useState(1);
  const shown = useRef(frame);
  useLayoutEffect(() => {
    shown.current = frame;
    // The sky's lights are CSS animations: held at the film's time, never the clock's.
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = film.skyTime(frame / FPS) * 1000;
    }
  });
  useEffect(() => {
    if (!capture) return;
    window.__film = {
      films: FILMS.map((one) => one.id), shelf: film.shelf, formats: film.formats ?? ["wide", "tall"], poster: Math.round(film.poster * FPS), frames: FRAMES, fps: FPS, width: f.w, height: f.h, cues: film.cues(lang), song: film.song ?? null,
      ready: () => document.querySelector(".film[data-ready]") !== null && logo.complete,
      seek: (n) => new Promise((resolve) => {
        flushSync(() => setFrame(n));
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
    };
  }, []);
  useEffect(() => {
    if (capture) return;
    const size = () => setFit(Math.min(window.innerWidth / f.w, (window.innerHeight - 44) / f.h));
    size();
    window.addEventListener("resize", size);
    const key = (e: KeyboardEvent) => {
      if (e.key === " ") setPlaying((on) => !on);
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        setPlaying(false);
        setFrame((n) => clamp(n + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? FPS : 1), 0, FRAMES - 1));
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("resize", size);
      window.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    if (!playing) return;
    const from = performance.now() - (shown.current / FPS) * 1000;
    let raf = requestAnimationFrame(function tick(now) {
      setFrame(Math.floor(((now - from) / 1000) * FPS) % FRAMES);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  return (
    <LocaleWords locale={lang}>
      <div className="film-fit" style={capture ? undefined : { transform: `scale(${fit})`, marginLeft: Math.max(0, (window.innerWidth - f.w * fit) / 2) }}>
        <Film film={film} frame={frame} f={f} lang={lang} />
      </div>
      {capture ? (
        <i className="film-mark" style={{ top: f.h, background: mark(frame) }} />
      ) : (
        <div className="film-bar">
          <button type="button" onClick={() => setPlaying((on) => !on)}>{playing ? "Pause" : "Play"}</button>
          <input type="range" min={0} max={FRAMES - 1} value={frame} onChange={(e) => { setPlaying(false); setFrame(Number(e.target.value)); }} />
          <span>{film.id} · {(frame / FPS).toFixed(2)}s · frame {frame}</span>
        </div>
      )}
    </LocaleWords>
  );
}

createRoot(document.getElementById("film")!).render(<Player />);
