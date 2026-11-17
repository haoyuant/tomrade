import { useEffect, useLayoutEffect, useRef, type CSSProperties, type FC, type ReactNode } from "react";
import { hit } from "../beat/kit";
import { film, type FilmDef } from "../Film";
import { End } from "../Outro";
import { Caption } from "../parts";
import type { Plan, Variant } from "../sim";
import { WIDE } from "../stage";
import { clamp, ease, lerp, span } from "../time";
import { TicketCard } from "../Window";
import type { Lang } from "../words";
import { HOOK, OUT, WHY, beatOf, cuesOf, secondsOf, SONGS, step, stepAt, type FeatureId } from "./scripts";
import type { FeatureWords } from "./words";

/** Something that lands: up from nothing a little past its size, and settled 0.6 beats later. */
export const pop = (u: number, at: number): number => (u < at ? 0 : ease.back(span(u, at, at + 0.6)));
/** A control under a click at beat `at`: pressed in, and back. */
export const press = (q: number, at: number): number => 1 - 0.07 * hit(q, at, 7);
/** As much of a text as has been typed between two beats. */
export const typed = (text: string, u: number, from: number, until: number): string => [...text].slice(0, Math.ceil(clamp(span(u, from, until)) * [...text].length)).join("");

/** A piece of the app's own interface on a sheet, in its own pixels and drawn k times as large. */
export function Sheet({ x, y, w, k = 2, show = 1, className, style, children }: { x: number; y: number; w: number; k?: number; /** 0 to 1 as it comes in. */ show?: number; className?: string; style?: CSSProperties; children: ReactNode }) {
  if (show <= 0) return null;
  return <div className={`feat-sheet${className ? ` ${className}` : ""}`} style={{ left: x, top: y, width: w, transform: `scale(${k * (0.96 + 0.04 * clamp(show))})`, opacity: clamp(show * 2.5), ...style }}>{children}</div>;
}

/** The same without the sheet: one piece placed and scaled. */
export function Put({ x, y, w, k = 2, style, children }: { x: number; y: number; w?: number; k?: number; style?: CSSProperties; children: ReactNode }) {
  return <div className="vg-put" style={{ left: x, top: y, width: w, transform: `scale(${k})`, ...style }}>{children}</div>;
}

/** Where the pointer goes: to what a scene marks with data-cursor, or to a point of the frame in its own pixels. */
type Stop = [beat: number, to: string | [number, number]];

/**
 * The person's pointer for one trip: through its stops, there from the first to the last, pressing at `click`. Like
 * the films' own Cursor it reads where its targets are drawn this frame.
 */
export function Dot({ q, route, click }: { q: number; route: Stop[]; click?: number | number[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const stage = el?.closest(".feat");
    if (!el || !stage) return;
    const box = stage.getBoundingClientRect();
    const k = box.width / WIDE.w;
    const point = (to: Stop[1]): { x: number; y: number } | null => {
      if (typeof to !== "string") return { x: to[0], y: to[1] };
      const target = stage.querySelector(`[data-cursor="${to}"]`);
      if (!target) return null;
      const r = target.getBoundingClientRect();
      return { x: (r.left + r.width * 0.5 - box.left) / k, y: (r.top + r.height * 0.62 - box.top) / k };
    };
    const next = Math.max(1, route.findIndex(([at]) => at > q));
    const [from, to] = [point(route[next - 1][1]), point(route[next][1])];
    // what it was going to has gone (the click did that): it goes with it
    el.style.visibility = from && to ? "visible" : "hidden";
    if (!from || !to) return;
    const u = ease.inOut(span(q, route[next - 1][0], route[next][0]));
    el.style.transform = `translate3d(${lerp(from.x, to.x, u)}px, ${lerp(from.y, to.y, u)}px, 0)`;
  });
  if (q < route[0][0] || q > route[route.length - 1][0]) return null;
  const pressed = [click ?? []].flat().find((at) => q >= at && q < at + 1);
  const down = pressed === undefined ? 0 : Math.sin(Math.PI * span(q, pressed, pressed + 0.4));
  return (
    <div className="film-cursor feat-pointer" ref={ref} aria-hidden="true">
      {pressed !== undefined && <i className="film-cursor-ring" style={{ transform: `translate(-50%, -50%) scale(${ease.out(span(q, pressed, pressed + 1))})`, opacity: 0.6 * (1 - span(q, pressed, pressed + 1)) }} />}
      <svg width="54" height="73" viewBox="0 0 17 23" style={{ transform: `scale(${1 - 0.14 * down})` }}><path d="M1.5 1.5v16.6l4-3.7 2.7 6.3 2.6-1.1-2.7-6.2h5.5z" /></svg>
    </div>
  );
}

/** A ticket's card in the board's own markup, for a scene that is not a board. */
export function Ticket({ id, title, label, variant = "todo", lang }: { id: string; title: string; label: string; variant?: Variant; lang: Lang }) {
  const plan: Plan = { key: id, agent: "Claude Code", priority: 2, start: variant === "waiting" ? "doing" : variant, pr: 0, moves: [], written: true };
  return <TicketCard plan={plan} words={{ title, label }} variant={variant} t={0} lang={lang} clock={() => 600} age={3} />;
}

/** What the app says once something is done, as its own toast (lib/toast.tsx), drawn k times as large. */
export function Toast({ x, y, k = 2, show, children }: { x: number; y: number; k?: number; show: number; children: ReactNode }) {
  if (show <= 0) return null;
  return <div className="vg-put" style={{ left: x, top: y, transform: `scale(${k * show})` }}><div className="toast feat-toast"><span className="ribbon-tick" /><span className="toast-body" style={{ flex: 1, lineHeight: "var(--leading-dense)" }}>{children}</span></div></div>;
}

/** A film waits for its pictures before its first frame, so none arrives halfway through one. */
const loaded = (urls: string[]): FC<{ onDone: (ready: true) => void }> => function Loaded({ onDone }) {
  useEffect(() => {
    void Promise.all(urls.map((url) => { const img = new Image(); img.src = url; return img.decode().catch(() => undefined); })).then(() => onDone(true));
  }, [onDone]);
  return null;
};

/**
 * A feature film: the hook, three steps each with its captions and its scene, the line that says why, and the end
 * card. `Hook` and `Scene` draw in the frame's own pixels; `frame` is the class and style of the whole frame at a
 * beat, for the film that turns it.
 */
export function feature({ id, poster, words, Scene, Hook, pictures = [], bare = false, frame }: {
  id: FeatureId; /** The beat its still is taken at. */ poster: number; words: Record<Lang, FeatureWords>;
  Scene: FC<{ index: number; u: number; q: number; lang: Lang }>; Hook?: FC<{ q: number; lang: Lang }>;
  pictures?: string[]; bare?: boolean; frame?: (q: number) => { className?: string; style?: CSSProperties };
}): FilmDef {
  const beat = beatOf(id);
  return film<true>({
    id,
    shelf: `3-features/${id}`,
    seconds: secondsOf(id),
    poster: poster * beat,
    formats: ["wide"],
    bare,
    song: SONGS[id],
    day: () => 0,
    rise: () => 0,
    skyTime: (t) => t,
    Prepare: loaded(pictures),
    Picture: ({ t, lang }) => {
      const q = t / beat;
      const said = words[lang];
      const at = stepAt(q);
      const size = lang === "zh" ? 72 : 62;
      const around = frame?.(q);
      return (
        <div className={`feat${around?.className ? ` ${around.className}` : ""}`} lang={lang} style={around?.style}>
          {q < HOOK && (
            <>
              <Caption t={t} at={-1.5} until={HOOK * beat} text={said.hook[0]} lang={lang} x={0} y={340} size={lang === "zh" ? 124 : 104} width={WIDE.w} align="center" />
              <Caption t={t} at={2 * beat} until={HOOK * beat} text={said.hook[1]} lang={lang} x={0} y={520} size={lang === "zh" ? 124 : 104} width={WIDE.w} align="center" />
              {Hook && <Hook q={q} lang={lang} />}
            </>
          )}
          {at && said.steps[at.index].map(([text, from, until]) => <Caption key={text} t={t} at={(step(at.index) + from) * beat} until={(step(at.index) + until) * beat} text={text} lang={lang} x={110} y={62} size={size} width={1700} flat />)}
          {at && <div className="feat-stage" key={at.index}><Scene index={at.index} u={at.u} q={q} lang={lang} /></div>}
          {q >= WHY && q < OUT + 0.5 && <Caption t={t} at={WHY * beat} until={(OUT + 0.4) * beat} text={said.why} lang={lang} x={0} y={390} size={lang === "zh" ? 124 : 104} width={WIDE.w} align="center" />}
          <End d={(q - OUT - 0.5) * beat} f={WIDE} lang={lang} />
        </div>
      );
    },
    pointer: { route: [], clicks: [] },
    cues: () => cuesOf(id)
  });
}
