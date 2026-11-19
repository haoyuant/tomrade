import { useLayoutEffect, useRef, type CSSProperties } from "react";
import type { Format } from "./stage";
import { clamp, ease, lerp, span } from "./time";
import type { Lang } from "./words";

interface Word { text: string; lit: boolean; line: number }

/** A caption's words in order: *stars* light what is between them, a newline starts a line. */
function wordsOf(text: string, lang: Lang): Word[] {
  const out: Word[] = [];
  let lit = false;
  text.split("\n").forEach((row, line) => {
    for (const piece of row.split(/(\*)/)) {
      if (piece === "*") {
        lit = !lit;
        continue;
      }
      // Chinese has no spaces to break at: its words come from the segmenter, each mark kept with the word before it.
      const parts = lang === "zh" ? [...new Intl.Segmenter("zh", { granularity: "word" }).segment(piece)].map((s) => s.segment) : piece.split(/(?<= )/);
      for (const part of parts) {
        const last = out[out.length - 1];
        if (!part) continue;
        if (last && last.line === line && last.lit === lit && /^[\s，。、！？,.!?]+$/.test(part)) last.text += part;
        else out.push({ text: part, lit, line });
      }
    }
  });
  return out;
}

/**
 * Large words over the picture. Each word comes up from behind its own line, one after the other, and the whole
 * caption leaves together.
 */
export function Caption({ t, at, until, text, lang, x, y, size, width, align = "left", flat = false, serif = false }: {
  t: number; at: number; until: number; text: string; lang: Lang; x: number; y: number; size: number; width: number;
  align?: "left" | "center"; /** One line: a newline in the text reads as a space. */ flat?: boolean; serif?: boolean;
}) {
  if (t < at || t >= until) return null;
  const words = wordsOf(flat ? text.replace(/\n/g, lang === "zh" ? "" : " ") : text, lang);
  const leave = ease.in(span(t, until - 0.22, until));
  const lines = [...new Set(words.map((w) => w.line))];
  return (
    <div className={`film-caption${serif ? " is-serif" : ""}`} lang={lang} style={{ left: x, top: y, width, fontSize: size, textAlign: align, opacity: 1 - leave, transform: `translate3d(0, ${-18 * leave}px, 0)` }}>
      {lines.map((line) => (
        <span className="film-caption-line" key={line}>
          {words.map((word, i) => {
            if (word.line !== line) return null;
            const up = ease.outQuint(span(t, at + i * 0.06, at + i * 0.06 + 0.55));
            return (
              <span className="film-caption-word" key={i}>
                <span className={word.lit ? "is-lit" : undefined} style={{ transform: `translate3d(0, ${(1 - up) * 108}%, 0)`, opacity: clamp(up * 3) }}>{word.text}</span>
              </span>
            );
          })}
        </span>
      ))}
    </div>
  );
}

/**
 * The sky the app's Sunrise and Daybreak draw behind the workspace (SkyLights.tsx), from the same tokens and the same
 * geometry, as gradients: the film holds two themes at once at dawn, and each layer's sky reads its own tokens.
 * `rise` is how high the sun stands, 0 under the horizon.
 */
export function Sky({ rise }: { rise: number }) {
  const sun: CSSProperties = { opacity: 0.35 + 0.65 * clamp(rise), transform: `translate3d(0, ${(1 - rise) * 9}%, 0) scale(${0.86 + 0.34 * rise})` };
  return (
    <div className="film-sky" aria-hidden="true">
      <i className="film-sky-haze" />
      <i className="film-sky-stars" />
      <i className="film-sky-glow" style={{ opacity: clamp(rise - 0.25) * 1.2 }} />
      <i className="film-sky-sun" style={sun} />
    </div>
  );
}

export type Target = string | [number, number];
/** Where the pointer goes: to something on screen named by data-cursor, or to a point as a share of the frame. */
export interface Pointer { route: { at: number; to: Target }[]; clicks: number[]; /** When it is gone, if before its route ends. */ until?: number }

/** The person's pointer, over everything. It reads where its targets are drawn this frame, so it follows the camera. */
export function Cursor({ t, f, route, clicks, until = Infinity }: { t: number; f: Format } & Pointer) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const stage = el?.parentElement;
    if (!el || !stage || route.length < 2) return;
    const box = stage.getBoundingClientRect();
    const k = box.width / f.w;
    const point = (to: Target): { x: number; y: number } | null => {
      if (typeof to !== "string") return { x: to[0] * f.w, y: to[1] * f.h };
      const target = stage.querySelector(`[data-cursor="${to}"]`);
      if (!target) return null;
      const r = target.getBoundingClientRect();
      return { x: (r.left + r.width * 0.5 - box.left) / k, y: (r.top + r.height * 0.62 - box.top) / k };
    };
    const next = Math.max(1, route.findIndex((stop) => stop.at > t));
    const from = point(route[next - 1].to);
    const to = point(route[next].to);
    if (!from || !to) return;
    const u = ease.inOut(span(t, route[next - 1].at, route[next].at));
    el.style.transform = `translate3d(${lerp(from.x, to.x, u)}px, ${lerp(from.y, to.y, u)}px, 0)`;
  });
  if (route.length < 2 || t < route[0].at || t > route[route.length - 1].at || t >= until) return null;
  const click = clicks.find((at) => t >= at && t < at + 0.5);
  const press = click === undefined ? 0 : Math.sin(Math.PI * span(t, click, click + 0.2));
  return (
    <div className="film-cursor" ref={ref} aria-hidden="true" style={until === Infinity ? undefined : { opacity: 1 - span(t, until - 0.3, until) }}>
      {click !== undefined && <i className="film-cursor-ring" style={{ transform: `translate(-50%, -50%) scale(${ease.out(span(t, click, click + 0.5))})`, opacity: 0.6 * (1 - span(t, click, click + 0.5)) }} />}
      <svg width="54" height="73" viewBox="0 0 17 23" style={{ transform: `scale(${1 - 0.14 * press})` }}>
        <path d="M1.5 1.5v16.6l4-3.7 2.7 6.3 2.6-1.1-2.7-6.2h5.5z" />
      </svg>
    </div>
  );
}
