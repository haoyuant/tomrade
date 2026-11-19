import { useState, type CSSProperties, type FC } from "react";
import { IconSprite } from "~/components/icons";
import { Motes } from "~/components/Motes";
import { LOOK } from "./look";
import { Cursor, Sky, type Pointer } from "./parts";
import type { Format } from "./stage";
import { FPS } from "./time";
import type { Lang } from "./words";

/** A moment in a film something is heard at: what the renderer's soundtrack is written from. */
export interface Cue {
  at: number;
  kind: "pane" | "you" | "turn" | "hop" | "ask" | "click" | "run" | "dawn" | "fact" | "end" | "night" | "key" | "tick" | "send" | "card" | "back" | "line" | "swap" | "morning";
  n: number;
}

/** One film: its length, its sky, what it draws in a frame, where the pointer goes and what is heard. */
export interface FilmDef {
  id: string;
  /** The folder its renders are kept in, under the output folder: what kind of film it is, then its own name. */
  shelf: string;
  seconds: number;
  /** The second its still is taken at: the picture a post shows before it plays. */
  poster: number;
  /** Which theme the frame is in: 0 is Daybreak, 1 is Sunrise, and between the two morning or evening is on its way across. */
  day: (t: number) => number;
  /** How high the sun stands, 0 under the horizon. */
  rise: (t: number) => number;
  /** The sky's own time, in seconds: what its lights are held at. */
  skyTime: (t: number) => number;
  /** A pass out of sight that measures what the picture needs to know before its first frame. */
  Prepare: FC<{ lang: Lang; f: Format; onDone: (prepared: unknown) => void }>;
  Picture: FC<{ t: number; f: Format; lang: Lang; prepared: unknown }>;
  pointer: Pointer;
  /** What is heard, and when; a language types its letters at its own pace. */
  cues: (lang: Lang) => Cue[];
  /** The cuts it is laid out for, if not both. */
  formats?: Format["id"][];
  /** A film that paints its whole frame itself: no sky behind it, no theme's lights. */
  bare?: boolean;
  /** Its music, when it has a beat the picture is cut to; the soundtrack's composer reads it. */
  song?: Song;
}

/** A piece of music by its style: its tempo, how many beats it runs, and the beats its parts turn at. */
export interface Song { style: "pulse" | "nocturne" | "chip" | "band"; bpm: number; beats: number; marks: Record<string, number>; band?: Band }

/**
 * A small band's part, a bar of sixteen steps at a time: which steps the kick, snare and hat play (a hat of 2 is
 * open), the bass as semitones over the chord's root, where the chord is stabbed, the chords bar by bar, a tune as
 * semitones over middle C, and how late the off steps come. Before the song's `drop` mark, and between `rest` and
 * `back`, the drums are out; at `out` it ends on one chord.
 */
export interface Band {
  swing: number; kick: number[]; snare: number[]; hat: number[]; bass: (number | null)[]; stab?: number[];
  prog: ("Am" | "F" | "C" | "G" | "Em" | "Dm")[]; tune?: (number | null)[][]; lead?: "pluck" | "square" | "piano" | "bell"; pad?: boolean; low?: "saw" | "triangle";
}

/** A film whose picture reads what its own Prepare measured. */
export function film<P>(def: Omit<FilmDef, "Prepare" | "Picture"> & { Prepare: FC<{ lang: Lang; f: Format; onDone: (prepared: P) => void }>; Picture: FC<{ t: number; f: Format; lang: Lang; prepared: P }> }): FilmDef {
  return def as unknown as FilmDef;
}

/**
 * Morning comes over the frame from where the sun is, low on the right, and evening goes back the same way: the
 * day's layer shows inside a circle around the sun, soft at its edge.
 */
function light(day: number, f: Format): CSSProperties | undefined {
  if (day >= 1) return undefined;
  const reach = Math.hypot(f.w, f.h) * 1.32;
  const edge = reach * 0.3;
  const mask = `radial-gradient(circle at 84% 108%, black ${day * reach - edge}px, transparent ${day * reach}px)`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

/** The whole picture in one theme. Between night and day two of these lie over each other, Sunrise over Daybreak. */
function Layer({ film: def, theme, day, t, f, lang, prepared }: { film: FilmDef; theme: "daybreak" | "sunrise"; day?: number; t: number; f: Format; lang: Lang; prepared: unknown }) {
  return (
    <div className={`film-layer ${theme}`} data-unified-sky="" style={day === undefined ? undefined : light(day, f)}>
      {/* In the Sunrise look the sun is up from the first frame. */}
      {!def.bare && <Sky rise={LOOK === "sunrise" ? 1 : def.rise(t)} />}
      {!def.bare && <Motes sky={theme} />}
      <def.Picture t={t} f={f} lang={lang} prepared={prepared} />
      {!def.bare && <i className="film-grain" aria-hidden="true" />}
    </div>
  );
}

/** One frame of a film. */
export function Film({ film: def, frame, f, lang }: { film: FilmDef; frame: number; f: Format; lang: Lang }) {
  const t = frame / FPS;
  const [prepared, setPrepared] = useState<unknown>(null);
  const day = def.day(t);
  return (
    <div className={`film look-${LOOK}`} data-ready={prepared === null ? undefined : ""} style={{ width: f.w, height: f.h }}>
      <IconSprite />
      {/* the end card's cat, asked for from the first frame so it is there when the end comes */}
      <i className="film-sun-cat film-preload" aria-hidden="true" />
      <def.Prepare lang={lang} f={f} onDone={setPrepared} />
      {prepared !== null && (
        <>
          {LOOK === "sunrise" ? (
            <Layer film={def} theme="sunrise" t={t} f={f} lang={lang} prepared={prepared} />
          ) : (
            <>
              {day < 1 && <Layer film={def} theme="daybreak" t={t} f={f} lang={lang} prepared={prepared} />}
              {day > 0 && <Layer film={def} theme="sunrise" day={day} t={t} f={f} lang={lang} prepared={prepared} />}
            </>
          )}
          <Cursor t={t} f={f} {...def.pointer} />
        </>
      )}
    </div>
  );
}
