/**
 * A film's look. By default it is night turning to morning, in Daybreak and Sunrise; `?look=dawn` draws the same
 * film in Dawn's warm paper throughout.
 */
export type Look = "night" | "dawn";
export const LOOK: Look = typeof location !== "undefined" && new URLSearchParams(location.search).get("look") === "dawn" ? "dawn" : "night";
