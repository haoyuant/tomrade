import type { CSSProperties, ReactNode } from "react";
import { film } from "../Film";
import { Ready } from "../free/Ready";
import { clamp, ease, lerp, noise, span } from "../time";
import { OUTRO, type Lang } from "../words";
import { POSTER, POSTER_BEAT, POSTER_SECONDS, posterCues } from "./scripts";
import { POSTER_WORDS } from "./words";

type Ground = "ink" | "paper" | "red";
const W = 1920;
const H = 1080;

/** How wide a line of type is, in ems: a Chinese character takes one, a Latin letter about half. */
const ems = (text: string): number => [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e7f ? 1 : ch === " " ? 0.28 : 0.56), 0);
/** The largest size a word can be set at and still fit the frame's width. */
const fit = (text: string, width = 1640, most = 560): number => Math.min(most, width / ems(text));

/** A word that lands on its beat: large, then settling, with nothing easing in before it. */
function Slam({ q, at, children, size, x = W / 2, y = H / 2, align = "center", color }: { q: number; at: number; children: ReactNode; size: number; x?: number; y?: number; align?: "center" | "left"; color?: string }) {
  if (q < at) return null;
  const hit = ease.outQuint(span(q, at, at + 0.3));
  const style: CSSProperties = { left: x, top: y, fontSize: size, color, transform: `translate(${align === "center" ? "-50%" : "0"}, -50%) scale(${1.16 - 0.16 * hit})`, transformOrigin: align === "center" ? "50% 50%" : "0 50%" };
  return <div className="poster-word" style={style}>{children}</div>;
}

/** A row of the four status marks, filled as far as the ticket has come. */
function Marks({ stage, x, y }: { stage: number; x: number; y: number }) {
  return (
    <div className="poster-marks" style={{ left: x, top: y }}>
      {[0, 1, 2, 3].map((mark) => <i key={mark} className={mark <= stage ? "is-on" : undefined} style={{ ["--fill" as string]: mark === 3 ? 1 : mark / 3 }} />)}
    </div>
  );
}

function picture(q: number, lang: Lang): { ground: Ground; body: ReactNode } {
  const words = POSTER_WORDS[lang];
  const k = Math.floor(q);
  const one = (list: readonly string[], from: number) => <Slam key={k} q={q} at={k} size={fit(list[k - from])}>{list[k - from]}</Slam>;

  if (q < 12) {
    // the agents: a grid of dots, then each a line being written
    const dots = (writing: boolean) => (
      <div className="poster-grid" key={k}>
        {Array.from({ length: 24 }, (_, i) => {
          const on = clamp((q - k) * 9 - i * 0.22);
          return <i key={i} style={{ transform: `scale(${ease.back(on)})`, width: writing ? `${30 + 70 * noise(i, Math.floor(q * 8))}%` : undefined, borderRadius: writing ? 12 : undefined, height: writing ? 28 : undefined }} />;
        })}
      </div>
    );
    if (k < 3) return { ground: "ink", body: one(words.have, 0) };
    if (k === 3) return { ground: "ink", body: dots(false) };
    if (k < 7) return { ground: "ink", body: one(words.write, 4) };
    if (k === 7) return { ground: "ink", body: dots(true) };
    return { ground: "ink", body: one(words.who, 8) };
  }
  if (q < 16) {
    if (k < 14) return { ground: "red", body: <Slam q={q} at={12} size={fit(words.you, 1500, 820)}>{words.you}</Slam> };
    // every prompt that stops to ask, all over the frame
    const asked = Math.floor((q - 14) * 12) + 2;
    return {
      ground: "red",
      body: (
        <>
          {Array.from({ length: asked }, (_, i) => <span className="poster-ask" key={i} style={{ left: `${4 + 88 * noise(i, 1)}%`, top: `${6 + 84 * noise(i, 2)}%`, fontSize: 34 + 40 * noise(i, 3), transform: `rotate(${-8 + 16 * noise(i, 4)}deg)` }}>y/n?</span>)}
          <Slam key={k} q={q} at={k} size={fit(words.each[k - 14])}>{words.each[k - 14]}</Slam>
        </>
      )
    };
  }
  if (q < 20) {
    if (k < 18) {
      return {
        ground: "paper",
        body: (
          <>
            <i className="poster-sun" style={{ left: W / 2, top: H / 2, width: 760, height: 760, transform: `translate(-50%, -50%) scale(${ease.back(span(q, 16, 16.7))})` }} />
            <Slam q={q} at={16} size={300}><span className="poster-name">TOMRADE</span></Slam>
          </>
        )
      };
    }
    return { ground: "paper", body: one(words.hand, 18) };
  }
  if (q < 24) {
    // one verb a beat, and what it does to a piece of work
    const u = q - k;
    const blocks = (place: (i: number) => { x: number; y: number; s: number; red?: boolean; round?: boolean }) => Array.from({ length: 5 }, (_, i) => {
      const at = place(i);
      return <i className={`poster-block${at.red ? " is-red" : ""}`} key={i} style={{ left: at.x, top: at.y, width: 120, height: 120, borderRadius: at.round ? "50%" : 18, transform: `translate(-50%, -50%) scale(${at.s})` }} />;
    });
    const spread = (i: number) => 1010 + i * 170;
    const drawn: ReactNode[] = [
      <i className="poster-block" key="bar" style={{ left: 1010, top: 540, height: 120, width: lerp(0, 760, ease.outQuint(clamp(u * 2.2))), borderRadius: 60, transform: "translate(0, -50%)" }} />,
      blocks((i) => ({ x: lerp(1350, spread(i), ease.outQuint(clamp(u * 2.4))), y: 540, s: 1 })),
      blocks((i) => ({ x: spread(i) + 90 * ease.out(clamp(u * 3 - i * 0.3)), y: 540 - 40 * Math.sin(Math.PI * clamp(u * 3 - i * 0.3)), s: 1, red: clamp(u * 3 - i * 0.3) > 0.5 })),
      <>
        {blocks((i) => ({ x: lerp(spread(i) + 90, 1400, ease.inOut(clamp(u * 2.6))), y: 540, s: lerp(1, 0.3, clamp(u * 2.6)), red: true }))}
        <i className="poster-block is-red poster-tick" style={{ left: 1400, top: 540, width: 360, height: 360, borderRadius: "50%", transform: `translate(-50%, -50%) scale(${ease.back(clamp(u * 2.6 - 0.7))})` }}>✓</i>
      </>
    ];
    const verb = words.verbs[k - 20];
    return { ground: "paper", body: <><Slam key={k} q={q} at={k} size={fit(verb, 760, 560)} x={130} align="left">{verb}</Slam>{drawn[k - 20]}</> };
  }
  if (q < 32) {
    if (k >= 28) {
      if (k === 31) return { ground: "paper", body: <Slam q={q} at={31} size={620} color="var(--poster-red)">✓</Slam> };
      return { ground: "ink", body: one(words.no, 28) };
    }
    return {
      ground: "ink",
      body: (
        <>
          <Slam q={q} at={24} size={fit(words.own[0], 900, 150)} x={130} y={400} align="left">{words.own[0]}</Slam>
          <Slam q={q} at={26} size={fit(words.own[1], 900, 150)} x={130} y={620} align="left" color="var(--poster-red)">{words.own[1]}</Slam>
          {[0, 1, 2, 3, 4].map((i) => <div className="poster-row" key={i} style={{ left: 1130, top: 250 + i * 130 }}><span>APP-{53 + i}</span><Marks stage={clamp(Math.floor((q - 24) * 2) - i, 0, 3)} x={260} y={0} /></div>)}
        </>
      )
    };
  }
  if (q < 40) {
    const answered = q >= 38;
    return {
      ground: "paper",
      body: (
        <>
          <Slam q={q} at={32} size={150} x={130} y={150} align="left">{words.ask[0]}</Slam>
          <Slam q={q} at={33} size={150} x={130} y={320} align="left" color="var(--poster-red)">{words.ask[1]}</Slam>
          <Slam q={q} at={35} size={150} x={130} y={490} align="left">{words.ask[2]}</Slam>
          <div className="poster-dots">
            {Array.from({ length: 30 }, (_, i) => {
              const asks = i === 19 && !answered;
              const beatOf = q - Math.floor(q);
              return <i key={i} className={asks ? "is-asking" : undefined} style={{ transform: `scale(${asks ? 1.25 + 0.3 * Math.exp(-beatOf * 5) : i === 19 ? 1 + 0.5 * Math.exp(-(q - 38) * 4) : 1})` }} />;
            })}
          </div>
          <Slam q={q} at={39} size={300} x={1500} y={330} color="var(--poster-red)">{words.ok}</Slam>
        </>
      )
    };
  }
  if (q < 48) {
    const merged = clamp(Math.floor((q - 42) * 2) + 1, 0, 8);
    return {
      ground: "ink",
      body: (
        <>
          <i className="poster-moon" style={{ left: 1650, top: 60 }} />
          {q < 42 ? <Slam q={q} at={40} size={fit(words.sleep, 1200, 300)} x={130} y={520} align="left">{words.sleep}</Slam> : (
            <>
              <div className="poster-log">{Array.from({ length: merged }, (_, i) => <div key={i} style={{ opacity: i === merged - 1 ? 1 : 0.45 }}>PR #{231 + i} {words.merged}</div>).reverse()}</div>
              <Slam key={merged} q={q} at={42 + (merged - 1) / 2} size={640} x={1280} y={q >= 47 ? 470 : 560} color="var(--poster-red)">{merged}</Slam>
              <Slam q={q} at={47} size={150} x={1280} y={880}>{words.count}</Slam>
            </>
          )}
        </>
      )
    };
  }
  if (q < 52) {
    // the sun comes up from under the frame and takes all of it
    const up = ease.inOut(span(q, 48, 52));
    return {
      ground: "ink",
      body: (
        <>
          <i className="poster-sun" style={{ left: W / 2, top: lerp(1700, 620, up), width: 600, height: 600, transform: `translate(-50%, -50%) scale(${lerp(1, 4.2, up * up)})` }} />
          <Slam key={k} q={q} at={k} size={520} color="var(--poster-paper)">{words.dawn[k - 48]}</Slam>
        </>
      )
    };
  }
  if (q < 56) return k === 55 ? { ground: "paper", body: null } : { ground: "red", body: one(words.facts, 52) };
  const outro = OUTRO[lang];
  return {
    ground: "paper",
    body: (
      <>
        <i className="poster-sun" style={{ left: W / 2, top: 310, width: 380, height: 380, transform: `translate(-50%, -50%) scale(${ease.back(span(q, 56, 56.8))})` }}><i className="film-sun-cat" /></i>
        <Slam q={q} at={57} size={150} y={610}><span className="poster-name">TOMRADE</span></Slam>
        <Slam q={q} at={58} size={58} y={770}><span className="poster-line">{outro.tagline.replace("\n", lang === "zh" ? "" : " ")}</span></Slam>
        <Slam q={q} at={60} size={50} y={910}><span className="poster-get">{outro.get}</span></Slam>
      </>
    )
  };
}

/** "You have a lot of agents.": a poster in three colours, a word to a beat. */
export const poster = film<true>({
  id: "poster",
  seconds: POSTER_SECONDS,
  poster: 16.6 * POSTER_BEAT,
  formats: ["wide"],
  bare: true,
  song: POSTER,
  day: () => 1,
  rise: () => 0,
  skyTime: (t) => t,
  Prepare: Ready,
  Picture: ({ t, lang }) => {
    const q = t / POSTER_BEAT;
    const { ground, body } = picture(q, lang);
    // the whole sheet gives a little on every beat
    const give = 1 + 0.014 * Math.exp(-(q - Math.floor(q)) * 5);
    return <div className={`poster is-${ground}`} lang={lang}><div className="poster-sheet" style={{ transform: `scale(${give})` }}>{body}</div></div>;
  },
  pointer: { route: [], clicks: [] },
  cues: posterCues
});
