/**
 * A promo film's soundtrack, written from the film's own cue list (packages/ui/src/promo/Film.tsx): every sound is
 * computed, sample by sample, so it lands on the frame it belongs to and a render is repeatable. A pad under
 * everything, minor by night and major by day; a note for each card that moves (higher the further along the board
 * it lands); a tick for each key typed and each line a terminal writes; and a bell at the end.
 */
const RATE = 48_000;
const TAU = 2 * Math.PI;

/** A minor pentatonic from A2; its notes are C major's too, so the night's tune still fits the morning. */
const SCALE = [45, 48, 50, 52, 55, 57, 60, 62, 64, 67, 69, 72, 74, 76, 79].map((midi) => 440 * 2 ** ((midi - 69) / 12));
const note = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** A repeatable noise source. */
function noiseOf(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2147483648 - 1;
  };
}

/**
 * The film's sound as 16-bit stereo WAV bytes.
 * @param {{ at: number, kind: string, n: number }[]} cues
 * @param {number} seconds
 * @param {{ style: "pulse" | "nocturne" | "chip", bpm: number, beats: number, marks: Record<string, number> } | null} [song]
 *   music with a beat, for a film cut to one; without it the pad under the cues is all the music there is
 */
export function soundtrack(cues, seconds, song = null) {
  const length = Math.ceil(seconds * RATE);
  const dry = [new Float32Array(length), new Float32Array(length)];
  const wet = [new Float32Array(length), new Float32Array(length)];
  /** Adds one voice: fn(t) from `at` for `dur` seconds, placed left to right by pan, with `send` of it to the reverb. */
  const voice = (at, dur, gain, pan, send, fn) => {
    const from = Math.max(0, Math.round(at * RATE));
    const to = Math.min(length, from + Math.round(dur * RATE));
    const left = gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const right = gain * Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = from; i < to; i += 1) {
      const v = fn((i - from) / RATE);
      dry[0][i] += v * left;
      dry[1][i] += v * right;
      wet[0][i] += v * left * send;
      wet[1][i] += v * right * send;
    }
  };
  const attack = (t, a) => Math.min(1, t / a);
  /** A plucked note: quick in, ringing out, a little of its octave and fifth above. */
  const pluck = (at, freq, gain, pan) => voice(at, 1.6, gain, pan, 0.5, (t) =>
    attack(t, 0.004) * Math.exp(-t / 0.3) * (Math.sin(TAU * freq * t) + 0.32 * Math.exp(-t / 0.12) * Math.sin(TAU * 2 * freq * t) + 0.12 * Math.exp(-t / 0.07) * Math.sin(TAU * 3 * freq * t)));
  /** A bell: partials that are not harmonics, each dying at its own pace. */
  const bell = (at, freq, gain, pan) => voice(at, 4.5, gain, pan, 0.7, (t) =>
    attack(t, 0.003) * (Math.exp(-t / 1.5) * Math.sin(TAU * freq * t) + 0.42 * Math.exp(-t / 0.9) * Math.sin(TAU * 2.76 * freq * t) + 0.2 * Math.exp(-t / 0.5) * Math.sin(TAU * 5.4 * freq * t)));
  /** A low knock: a tone that falls as it fades. */
  const thump = (at, gain) => voice(at, 0.7, gain, 0, 0.15, (t) => attack(t, 0.003) * Math.exp(-t / 0.16) * Math.sin(TAU * (46 * t + (70 / 14) * (1 - Math.exp(-14 * t)))));
  /** Air moving: noise through a filter that opens and closes with the swell. */
  const whoosh = (at, dur, gain, seed) => {
    const hiss = noiseOf(seed);
    let low = 0;
    voice(at, dur, gain, 0, 0.4, (t) => {
      const swell = Math.sin((Math.PI * t) / dur) ** 2;
      low += (0.02 + 0.3 * swell) * (hiss() - low);
      return low * swell;
    });
  };
  /** A held chord: each note twice, a few cents apart, so it moves. */
  const pad = (at, dur, midis, gain) => midis.forEach((midi, k) => {
    for (const cents of [-3, 3]) {
      const freq = note(midi) * 2 ** (cents / 1200);
      voice(at, dur, gain / midis.length, k % 2 ? 0.45 : -0.45, 0.6, (t) => Math.min(attack(t, 1.4), attack(dur - t, 1.6)) * (0.86 + 0.14 * Math.sin(TAU * 0.17 * t + k)) * (k === 0 ? 0.6 : 1) * Math.sin(TAU * freq * t));
    }
  });
  const click = (at) => voice(at, 0.05, 0.22, 0, 0.1, (t) => Math.exp(-t / 0.006) * Math.sin(TAU * 2100 * t));

  // ── a band, for the films cut to a beat ──
  const kick = (at, gain = 0.9) => voice(at, 0.35, gain, 0, 0.03, (t) => Math.exp(-t / 0.11) * Math.sin(TAU * (48 * t + (95 / 30) * (1 - Math.exp(-30 * t)))));
  const hat = (at, gain = 0.12, open = false) => {
    const hiss = noiseOf(31 + Math.round(at * 977));
    let last = 0;
    voice(at, open ? 0.22 : 0.05, gain, 0.25, 0.08, (t) => {
      const now = hiss();
      const high = now - last;
      last = now;
      return high * Math.exp(-t / (open ? 0.07 : 0.014));
    });
  };
  const snare = (at, gain = 0.35) => {
    const hiss = noiseOf(53 + Math.round(at * 613));
    let low = 0;
    voice(at, 0.3, gain, -0.1, 0.3, (t) => {
      low += 0.5 * (hiss() - low);
      return low * Math.exp(-t / 0.05) + 0.5 * Math.exp(-t / 0.03) * Math.sin(TAU * 190 * t);
    });
  };
  /** A saw through a filter that closes as the note rings: a bass alone, a stab when several play a chord. */
  const saw = (at, midi, dur, gain, pan = 0, send = 0.05, open = 0.3) => {
    const f = note(midi);
    let low = 0;
    voice(at, dur, gain, pan, send, (t) => {
      const wave = 2 * ((f * t) % 1) - 1 + (2 * ((f * 1.006 * t) % 1) - 1);
      low += (0.04 + open * Math.exp(-t / 0.1)) * (wave * 0.5 - low);
      return low * Math.min(1, t / 0.004, (dur - t) / 0.03);
    });
  };
  const stab = (at, midis, dur, gain) => midis.forEach((midi, k) => saw(at, midi, dur, gain / midis.length, (k / Math.max(1, midis.length - 1)) * 1.2 - 0.6, 0.45, 0.5));
  const square = (at, midi, dur, gain, pan = 0, duty = 0.5) => {
    const f = note(midi);
    voice(at, dur, gain, pan, 0.12, (t) => ((f * t) % 1 < duty ? 1 : -1) * Math.min(1, t / 0.002, (dur - t) / 0.01) * (0.7 + 0.3 * Math.exp(-t / 0.08)));
  };
  const triangle = (at, midi, dur, gain) => {
    const f = note(midi);
    voice(at, dur, gain, 0, 0.05, (t) => (4 * Math.abs(((f * t) % 1) - 0.5) - 1) * Math.min(1, t / 0.002, (dur - t) / 0.01));
  };
  const piano = (at, midi, gain, pan = 0) => {
    const f = note(midi);
    voice(at, 3.2, gain, pan, 0.55, (t) => attack(t, 0.006) * (Math.exp(-t / 0.9) * Math.sin(TAU * f * t) + 0.4 * Math.exp(-t / 0.5) * Math.sin(TAU * 2 * f * t) + 0.16 * Math.exp(-t / 0.25) * Math.sin(TAU * 3.01 * f * t) + 0.06 * Math.exp(-t / 0.12) * Math.sin(TAU * 4.02 * f * t)));
  };
  const riser = (at, dur, gain) => {
    const hiss = noiseOf(71);
    let low = 0;
    voice(at, dur, gain, 0, 0.3, (t) => {
      const u = t / dur;
      low += (0.01 + 0.5 * u * u) * (hiss() - low);
      return low * u * u;
    });
  };
  const CHORD = { Am: [45, 52, 57, 60, 64], F: [41, 48, 53, 57, 60], C: [48, 55, 60, 64, 67], G: [43, 50, 55, 59, 62], Em: [40, 47, 52, 55, 59] };
  const compose = {
    /** Four on the floor: a spare opening, a drop, a breakdown for the night, a roll back in, a last hit. */
    pulse({ bpm, beats, marks: { drop, night, build, back, out } }) {
      const B = 60 / bpm;
      const minor = [CHORD.Am, CHORD.F, CHORD.C, CHORD.G];
      const major = [CHORD.C, CHORD.G, CHORD.Am, CHORD.F];
      riser((drop - 2) * B, 2 * B, 0.5);
      riser(build * B, (back - build) * B, 0.6);
      for (let b = 0; b < beats; b += 1) {
        const at = b * B;
        const bar = Math.floor(b / 4);
        const full = (b >= drop && b < night) || (b >= back && b < out);
        const chord = (b >= back ? major : minor)[bar % 4];
        if (b < drop) {
          hat(at, 0.1);
          hat(at + B / 2, 0.05);
          saw(at, 33, B * 0.45, 0.3);
          if (b >= drop - 4 && b % 2 === 1) snare(at, 0.3);
        } else if (full) {
          kick(at);
          if (b % 2 === 1) snare(at, 0.34);
          hat(at + B / 2, 0.16, true);
          hat(at + B / 4, 0.05);
          hat(at + (3 * B) / 4, 0.05);
          saw(at, chord[0] - 12, B * 0.42, 0.34);
          saw(at + B / 2, chord[0], B * 0.42, 0.26);
          if (b % 4 === 0) stab(at, chord.slice(1), B * 1.3, 0.34);
          if (b % 4 === 1) stab(at + B / 2, chord.slice(1), B * 1.1, 0.26);
        } else if (b < build) {
          // the night: no drum, a held chord, a note climbing on every half beat
          if (b % 4 === 0) pad(at, 4 * B + 0.6, chord, 0.2);
          hat(at + B / 2, 0.05);
          for (const half of [0, 0.5]) pluck(at + half * B, SCALE[4 + Math.round((b - night + half) * 2) % 9], 0.2, half ? 0.4 : -0.4);
        } else if (b < back) {
          for (let k = 0; k < 4; k += 1) snare(at + (k * B) / 4, 0.1 + (0.3 * (b - build + k / 4)) / (back - build));
        } else if (b === out) {
          kick(at, 1);
          stab(at, [48, 55, 60, 64, 67, 72], 4 * B, 0.5);
          bell(at, note(84), 0.14, 0);
        }
      }
    },
    /** A slow piano: broken chords in the left hand through the night, turning major when the day comes. */
    nocturne({ bpm, beats, marks: { dawn } }) {
      const B = 60 / bpm;
      const night = [CHORD.Am, CHORD.F, CHORD.C, CHORD.Em];
      const day = [CHORD.C, CHORD.G, CHORD.Am, CHORD.F];
      const hand = [0, 2, 3, 4, 3, 2, 4, 3];
      for (let b = 0; b < beats; b += 1) {
        const at = b * B;
        const bar = Math.floor(b / 4);
        const chord = (b >= dawn ? day : night)[bar % 4];
        if (b % 4 === 0) {
          pad(at, 4 * B + 1.2, chord, b >= dawn ? 0.12 : 0.1);
          piano(at, chord[0] - 12, 0.2, -0.2);
        }
        for (const half of [0, 1]) piano(at + (half * B) / 2, chord[hand[(b % 4) * 2 + half]] + 12, half ? 0.07 : 0.1, half ? 0.3 : -0.1);
      }
      piano(beats * B, 72, 0.16, 0);
      pad(beats * B, 3, CHORD.C, 0.16);
    },
    /** A chip's four voices: a quiet opening, an alarm that climbs, a tune once the mess is gone, a fanfare. */
    chip({ bpm, beats, marks: { flood, drop, win, out } }) {
      const B = 60 / bpm;
      const happy = [CHORD.C, CHORD.Am, CHORD.F, CHORD.G];
      const tune = [[72, 76, 79, 76], [72, 76, 81, 76], [72, 77, 81, 77], [74, 79, 83, 79]];
      for (let b = 0; b < beats; b += 1) {
        const at = b * B;
        const bar = Math.floor(b / 4);
        if (b < flood) {
          triangle(at, 33, B * 0.5, 0.3);
          if (b % 2 === 1) hat(at, 0.1);
        } else if (b < drop) {
          // the alarm: the same chord a semitone higher every bar, faster and faster on the snare
          const up = Math.floor((b - flood) / 4);
          triangle(at, 33 + up, B * 0.5, 0.3);
          triangle(at + B / 2, 45 + up, B * 0.4, 0.24);
          for (let k = 0; k < 4; k += 1) square(at + (k * B) / 4, [57, 60, 64, 69][k] + up, B / 4.4, 0.07, k % 2 ? 0.5 : -0.5, 0.25);
          snare(at, 0.16);
          if (b >= drop - 4) snare(at + B / 2, 0.2);
        } else if (b < out) {
          const chord = happy[bar % 4];
          const won = b >= win;
          kick(at, 0.6);
          if (b % 2 === 1) snare(at, 0.24);
          hat(at + B / 2, 0.1);
          triangle(at, chord[0] - 12, B * 0.45, 0.34);
          triangle(at + B / 2, chord[0], B * 0.4, 0.26);
          for (let k = 0; k < 4; k += 1) square(at + (k * B) / 4, chord[1 + (k % 3)] + 12, B / 4.4, 0.05, k % 2 ? 0.6 : -0.6, 0.25);
          // the fanfare climbs the chord; before it, the tune
          if (won) for (let k = 0; k < 2; k += 1) square(at + (k * B) / 2, 72 + [0, 4, 7, 12, 16, 19, 24, 19][((b - win) * 2 + k) % 8], B / 2.2, 0.13, 0, 0.5);
          else square(at, tune[bar % 4][b % 4], B * 0.8, 0.12, 0, 0.5);
        } else if (b === out) {
          for (const midi of [48, 60, 64, 67, 72]) square(at, midi, 3 * B, 0.07, 0, 0.5);
          triangle(at, 36, 3 * B, 0.3);
        }
      }
    }
  };
  if (song) compose[song.style](song);

  let end = seconds;
  let turn = null;
  /** The pad's chord changes with the light: each mood holds until the next. */
  const moods = [];
  for (const cue of cues) {
    if (cue.kind === "end") end = cue.at;
    if (cue.kind === "turn") {
      turn = cue.at;
      moods.push({ at: cue.at, major: false });
    }
    if (cue.kind === "night") moods.push({ at: cue.at, major: false });
    if (cue.kind === "dawn") moods.push({ at: cue.at, major: true });
  }
  // A low hum under an opening that has no chord yet.
  if (turn !== null) voice(0, turn + 0.6, 0.11, 0, 0.3, (t) => Math.min(attack(t, 0.5), attack(turn + 0.6 - t, 0.5)) * (Math.sin(TAU * 55 * t) + 0.5 * Math.sin(TAU * 82.4 * t)));
  moods.forEach((mood, i) => {
    const until = moods[i + 1]?.at ?? end;
    if (mood.major) pad(mood.at, until - mood.at + 1.4, [48, 60, 64, 67, 72], 0.17);
    else pad(mood.at, until - mood.at + 1.6, [45, 57, 60, 64, 69], 0.15);
  });
  // The end's chord, held to the last frame; a film with a song ends on its own.
  if (!song) pad(end - 0.2, seconds - end + 0.2, [36, 55, 60, 64, 67, 76], 0.2);

  for (const cue of cues) {
    const { at, n } = cue;
    if (cue.kind === "pane") {
      // each terminal that stops to ask rings a semitone above the one before: the pile grows more pressing
      voice(at, 0.5, 0.2, n % 2 ? 0.5 : -0.5, 0.35, (t) => attack(t, 0.003) * Math.exp(-t / 0.09) * Math.sin(TAU * note(76 + n) * t) + (t > 0.09 ? Math.exp(-(t - 0.09) / 0.12) * 0.8 * Math.sin(TAU * note(72 + n) * (t - 0.09)) : 0));
    } else if (cue.kind === "you") {
      thump(at, 0.5);
    } else if (cue.kind === "turn") {
      whoosh(at - 0.35, 1.3, 0.5, 7);
      thump(at + 0.12, 0.55);
      bell(at + 0.5, note(69), 0.16, 0);
    } else if (cue.kind === "hop") {
      pluck(at, SCALE[3 + n], 0.26, (n % 5) / 2.5 - 0.8);
    } else if (cue.kind === "ask") {
      bell(at, note(76), 0.13, 0.3);
      bell(at + 0.16, note(79), 0.13, 0.3);
    } else if (cue.kind === "click") {
      click(at);
      if (n === 1) pluck(at + 0.03, note(72), 0.2, 0);
    } else if (cue.kind === "run") {
      thump(at, 0.4);
      bell(at, note(57), 0.12, 0);
    } else if (cue.kind === "dawn") {
      whoosh(at, 2.6, 0.34, 11);
    } else if (cue.kind === "fact") {
      thump(at, 0.42);
      // F, G, then home to C at the end card
      for (const midi of [[53, 57, 60, 65], [55, 59, 62, 67], [57, 60, 64, 69]][n]) pluck(at, note(midi), 0.15, 0);
    } else if (cue.kind === "tick") {
      // a note of the film's own tune, on the beat the picture asks for it
      bell(at, SCALE[6 + (n % 9)], 0.1, (n % 5) / 2.5 - 0.8);
    } else if (cue.kind === "key") {
      // a key: a short tick, never twice quite the same
      voice(at, 0.03, 0.05, ((n * 7) % 5) / 6 - 0.3, 0.05, (t) => Math.exp(-t / 0.004) * Math.sin(TAU * (1500 + 110 * ((n * 7) % 5)) * t));
    } else if (cue.kind === "send") {
      pluck(at, note(76), 0.18, 0.2);
    } else if (cue.kind === "card") {
      pluck(at, SCALE[5 + n], 0.24, n / 4 - 0.7);
    } else if (cue.kind === "back") {
      // a run taken back comes down the scale
      whoosh(at - 0.1, 0.7, 0.26, 17);
      [79, 76, 72, 67, 64].forEach((midi, k) => pluck(at + k * 0.055, note(midi), 0.15, k / 2.5 - 0.8));
    } else if (cue.kind === "line") {
      voice(at, 0.14, 0.05, n ? 0.5 : -0.5, 0.2, (t) => attack(t, 0.002) * Math.exp(-t / 0.03) * Math.sin(TAU * note(88 + n * 3) * t));
    } else if (cue.kind === "swap") {
      whoosh(at - 0.15, 0.9, 0.26, 19);
    } else if (cue.kind === "morning") {
      [72, 76, 79].forEach((midi, k) => bell(at + k * 0.11, note(midi), 0.12, k - 1));
    } else if (cue.kind === "end") {
      whoosh(at - 0.5, 1.4, 0.3, 13);
      thump(at, 0.5);
      [72, 76, 79, 84].forEach((midi, k) => bell(at + k * 0.09, note(midi), 0.16, k / 1.5 - 1));
    }
  }

  // A small room: four echoes that feed themselves, smeared by two that do not colour.
  const out = [0, 1].map((ch) => {
    const room = new Float32Array(length);
    for (const [delay, feedback] of [[1687 + ch * 23, 0.8], [1601 + ch * 19, 0.79], [2053 + ch * 31, 0.77], [2251 + ch * 17, 0.76]]) {
      const line = new Float32Array(delay);
      let damp = 0;
      for (let i = 0; i < length; i += 1) {
        const echo = line[i % delay];
        damp += 0.45 * (echo - damp);
        line[i % delay] = wet[ch][i] + damp * feedback;
        room[i] += echo * 0.25;
      }
    }
    for (const delay of [241, 607]) {
      const line = new Float32Array(delay);
      for (let i = 0; i < length; i += 1) {
        const held = line[i % delay];
        const through = room[i] + held * 0.5;
        line[i % delay] = through;
        room[i] = held - through * 0.5;
      }
    }
    const mixed = new Float32Array(length);
    for (let i = 0; i < length; i += 1) mixed[i] = dry[ch][i] + 0.55 * room[i];
    return mixed;
  });

  let peak = 0;
  for (const channel of out) for (let i = 0; i < length; i += 1) peak = Math.max(peak, Math.abs(Math.tanh(channel[i] * 1.4)));
  const wav = Buffer.alloc(44 + length * 4);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + length * 4, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(length * 4, 40);
  const fade = 0.9 * RATE;
  for (let i = 0; i < length; i += 1) {
    const level = (0.84 / peak) * Math.min(1, i / 240, (length - i) / fade);
    for (let ch = 0; ch < 2; ch += 1) wav.writeInt16LE(Math.round(Math.tanh(out[ch][i] * 1.4) * level * 32767), 44 + i * 4 + ch * 2);
  }
  return wav;
}
