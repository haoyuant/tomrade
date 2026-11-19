import { babysitter } from "./babysitter";
import { lanterns } from "./beat/lantern";
import { keys } from "./beat/keys";
import { metro } from "./beat/metro";
import { numbers } from "./beat/numbers";
import { phone } from "./beat/phone";
import { poster } from "./beat/poster";
import { sequencer } from "./beat/sequencer";
import { tty } from "./beat/tty";
import { DAY_FILMS } from "./day";
import { FEATURE_FILMS } from "./feature";
import type { FilmDef } from "./Film";
import { LAUNCH_FILMS } from "./launch";
import { card } from "./free/card";
import { terminal } from "./free/terminal";
import { waiting } from "./free/waiting";

/** Every film the page can draw, by the name the renderer asks for it with. */
export const FILMS: FilmDef[] = [DAY_FILMS[0], babysitter, ...DAY_FILMS.slice(1), terminal, waiting, card, poster, lanterns, tty, sequencer, metro, keys, phone, numbers, ...LAUNCH_FILMS, ...FEATURE_FILMS];
