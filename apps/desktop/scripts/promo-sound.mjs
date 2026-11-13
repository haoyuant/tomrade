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
 */
export function soundtrack(cues, seconds) {
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
  // The end's chord, held to the last frame.
  pad(end - 0.2, seconds - end + 0.2, [36, 55, 60, 64, 67, 76], 0.2);

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
