import type { FilmDef } from "../Film";
import { dial } from "./dial";
import { flyover } from "./flyover";
import { keynote } from "./keynote";
import { manual } from "./manual";
import { LONG, SHORT } from "./scripts";
import { zine } from "./zine";

/** The launch films: each style at about 35 seconds and at about a minute. */
const STYLES = { keynote, flyover, manual, zine, dial };
export const LAUNCH_FILMS: FilmDef[] = Object.entries(STYLES).flatMap(([name, make]) => [make(`launch-${name}`, SHORT), make(`launch-${name}-60`, LONG)]);
