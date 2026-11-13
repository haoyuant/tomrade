import { babysitter } from "./babysitter";
import { lanterns } from "./beat/lantern";
import { poster } from "./beat/poster";
import { tty } from "./beat/tty";
import { DAY_FILMS } from "./day";
import type { FilmDef } from "./Film";
import { card } from "./free/card";
import { terminal } from "./free/terminal";
import { waiting } from "./free/waiting";

/** Every film the page can draw, by the name the renderer asks for it with. */
export const FILMS: FilmDef[] = [DAY_FILMS[0], babysitter, ...DAY_FILMS.slice(1), terminal, waiting, card, poster, lanterns, tty];
