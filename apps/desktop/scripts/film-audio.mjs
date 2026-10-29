/**
 * The demo films' sound, made here rather than licensed: an original, bouncy, cute bed in the spirit of internet cat
 * songs (128 BPM, major key, marimba and kalimba plucks over a hopping bass, claps and shaker, a pair of synthesized
 * "mi~" calls at the end of every fourth bar) and the effects a cut asks for, mixed into one 44.1 kHz stereo WAV.
 */
import fs from "node:fs";

const RATE = 44100;
const BPM = 128;
export const BEAT = 60 / BPM;
const midi = (n) => 440 * 2 ** ((n - 69) / 12);
// C – G – Am – F, a bar each: the happiest four chords there are.
const CHORDS = [[48, 60, 64, 67], [43, 59, 62, 67], [45, 60, 64, 69], [41, 57, 60, 65]];
// The tune's notes: C major pentatonic, two octaves up.
const PENTA = [72, 74, 76, 79, 81, 84, 86, 88];

/** A seeded noise source, so a cut always sounds the same. */
function noise(seed = 7) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/** A sung "mi": a glide up with a little vibrato, harmonics shaped around an /i/ vowel. */
function mi(f0, len) {
  const formant = (f) => Math.exp(-(((f - 320) / 160) ** 2)) + 0.8 * Math.exp(-(((f - 2400) / 420) ** 2)) + 0.25;
  return (t) => {
    const glide = f0 * (0.86 + 0.14 * Math.min(1, t / 0.06)) * (1 + 0.012 * Math.sin(2 * Math.PI * 6.5 * t));
    let v = 0;
    for (let k = 1; k <= 12; k++) v += Math.sin(2 * Math.PI * glide * k * t) * formant(glide * k) / k;
    return v * Math.min(1, t / 0.012) * Math.min(1, Math.max(0, (len - t) / 0.08)) * 0.09;
  };
}

function bed(seconds) {
  const n = Math.ceil(seconds * RATE);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const rnd = noise(11);
  const tune = noise(29);
  const add = (start, len, fn, pan = 0) => {
    const a = Math.floor(start * RATE);
    const gl = Math.min(1, 1 - pan);
    const gr = Math.min(1, 1 + pan);
    for (let i = 0; i < len * RATE && a + i < n; i++) {
      const v = fn(i / RATE);
      L[a + i] += v * gl;
      R[a + i] += v * gr;
    }
  };
  const marimba = (f, gain) => (t) => Math.min(1, t / 0.002) * (Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 7) + 0.4 * Math.sin(2 * Math.PI * 4 * f * t) * Math.exp(-t * 28)) * gain;
  const kalimba = (f, gain) => (t) => Math.min(1, t / 0.002) * (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(2 * Math.PI * 5.4 * f * t) * Math.exp(-t * 20)) * Math.exp(-t * 4.2) * gain;
  const bars = Math.ceil(seconds / (BEAT * 4)) + 1;
  // One two-bar phrase of the tune, then an answer that ends higher: a rhythm of eighths, some held.
  const RHYTHM = [[1, 0, 1, 1, 0, 1, 0, 1], [1, 1, 0, 1, 1, 0, 1, 0]];
  let step = 2;
  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * BEAT * 4;
    const chord = CHORDS[bar % CHORDS.length];
    const e8 = BEAT / 2;
    // Bass hops: root on the beat, octave on the "and".
    for (let e = 0; e < 8; e++) {
      const f = midi(chord[0] - 12 + (e % 2 ? 12 : 0));
      add(t0 + e * e8, e8 * 0.9, (t) => Math.min(1, t / 0.004) * Math.exp(-t * 9) * (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t)) * (e % 2 ? 0.055 : 0.085));
    }
    // Chords: short marimba stabs on the off-beats.
    for (const e of [1, 3, 5, 7]) for (const [k, note] of chord.slice(1).entries()) add(t0 + e * e8, 0.5, marimba(midi(note), 0.028), (k - 1) * 0.3);
    // The tune: kalimba, walking the pentatonic in small steps, landing on a chord tone each bar.
    RHYTHM[bar % 2].forEach((on, e) => {
      if (!on) return;
      step = Math.max(0, Math.min(PENTA.length - 1, step + Math.round(tune() * 2)));
      const note = e === 0 ? chord[1] + 12 + (bar % 4 === 3 ? 7 : 0) : PENTA[step];
      add(t0 + e * e8, 0.8, kalimba(midi(note), 0.078), 0.15);
    });
    // Drums: kick on every beat, claps on 2 and 4, a shaker in sixteenths.
    for (let b = 0; b < 4; b++) add(t0 + b * BEAT, 0.25, (t) => Math.sin(2 * Math.PI * (48 + 90 * Math.exp(-t * 35)) * t) * Math.exp(-t * 12) * 0.14);
    for (const b of [1, 3]) for (const d of [0, 0.012, 0.024]) add(t0 + b * BEAT + d, 0.18, (t) => rnd() * Math.exp(-t * 30) * 0.05, d ? 0.2 : -0.2);
    for (let s16 = 0; s16 < 16; s16++) add(t0 + s16 * BEAT / 4, 0.04, (t) => rnd() * Math.exp(-t * 120) * (s16 % 2 ? 0.014 : 0.024), 0.4);
    // Every fourth bar ends on two "mi~"s.
    if (bar % 4 === 3) {
      add(t0 + 6 * e8, 0.22, mi(midi(81), 0.22), -0.1);
      add(t0 + 7 * e8, 0.3, mi(midi(84), 0.3), 0.1);
    }
  }
  // A little room: one feedback delay per side, on the beat's dotted eighth.
  for (const [ch, d] of [[L, BEAT * 0.75], [R, BEAT * 0.75 + 0.011]]) {
    const k = Math.floor(d * RATE);
    for (let i = k; i < n; i++) ch[i] += ch[i - k] * 0.18;
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
