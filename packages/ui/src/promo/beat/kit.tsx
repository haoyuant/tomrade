import { Caption } from "../parts";
import type { Lang } from "../words";

/** How strongly something that happened at beat `at` still shows at beat q: 1 on the beat, gone a beat or so later. */
export const hit = (q: number, at: number, rate = 4): number => (q < at ? 0 : Math.exp(-(q - at) * rate));
/** The same for the beat itself: every beat a little push. */
export const pulse = (q: number, rate = 5): number => Math.exp(-(q - Math.floor(q)) * rate);

/** A film's captions, each up from one beat until another, in the band along the top of the frame. */
export function Lines({ t, beat, lines, lang, x = 110, y = 60, size = 80, width, flat = true }: { t: number; beat: number; lines: [string, number, number][]; lang: Lang; x?: number; y?: number; size?: number; width?: number; /** One line; otherwise a line break in the text starts a new one. */ flat?: boolean }) {
  return <>{lines.map(([text, from, until]) => <Caption key={text} t={t} at={from * beat} until={until * beat} text={text} lang={lang} x={x} y={y} size={size} width={width ?? 1920 - 2 * x} flat={flat} />)}</>;
}
