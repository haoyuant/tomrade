import { Caption } from "./parts";
import type { Format } from "./stage";
import { T, clamp, ease, span } from "./time";
import { CAPTIONS, type Lang } from "./words";

/** Three short facts, one after the other, each alone on the sky. */
export function Proof({ t, f, lang }: { t: number; f: Format; lang: Lang }) {
  if (t < T.proof || t >= T.end) return null;
  const words = CAPTIONS[lang];
  const wide = f.id === "wide";
  const size = wide ? 148 : 104;
  const each = (T.end - T.proof - 0.3) / 3;
  const from = (i: number) => T.proof + 0.3 + i * each;
  const now = clamp(Math.floor((t - from(0)) / each), 0, 2);
  // The horizon's line, drawn again under each fact.
  const drawn = ease.outQuint(span(t, from(now), from(now) + 0.5));
  return (
    <>
      {[words.proof1, words.proof2, words.proof3].map((text, i) => (
        <Caption key={i} t={t} at={from(i)} until={from(i + 1)} text={text} lang={lang} x={f.w * 0.06} y={f.h / 2 - size * 1.3} size={size} width={f.w * 0.88} align="center" />
      ))}
      {t >= from(0) && <i className="film-horizon" style={{ left: f.w * 0.5, top: f.h / 2 + size * 1.25, width: f.w * (wide ? 0.5 : 0.78), transform: `translate(-50%, 0) scaleX(${drawn})`, opacity: drawn }} />}
    </>
  );
}

/** The end: the cat on the rising sun, the name, the line, and where to get it. */
export function End({ t, f, lang }: { t: number; f: Format; lang: Lang }) {
  if (t < T.end) return null;
  const words = CAPTIONS[lang];
  const wide = f.id === "wide";
  const d = t - T.end;
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
      <Caption t={t} at={T.end + 1.0} until={T.total + 1} text={words.tagline} lang={lang} x={f.w * 0.07} y={lineTop} size={lineSize} width={f.w * 0.86} align="center" serif flat={wide} />
      <div className="film-get" style={{ left: f.w / 2, top: getTop, fontSize: wide ? 44 : 52, opacity: clamp(get * 1.5), transform: `translate(-50%, 0) scale(${0.9 + 0.1 * get})` }}>{words.get}</div>
      <div className="film-fine" style={{ top: getTop + (wide ? 118 : 150), fontSize: wide ? 28 : 34, opacity: fine, transform: `translate3d(0, ${(1 - fine) * 14}px, 0)` }}>{words.platforms}</div>
    </>
  );
}
