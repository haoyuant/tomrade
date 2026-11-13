import { useMemo, useState, type CSSProperties } from "react";
import { IconSprite } from "~/components/icons";
import { Motes } from "~/components/Motes";
import { BoardScene, Measure, type Measures, type Paths } from "./Board";
import { Hook } from "./Hook";
import { End, Proof } from "./Outro";
import { Caption, Cursor, Sky } from "./parts";
import { VARIANTS, paths } from "./sim";
import { dawn, type Format } from "./stage";
import { FPS, T, ease, span, track } from "./time";
import { CAPTIONS, type CaptionKey, type Lang } from "./words";

/** The captions over the board, each from its second to the next one's. */
const OVER_BOARD: [CaptionKey, number, number][] = [
  ["meet", T.turn + 0.35, 5.52],
  ["claim", 5.6, 7.42],
  ["build", 7.5, 8.98],
  ["report", 9.06, T.ask],
  ["ask", T.ask + 0.1, 13.45],
  ["bed", T.night, 16.5],
  ["wake", 16.7, T.proof - 0.05]
];

interface Scene { t: number; f: Format; lang: Lang; at: Paths; measures: Measures }

/**
 * Morning comes over the frame from where the sun is, low on the right: the day's layer shows inside a circle that
 * grows from there, soft at its edge.
 */
function light(day: number | undefined, f: Format): CSSProperties | undefined {
  if (day === undefined || day >= 1) return undefined;
  const reach = Math.hypot(f.w, f.h) * 1.32;
  const edge = reach * 0.3;
  const mask = `radial-gradient(circle at 84% 108%, black ${day * reach - edge}px, transparent ${day * reach}px)`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

/** The whole picture in one theme. At dawn two of these lie over each other, Sunrise coming in over Daybreak. */
function Layer({ theme, day, t, f, lang, at, measures }: Scene & { theme: "daybreak" | "sunrise"; /** How far the morning has come over this layer, when it is the one coming. */ day?: number }) {
  // How high the sun stands: down all night, up at dawn, higher still behind the end.
  const rise = track(t, [[0, 0.12], [T.dawn - 0.4, 0.12], [T.dawn + 2.3, 1], [T.end, 1], [T.end + 1.4, 1.25]]);
  return (
    <div className={`film-layer ${theme}`} data-unified-sky="" style={light(day, f)}>
      <Sky rise={rise} />
      <Motes sky={theme} />
      <Hook t={t} f={f} lang={lang} at={at} measures={measures} />
      <BoardScene t={t} f={f} lang={lang} at={at} measures={measures} />
      {OVER_BOARD.map(([key, from, until]) => (
        <Caption key={key} t={t} at={from} until={until} text={CAPTIONS[lang][key]} lang={lang} x={f.caption.x} y={f.caption.y} size={f.caption.size} width={f.caption.width} flat={f.id === "wide"} />
      ))}
      {t >= T.turn + 0.3 && t < 5.6 && (
        <i className="film-horizon" style={{ left: f.caption.x, top: f.caption.y + f.caption.size * 1.24, width: f.caption.size * 6.6, transformOrigin: "0 50%", transform: `scaleX(${ease.outQuint(span(t, T.turn + 0.45, T.turn + 1.25))})`, opacity: 1 - span(t, 5.3, 5.56) }} />
      )}
      <Proof t={t} f={f} lang={lang} />
      <End t={t} f={f} lang={lang} />
      <i className="film-grain" aria-hidden="true" />
    </div>
  );
}

/** One frame of the film. */
export function Film({ frame, f, lang }: { frame: number; f: Format; lang: Lang }) {
  const t = frame / FPS;
  const [measures, setMeasures] = useState<Measures | null>(null);
  const at = useMemo(() => (measures ? paths((n, variant) => measures.heights[n][VARIANTS.indexOf(variant)]) : null), [measures]);
  const day = dawn(t);
  return (
    <div className="film" data-ready={measures ? "" : undefined} style={{ width: f.w, height: f.h }}>
      <IconSprite />
      <Measure lang={lang} onDone={setMeasures} />
      {measures && at && (
        <>
          {day < 1 && <Layer theme="daybreak" t={t} f={f} lang={lang} at={at} measures={measures} />}
          {day > 0 && <Layer theme="sunrise" day={day} t={t} f={f} lang={lang} at={at} measures={measures} />}
          <Cursor t={t} f={f} />
        </>
      )}
    </div>
  );
}
