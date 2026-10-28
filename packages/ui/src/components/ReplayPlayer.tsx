import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { clockAt, clockLabel, fitScale, playTimes, playedBy, replayFrom, SPEEDS, type Speed } from "~/code-sessions/playback";
import { terminalTheme } from "~/lib/xtermTheme";

/** One painted stretch of a pane, as the recording kept it. */
export interface ReplayFrame {
  t: number;
  w: number;
  h: number;
  full: boolean;
  key: boolean;
  bytes: Uint8Array;
}

/** A recording to play back: its records, where the shown stretch starts among them, and how whole its start is. */
export interface ReplayData {
  records: ReplayFrame[];
  at: number;
  cut: boolean;
  clean: boolean;
}

export type RawWordKey = "rawLoading" | "rawNone" | "rawOnlyWhenShown" | "rawCut" | "rawUnclean" | "rawPlay" | "rawPause" | "rawPosition" | "rawSpeed";
/** The player's words, from whichever window shows it: the Terminal window's `say`, or the panel's `t` over the same keys. */
export type RawSay = (key: RawWordKey, vars?: Record<string, string | number>) => string;

/**
 * A recording played back in a read-only terminal, sized as the pane was and scaled to fit: the catch-up goes in
 * unseen, then the records as they were painted. It opens on its last screen, what the person last saw; play starts
 * over from the beginning, the slider goes anywhere. `data` null while it loads; `themeKey` changing repaints the look.
 */
export function ReplayPlayer({ data, font, themeKey, say }: { data: ReplayData | null; font: string; themeKey?: unknown; say: RawSay }) {
  const host = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [time, setTime] = useState(0);
  const [scale, setScale] = useState(1);
  // Between a write of many records and xterm having drawn them, the screen is held back.
  const [drawing, setDrawing] = useState(false);
  // The player's own state, outside renders: which records are in the terminal, and the play timer.
  const player = useRef<{ records: ReplayFrame[]; times: number[]; applied: number; timer: ReturnType<typeof setTimeout> | null }>({ records: [], times: [], applied: 0, timer: null });

  useEffect(() => {
    const el = host.current;
    setPlaying(false);
    setTime(0);
    if (!el || !data) return;
    const terminal = new Terminal({ scrollback: 0, disableStdin: true, cursorBlink: false, fontFamily: font || "ui-monospace, Menlo, monospace", fontSize: 13, allowProposedApi: false, theme: terminalTheme() });
    terminal.open(el);
    term.current = terminal;
    const p = player.current;
    p.records = data.records;
    p.times = playTimes(data.records, data.at);
    p.applied = 0;
    const measure = () => {
      const screen = el.querySelector<HTMLElement>(".xterm-screen");
      const frame = box.current;
      if (!screen || !frame) return;
      setScale(fitScale({ width: frame.clientWidth, height: frame.clientHeight }, { width: screen.offsetWidth, height: screen.offsetHeight }));
    };
    const observer = new ResizeObserver(measure);
    if (box.current) observer.observe(box.current);
    // The last screen first: everything, unseen until drawn.
    apply(p.records.length, measure);
    setTime(p.times.at(-1) ?? 0);
    return () => {
      observer.disconnect();
      if (p.timer) clearTimeout(p.timer);
      p.timer = null;
      terminal.dispose();
      term.current = null;
    };
    // The look's variables repaint below without starting over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (term.current) term.current.options.theme = terminalTheme();
    });
    return () => cancelAnimationFrame(frame);
  }, [themeKey]);

  /** The records up to `upTo` in the terminal: on from where it is, or from the newest keyframe before `upTo`. */
  const apply = (upTo: number, then?: () => void) => {
    const terminal = term.current;
    const p = player.current;
    if (!terminal) return;
    const start = replayFrom(p.records, p.applied, upTo);
    if (start.reset) {
      terminal.reset();
      if (start.size && (start.size.w !== terminal.cols || start.size.h !== terminal.rows)) terminal.resize(start.size.w, start.size.h);
      p.applied = start.from;
    }
    let wrote = false;
    for (let i = p.applied; i < upTo; i++) {
      const r = p.records[i]!;
      if (r.key) terminal.reset();
      if (r.w > 0 && r.h > 0 && (r.w !== terminal.cols || r.h !== terminal.rows)) terminal.resize(r.w, r.h);
      terminal.write(r.bytes);
      wrote = true;
    }
    p.applied = upTo;
    if (!wrote) return then?.();
    setDrawing(true);
    terminal.write("", () => {
      setDrawing(false);
      then?.();
    });
  };

  const stop = () => {
    const p = player.current;
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    setPlaying(false);
  };

  /** The next record goes in when its time comes, at the speed picked; the end stops. */
  const tick = (from: number, rate: number) => {
    const p = player.current;
    const next = p.applied;
    if (next >= p.records.length) return stop();
    const wait = Math.max(0, (p.times[next]! - from) / rate);
    p.timer = setTimeout(() => {
      p.timer = null;
      const at = p.times[next]!;
      apply(next + 1);
      setTime(at);
      tick(at, rate);
    }, wait);
  };

  const play = () => {
    const p = player.current;
    if (!p.records.length) return;
    // At the end, play means from the start.
    let from = time;
    if (p.applied >= p.records.length) {
      from = 0;
      apply(playedBy(p.times, 0));
      setTime(0);
    }
    setPlaying(true);
    tick(from, speed);
  };

  const seek = (to: number) => {
    const p = player.current;
    const wasPlaying = p.timer !== null;
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    apply(playedBy(p.times, to));
    setTime(to);
    if (wasPlaying) tick(to, speed);
  };

  const changeSpeed = (next: Speed) => {
    setSpeed(next);
    const p = player.current;
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = null;
      tick(time, next);
    }
  };

  const p = player.current;
  const end = p.times.at(-1) ?? 0;
  const clock = data ? clockAt(data.records, p.times, time) : null;
  const when = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (!data) return <div className="cs-replay-note" data-testid="cs-replay">{say("rawLoading")}</div>;
  if (!data.records.length)
    return (
      <div className="cs-replay-note" data-testid="cs-replay" data-empty>
        <span>{say("rawNone")}</span>
        <span className="cs-row-meta">{say("rawOnlyWhenShown")}</span>
      </div>
    );
  return (
    <div className="cs-replay" data-testid="cs-replay" data-drawing={drawing || undefined}>
      {(data.cut || !data.clean) && <div className="cs-replay-cut">{say(data.cut ? "rawCut" : "rawUnclean")}</div>}
      <div ref={box} className="cs-replay-screen">
        <div ref={host} className="cs-replay-host" style={{ transform: `scale(${scale})` }} />
      </div>
      <div className="cs-replay-bar">
        <button type="button" className="btn btn-secondary btn-xs" data-testid="cs-replay-play" aria-label={playing ? say("rawPause") : say("rawPlay")} onClick={() => (playing ? stop() : play())}>
          {playing ? "⏸" : "▶"}
        </button>
        <input type="range" className="cs-replay-slider" data-testid="cs-replay-slider" aria-label={say("rawPosition")} min={0} max={end} step={1} value={Math.min(time, end)} onChange={(e) => seek(Number(e.target.value))} />
        <span className="cs-replay-time mono" title={clock ? when(clock) : undefined}>
          {clockLabel(time)} / {clockLabel(end)}
        </span>
        <span className="seg cs-replay-speeds" role="group" aria-label={say("rawSpeed")}>
          {SPEEDS.map((s) => (
            <button key={s} type="button" aria-pressed={speed === s} onClick={() => changeSpeed(s)}>
              {s}×
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}
