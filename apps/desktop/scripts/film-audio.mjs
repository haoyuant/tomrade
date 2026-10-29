/**
 * The demo films' sound, made here rather than licensed: a soft lo-fi bed (four chords, pad, plucks, bass, light
 * drums) and the effects a cut asks for (clicks, typing, whooshes, chimes), mixed into one 44.1 kHz stereo WAV.
 */
import fs from "node:fs";

const RATE = 44100;
const BPM = 84;
const BEAT = 60 / BPM;
const midi = (n) => 440 * 2 ** ((n - 69) / 12);
// Cmaj7 – Am7 – Fmaj7 – G6, a bar each.
const CHORDS = [[48, 55, 59, 64, 67], [45, 52, 55, 60, 64], [41, 48, 52, 57, 60], [43, 50, 55, 59, 64]];

/** A seeded noise source, so a cut always sounds the same. */
function noise(seed = 7) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

function bed(seconds) {
  const n = Math.ceil(seconds * RATE);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const rnd = noise(11);
  const add = (start, len, fn, pan = 0, gain = 1) => {
    const a = Math.floor(start * RATE);
    for (let i = 0; i < len * RATE && a + i < n; i++) {
      const v = fn(i / RATE) * gain;
      L[a + i] += v * (1 - pan) * 0.5 + v * 0.5 * (pan <= 0 ? 1 : 1 - pan);
      R[a + i] += v * (1 + pan) * 0.5 + v * 0.5 * (pan >= 0 ? 1 : 1 + pan);
    }
  };
  const bars = Math.ceil(seconds / (BEAT * 4)) + 1;
  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * BEAT * 4;
    const chord = CHORDS[bar % CHORDS.length];
    // Pad: detuned sines, slow swell over the bar.
    for (const [k, note] of chord.slice(1).entries()) {
      const f = midi(note);
      add(t0, BEAT * 4 + 0.6, (t) => {
        const env = Math.min(1, t / 0.9) * Math.min(1, Math.max(0, (BEAT * 4 + 0.6 - t) / 0.9));
        return env * (Math.sin(2 * Math.PI * f * t) + 0.6 * Math.sin(2 * Math.PI * f * 1.003 * t) + 0.25 * Math.sin(2 * Math.PI * f * 2 * t)) * 0.022;
      }, (k - 2) * 0.25);
    }
    // Bass: the root on beats 1 and 3.
    for (const beat of [0, 2]) {
      const f = midi(chord[0] - 12);
      add(t0 + beat * BEAT, BEAT * 1.8, (t) => Math.exp(-t * 2.2) * Math.min(1, t / 0.01) * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) * 0.11);
    }
    // Plucks: a gentle arpeggio in eighths, every other bar busier.
    const pattern = bar % 2 ? [1, 2, 3, 4, 3, 2, 3, 4] : [2, 3, 4, 3, 2, 3, 4, 3];
    pattern.forEach((idx, e) => {
      if (bar % 2 === 0 && e % 2 === 1 && e > 3) return;
      const f = midi(chord[idx] + 12);
      add(t0 + e * BEAT / 2, 0.9, (t) => Math.exp(-t * 5.5) * Math.min(1, t / 0.004) * (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * 2 * f * t) * Math.exp(-t * 9)) * 0.045, e % 2 ? 0.35 : -0.35);
    });
    // Drums: a soft kick on 1 and 3, a brushed snare on 2 and 4, quiet hats in eighths.
    for (const beat of [0, 2]) add(t0 + beat * BEAT, 0.35, (t) => Math.sin(2 * Math.PI * (52 + 70 * Math.exp(-t * 30)) * t) * Math.exp(-t * 9) * 0.16);
    for (const beat of [1, 3]) add(t0 + beat * BEAT, 0.25, (t) => rnd() * Math.exp(-t * 22) * 0.035);
    for (let e = 0; e < 8; e++) add(t0 + e * BEAT / 2, 0.05, (t) => rnd() * Math.exp(-t * 90) * (e % 2 ? 0.012 : 0.018), e % 2 ? 0.3 : -0.3);
  }
  // A little room: one feedback delay per side.
  for (const [ch, d] of [[L, 0.231], [R, 0.287]]) {
    const k = Math.floor(d * RATE);
    for (let i = k; i < n; i++) ch[i] += ch[i - k] * 0.28;
  }
  return { L, R };
}

const EFFECTS = {
  click: (rnd) => ({ len: 0.06, fn: (t) => (rnd() * Math.exp(-t * 400) * 0.35 + Math.sin(2 * Math.PI * 2100 * t) * Math.exp(-t * 120) * 0.18) }),
  // A soft felt tap, not a tick: low-passed noise over a little body, pitch varied per key.
  key: (rnd) => {
    let lp = 0;
    const body = 180 + rnd() * 60;
    return { len: 0.05, fn: (t) => {
      lp += 0.18 * (rnd() - lp);
      return (lp * 0.55 + Math.sin(2 * Math.PI * body * t) * 0.5) * Math.exp(-t * 140) * 0.06;
    } };
  },
  whoosh: (rnd) => {
    let lp = 0;
    return { len: 0.7, fn: (t) => {
      const cutoff = 0.04 + 0.5 * Math.sin(Math.PI * Math.min(t / 0.7, 1));
      lp += cutoff * (rnd() - lp);
      return lp * Math.sin(Math.PI * Math.min(t / 0.7, 1)) ** 2 * 0.5;
    } };
  },
  chime: () => ({ len: 1.4, fn: (t) => [76, 83].reduce((s, n, i) => s + (t > i * 0.09 ? Math.sin(2 * Math.PI * midi(n) * (t - i * 0.09)) * Math.exp(-(t - i * 0.09) * 3.2) : 0), 0) * 0.09 }),
  undo: () => ({ len: 1.2, fn: (t) => [83, 76].reduce((s, n, i) => s + (t > i * 0.08 ? Math.sin(2 * Math.PI * midi(n) * (t - i * 0.08)) * Math.exp(-(t - i * 0.08) * 3.5) : 0), 0) * 0.08 })
};

/** Writes music under `seconds` plus each `{ t, kind }` effect to a 16-bit stereo WAV. */
export function mix(file, seconds, effects = [], { music = 0.8 } = {}) {
  const { L, R } = bed(seconds + 1);
  const n = Math.ceil(seconds * RATE);
  const rnd = noise(3);
  for (let i = 0; i < n; i++) {
    // Fade the bed in over 1.2 s and out over the last 2.
    const g = music * Math.min(1, i / (1.2 * RATE)) * Math.min(1, (n - i) / (2 * RATE));
    L[i] *= g;
    R[i] *= g;
  }
  for (const e of effects) {
    const make = EFFECTS[e.kind];
    if (!make) continue;
    const { len, fn } = make(rnd);
    const a = Math.floor(e.t * RATE);
    for (let i = 0; i < len * RATE && a + i < n; i++) {
      const v = fn(i / RATE) * (e.gain ?? 1);
      L[a + i] += v;
      R[a + i] += v;
    }
  }
  const pcm = Buffer.alloc(44 + n * 4);
  pcm.write("RIFF", 0);
  pcm.writeUInt32LE(36 + n * 4, 4);
  pcm.write("WAVEfmt ", 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(2, 22);
  pcm.writeUInt32LE(RATE, 24);
  pcm.writeUInt32LE(RATE * 4, 28);
  pcm.writeUInt16LE(4, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36);
  pcm.writeUInt32LE(n * 4, 40);
  // Soft-clip, so a pile-up of effects never cracks.
  const s16 = (v) => Math.round(Math.tanh(v * 1.1) * 32000);
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(s16(L[i]), 44 + i * 4);
    pcm.writeInt16LE(s16(R[i]), 46 + i * 4);
  }
  fs.writeFileSync(file, pcm);
}
