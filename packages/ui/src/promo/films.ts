import { babysitter } from "./babysitter";
import { handsfree, idea, main, overnight, undo } from "./day";
import type { FilmDef } from "./Film";

/** Every film the page can draw, by the name the renderer asks for it with. */
export const FILMS: FilmDef[] = [main, babysitter, idea, undo, handsfree, overnight];
