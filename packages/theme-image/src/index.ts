import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Context } from "cordis";
import { z } from "zod";
import { readJsonOr, writeJsonAtomic } from "@tomradex/contracts";
import type { CustomTheme, ThemeAutomation } from "@tomradex/domain";
import type {} from "@tomradex/agent";
import type {} from "@tomradex/desktop-surface";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/projects";
import type {} from "@tomradex/settings";
import { defineTool, type ToolInvocation } from "@tomradex/tools";
import { deriveTheme, FONT_STACKS, parseHex, seedFromPalette, veilOver, type ImagePalette, type ThemeSeed } from "./colors.js";
import { SLOTS, type ThemeImagePictures, type ThemeImageSlot } from "./channels.js";
import { THEME_IMAGE_WORDS } from "./words.js";

export * from "./channels.js";

export const name = "theme-image";
export const inject = ["agent", "ipc", "settings", "tools"];

export const ThemeImageConfig = z.object({
  /** This machine's folder for the pictures behind custom themes; they never follow the Hub folder. */
  dir: z.string()
});
export type ThemeImageConfig = z.infer<typeof ThemeImageConfig>;

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const THEME_ID = /^custom:([a-z0-9-]+)$/;
const EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
/** A theme deleted with Undo still on screen keeps its picture until this long after. */
const PRUNE_AFTER_MS = 2 * 60_000;
/** A picture handed to a conversation whose theme never came is let go after this long. */
const UNANSWERED_MS = 7 * 24 * 60 * 60_000;
const REQUESTS_FILE = "requests.json";

/** A picture waiting in a conversation for its theme; the theme keeps its id each time the tool runs. */
interface Pending { themeId: string; palette: ImagePalette; terminalPalette?: ImagePalette; frost: number; fonts: Record<string, string>; fallbackName: string; at: number }

/** The type is read from the bytes, never taken from the sender. */
export function sniffImage(bytes: Buffer): string | null {
  const ascii = (from: number, to: number) => bytes.subarray(from, to).toString("latin1");
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const SeedInput = z.object({
  mode: z.enum(["light", "dark"]).describe("Whichever keeps the picture's mood with text on panes laid over it."),
  canvas: HEX.describe("#rrggbb: the picture's ground colour, which the panes take their tint from."),
  accent: HEX.describe("#rrggbb: the picture's signature colour (an eye, hair, a garment, a light) for buttons, selection and links. Prefer what makes the picture recognisable over what covers the most of it."),
  tag: HEX.describe("#rrggbb: a second colour from the picture, clearly another hue than accent, for labels."),
  font: z.enum(["sans", "serif", "mincho", "mono"]).describe('Display type: "sans" clean and modern, "serif" bookish, "mincho" Japanese or Chinese brush elegance, "mono" technical or retro-digital.'),
  name: z.string().trim().min(1).max(40).describe("A short, evocative theme name in the person's language, two to four words, without the word theme.")
});

export function apply(ctx: Context, raw: ThemeImageConfig) {
  const { dir } = ThemeImageConfig.parse(raw);
  const words = () => THEME_IMAGE_WORDS(ctx.settings.locale?.());
  // <id>.webp behind the main window, <id>.terminal.webp behind the Terminal window.
  const stem = (themeId: string, slot: ThemeImageSlot = "main") => {
    const match = THEME_ID.exec(themeId);
    if (!match) throw new Error(`Not a custom theme id: ${themeId}`);
    if (!SLOTS.includes(slot)) throw new Error(`Not a picture slot: ${slot}`);
    return slot === "main" ? match[1]! : `${match[1]}.${slot}`;
  };
  const filesOf = (id: string) => {
    try {
      return fs.readdirSync(dir).filter(file => file.slice(0, file.lastIndexOf(".")) === id);
    } catch {
      return [];
    }
  };
  const save = (themeId: string, base64: string, slot: ThemeImageSlot = "main") => {
    const id = stem(themeId, slot);
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`The picture is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    const mime = sniffImage(bytes);
    if (!mime) throw new Error("The picture is not a PNG, JPEG or WebP image");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${id}.${EXTENSION[mime]}`);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, bytes);
    fs.renameSync(temp, target);
    for (const file of filesOf(id)) if (path.join(dir, file) !== target) fs.rmSync(path.join(dir, file), { force: true });
    return { mime, bytes: bytes.length };
  };
  const forget = (themeId: string) => { for (const slot of SLOTS) for (const file of filesOf(stem(themeId, slot))) fs.rmSync(path.join(dir, file), { force: true }); };

  ctx.ipc.handle("themeImage.read", (themeId, slot) => {
    const file = filesOf(stem(themeId, slot))[0];
    if (!file) return null;
    const bytes = fs.readFileSync(path.join(dir, file));
    const mime = sniffImage(bytes);
    return mime ? { mime, base64: bytes.toString("base64") } : null;
  });
  ctx.ipc.handle("themeImage.save", (themeId, image, slot) => save(themeId, image.base64, slot));
  ctx.ipc.handle("themeImage.remove", (themeId, slot) => {
    for (const file of filesOf(stem(themeId, slot))) fs.rmSync(path.join(dir, file), { force: true });
  });

  // ── the conversations waiting on a theme, by thread ──
  const requestsFile = path.join(dir, REQUESTS_FILE);
  const readRequests = () => readJsonOr<Record<string, Pending>>(requestsFile, {});
  const writeRequests = (requests: Record<string, Pending>) => writeJsonAtomic(requestsFile, requests);
  const themes = () => (ctx.settings.get().customThemes ?? []) as CustomTheme[];
  const keep = (request: ThemeImagePictures): Pending => {
    const themeId = `custom:${randomUUID()}`;
    save(themeId, request.main.base64);
    if (request.terminal) save(themeId, request.terminal.base64, "terminal");
    return { themeId, palette: request.palette, terminalPalette: request.terminalPalette, frost: request.frost, fonts: request.fonts, fallbackName: request.fallbackName, at: Date.now() };
  };

  /** The one way a picture becomes a theme, and is worn: from a model's reading, or from its own palette. */
  const makeTheme = (pending: Pending, seed: ThemeSeed): CustomTheme => {
    const derived = deriveTheme(seed, pending.palette);
    const theme: CustomTheme = {
      id: pending.themeId as CustomTheme["id"], name: (seed.name || pending.fallbackName).slice(0, 64), base: derived.base, icon: "i-sliders", tokens: derived.tokens,
      fonts: { ...pending.fonts, "font-display": FONT_STACKS[seed.font ?? "sans"], "font-body": FONT_STACKS.sans } as CustomTheme["fonts"],
      backdrop: { veil: derived.veil, frost: pending.frost, ...(pending.terminalPalette ? { terminalVeil: veilOver(derived.tokens, pending.terminalPalette) } : {}) }
    };
    const current = ctx.settings.get(), all = themes(), at = all.findIndex(other => other.id === theme.id);
    const automation = current.themeAutomation as ThemeAutomation | undefined;
    ctx.settings.set({
      ...current, theme: theme.id, ...(automation ? { themeAutomation: { ...automation, mode: "none" } } : {}),
      customThemes: at < 0 ? [...all, theme] : all.map(other => other.id === theme.id ? { ...theme, icon: other.icon } : other)
    });
    return theme;
  };

  ctx.ipc.handle("themeImage.local", (request) => ({ name: makeTheme(keep(request), seedFromPalette(request.palette)).name }));

  // The assistant's own engine reads the picture, as in any conversation: a connected model, or a signed-in agent standing in for one.
  ctx.ipc.handle("themeImage.start", async (request) => {
    const engineId = ctx.agent.answering(ctx.agent.settingsOf().defaultEngine);
    await ctx.agent.engineOf(engineId)?.available().catch(() => null);
    if (!ctx.agent.mediaFor(engineId).input.includes(request.view.mime)) return null;
    const projectId = request.projectId ?? ctx.get("projects")?.list().filter(p => !p.archived).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id;
    if (!projectId) throw new Error(words()("noProject"));
    const thread = ctx.agent.newThread(projectId, engineId, null, { title: words()("title", { name: request.fallbackName }), surface: "assistant" });
    // Earlier pictures nobody turned into a theme leave with this one's arrival.
    const requests = readRequests(), kept = new Set(themes().map(theme => theme.id));
    for (const [threadId, pending] of Object.entries(requests)) if (Date.now() - pending.at > UNANSWERED_MS && !kept.has(pending.themeId as CustomTheme["id"])) { forget(pending.themeId); delete requests[threadId]; }
    requests[thread.id] = keep(request);
    writeRequests(requests);
    const media = ctx.agent.uploadMedia(projectId, thread.id, { name: "picture.jpg", mime: request.view.mime, base64: request.view.base64 });
    ctx.agent.send(projectId, thread.id, { kind: "text", text: words()("ask"), attachments: [media] });
    ctx.emit("desktop/open", { projectId, threadId: thread.id });
    return { projectId, threadId: thread.id };
  });

  ctx.tools.register(defineTool({
    name: "theme_from_picture",
    title: "Make the theme from the picture",
    description: [
      "Make Tomrade's colour theme from the picture attached to this conversation, and wear it. The picture fills the window behind translucent panes; your colours tint the panes and mark what matters.",
      "Pick hues true to the picture: lightness and contrast are adjusted for legibility afterwards, so text always reads.",
      "Call it again with other colours to revise the same theme, as the person asks."
    ].join(" "),
    input: SeedInput,
    mcp: "run",
    execute(seed, inv: ToolInvocation) {
      const pending = inv.run ? readRequests()[inv.run.threadId] : undefined;
      if (!pending) throw new Error("theme_from_picture works only in the conversation Tomrade opened for a picture; no picture waits here");
      const revising = themes().some(theme => theme.id === pending.themeId);
      const theme = makeTheme(pending, { ...seed, canvas: parseHex(seed.canvas)!, accent: parseHex(seed.accent)!, tag: parseHex(seed.tag)! });
      return { applied: theme.name, mode: theme.base, accent: theme.tokens.accent, paneOpacity: theme.backdrop?.veil, note: revising ? "The theme is revised and worn." : "The theme is made and worn." };
    }
  }));

  // A theme deleted here or on another machine takes its picture along, once it has
  // stayed gone a while: an Undo, or the Hub folder settling, brings it back first.
  const ids = (list: unknown) => new Set(((list ?? []) as { id: string }[]).flatMap(theme => THEME_ID.exec(theme.id) ? [theme.id] : []));
  const leaving = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prune = () => {
    const kept = ids(ctx.settings.get().customThemes);
    const requests = readRequests();
    let changed = false;
    for (const themeId of leaving) if (!kept.has(themeId)) {
      forget(themeId);
      for (const [threadId, pending] of Object.entries(requests)) if (pending.themeId === themeId) { delete requests[threadId]; changed = true; }
    }
    if (changed) writeRequests(requests);
    leaving.clear();
  };
  ctx.on("settings/changed", (next, previous) => {
    const now = ids(next.customThemes);
    const gone = [...ids(previous.customThemes)].filter(id => !now.has(id));
    if (!gone.length) return;
    for (const id of gone) leaving.add(id);
    clearTimeout(timer);
    timer = setTimeout(prune, PRUNE_AFTER_MS);
  });
  ctx.effect(() => () => clearTimeout(timer));
}
