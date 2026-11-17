import type { FilmDef } from "../Film";
import { files } from "./files";
import { inbox } from "./inbox";
import { plugins } from "./plugins";
import { routines } from "./routines";
import { themes } from "./themes";

/** One film to a feature: what it is, one use of it from start to finish, and why it matters. */
export const FEATURE_FILMS: FilmDef[] = [plugins, themes, inbox, files, routines];
