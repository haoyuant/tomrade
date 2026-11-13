import { Caption } from "./parts";
import type { Format } from "./stage";
import { clamp, ease, span } from "./time";
import { OUTRO, type Lang } from "./words";

/** Short facts, one after the other, each alone on the sky. */
export function Proof({ t, from, until, texts, f, lang }: { t: number; from: number; until: number; texts: readonly string[]; f: Format; lang: Lang }) {
  if (t < from || t >= until) return null;
  const wide = f.id === "wide";
  const size = wide ? 148 : 104;
  const each = (until - from - 0.3) / texts.length;
  const start = (i: number) => from + 0.3 + i * each;
  const now = clamp(Math.floor((t - start(0)) / each), 0, texts.length - 1);
  // The horizon's line, drawn again under each fact.
  const drawn = ease.outQuint(span(t, start(now), start(now) + 0.5));
  return (
    <>
      {texts.map((text, i) => (
        <Caption key={i} t={t} at={start(i)} until={start(i + 1)} text={text} lang={lang} x={f.w * 0.06} y={f.h / 2 - size * 1.3} size={size} width={f.w * 0.88} align="center" />
      ))}
      {t >= start(0) && <i className="film-horizon" style={{ left: f.w * 0.5, top: f.h / 2 + size * 1.25, width: f.w * (wide ? 0.5 : 0.78), transform: `translate(-50%, 0) scaleX(${drawn})`, opacity: drawn }} />}
    </>
  );
}

/** The end: the cat on the rising sun, the name, the line, and where to get it. `d` is how long it has been up. */
export function End({ d, f, lang }: { d: number; f: Format; lang: Lang }) {
  if (d < 0) return null;
  const words = OUTRO[lang];
  const wide = f.id === "wide";
  const r = wide ? 158 : 214;
  const sunY = wide ? 296 : 600;
  const up = ease.outQuint(span(d, 0, 1.1));
  const name = "TOMRADE";
  const nameTop = sunY + r + (wide ? 44 : 70);
  const nameSize = wide ? 100 : 116;
  const lineTop = nameTop + nameSize * 1.36;
  const lineSize = wide ? 58 : 74;
  const getTop = wide ? lineTop + 138 : lineTop + 262;
  const get = ease.back(span(d, 1.55, 2.0));
  const fine = ease.out(span(d, 1.95, 2.4));
  return (
    <>
      <i className="film-rays" style={{ left: f.w / 2, top: sunY, opacity: 0.9 * ease.out(span(d, 0.25, 1.4)), transform: `translate(-50%, -50%) rotate(${d * 2.2}deg) scale(${0.9 + 0.1 * up})` }} />
      <div className="film-sun" style={{ left: f.w / 2, top: sunY + (1 - up) * 300, width: 2 * r, height: 2 * r, opacity: clamp(span(d, 0, 0.35)), transform: `translate(-50%, -50%) scale(${0.86 + 0.14 * up})` }}>
        <i className="film-sun-cat" />
      </div>
      <div className="film-name" style={{ top: nameTop, fontSize: nameSize }}>
        {[...name].map((letter, i) => {
          const u = ease.outQuint(span(d, 0.55 + i * 0.045, 1.15 + i * 0.045));
          return <span key={i} style={{ opacity: clamp(u * 2.5), transform: `translate3d(0, ${(1 - u) * 46}px, 0)` }}>{letter}</span>;
        })}
      </div>
      <Caption t={d} at={1.0} until={Infinity} text={words.tagline} lang={lang} x={f.w * 0.07} y={lineTop} size={lineSize} width={f.w * 0.86} align="center" serif flat={wide} />
      <div className="film-get" style={{ left: f.w / 2, top: getTop, fontSize: wide ? 44 : 52, opacity: clamp(get * 1.5), transform: `translate(-50%, 0) scale(${0.9 + 0.1 * get})` }}>{words.get}</div>
      <div className="film-fine" style={{ top: getTop + (wide ? 118 : 150), fontSize: wide ? 28 : 34, opacity: fine, transform: `translate3d(0, ${(1 - fine) * 14}px, 0)` }}>{words.platforms}</div>
    </>
  );
}
