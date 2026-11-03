/**
 * Lays a wide short out again for phone feeds: node scripts/film-tall.mjs <name> writes film-edits/<name>-tall.json
 * from film-edits/<name>.json. Time, sound and takes stay the wide cut's; only where things sit changes. The type moves
 * into a band at the top, and each shot shows the part of the window the wide shot showed, zoomed to fill the space
 * below it. A wide edit can steer a shot with "tall": { "shots": { name: { "fx"?, "fy"?, "zoom"? } } }: the focus as a
 * fraction of what the wide shot showed (0.5 is its middle), and how much tighter than the default to frame it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "film-edits");
const name = process.argv[2];
const wide = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));

const STAGE = { w: 1920, h: 1080 };
// Where the picture goes on the tall stage, under the band of type.
const PICTURE = { x: 0, y: 600, w: 1080, h: 1260 };
// The wide stage's side column of type, which a shot with a veil leaves to the type.
const SIDE = 1250;
// A wide take's window, in points: its width is the edit's src.width and its height follows the take (6016×3100).
const ASPECT = 3100 / 6016;
const TYPE = { x: 70, y: 150, w: 940 };

const tall = structuredClone(wide);
tall.stage = "tall";
delete tall.tall;
const steer = wide.tall?.shots ?? {};

// Each shot: the stage rectangle the wide shot showed, then the same window placed so that rectangle fills the picture.
for (const [key, shot] of Object.entries(wide.shots)) {
  const top = (wide.src?.top ?? 0) + (shot.top ?? 0);
  const width = wide.src?.width ?? 3008;
  const h = shot.w * (width * ASPECT - top) / width;
  let r = shot.spot
    ? { x: shot.spot[0], y: shot.spot[1], w: shot.spot[2], h: shot.spot[3] }
    : (() => {
        const x0 = Math.max(0, shot.x), y0 = Math.max(shot.veilTop ? 200 : 0, shot.y);
        const x1 = Math.min(shot.veil ? SIDE : STAGE.w, shot.x + shot.w), y1 = Math.min(STAGE.h, shot.y + h);
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      })();
  const s = steer[key] ?? {};
  // A spotlit card is shown whole; anything else fills the picture's height, giving up at most half its width.
  const zoom = (shot.spot ? Math.min(PICTURE.w / r.w, PICTURE.h / r.h) : Math.min(PICTURE.w / (r.w * 0.5), PICTURE.h / r.h)) * (s.zoom ?? 1);
  const fx = r.x + r.w * (s.fx ?? 0.5), fy = r.y + r.h * (s.fy ?? 0.5);
  const cx = PICTURE.x + PICTURE.w / 2, cy = PICTURE.y + PICTURE.h / 2;
  const next = { x: Math.round(cx - (fx - shot.x) * zoom), y: Math.round(cy - (fy - shot.y) * zoom), w: Math.round(shot.w * zoom), veilTop: 1 };
  if (shot.top) next.top = shot.top;
  if (shot.spot) next.spot = [cx - (fx - r.x) * zoom, cy - (fy - r.y) * zoom, r.w * zoom, r.h * zoom].map(Math.round);
  tall.shots[key] = next;
}

// Type: every caption into the band at the top; ones on screen together stack.
const shown = [];
tall.texts = (wide.texts ?? []).map((t) => {
  const over = shown.filter((o) => o.from < t.to && t.from < o.to).length;
  shown.push(t);
  const size = Math.min(t.size ?? 80, t.inline ? 64 : 78);
  return { ...t, x: TYPE.x, y: TYPE.y + over * (size + 40), w: TYPE.w, align: "left", size, zhSize: Math.min(t.zhSize ?? 36, 36) };
});

// Title and full-page cards: their blocks down the left, the animation below them (film-short moves it there).
const cardType = (card) => ({
  ...card,
  blocks: card.blocks.map((b, i) => ({ ...b, x: 80, y: 200 + i * 250, w: 920, size: Math.min(b.size ?? 96, 88), zhSize: Math.min(b.zhSize ?? 44, 42) }))
});
tall.title = cardType(wide.title);
if (wide.cards) tall.cards = wide.cards.map(cardType);

fs.writeFileSync(path.join(dir, `${name}-tall.json`), JSON.stringify(tall, null, 1) + "\n");
console.log(`${name}-tall.json`);
