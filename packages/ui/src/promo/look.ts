/**
 * A film's look. By default it is night turning to morning, in Daybreak and Sunrise. `?look=sunrise` draws the
 * same film in Sunrise throughout, the morning sky from its first frame.
 */
export type Look = "night" | "sunrise";
const asked = typeof location !== "undefined" ? new URLSearchParams(location.search).get("look") : null;
export const LOOK: Look = asked === "sunrise" ? asked : "night";
