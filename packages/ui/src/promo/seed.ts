// The sky's lights place themselves with Math.random as their module loads (Motes.tsx). The film must draw the same
// sky on every render, so this module comes first and deals the same numbers each time.
let state = 0x544f4d52;
Math.random = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
