export type Phase = 'focus' | 'shortBreak' | 'longBreak';
export interface Rules { focusMinutes: number; shortBreakMinutes: number; longBreakMinutes: number; longBreakEvery: number; autoStart: boolean }
export class Timer {
  phase: Phase = 'focus';
  completed = 0;
  remaining: number;
  deadline: number | null = null;
  /** Phases that ran out on their own, and the last of them: what an alert announces. */
  ended = 0;
  lastEnded: Phase | null = null;
  constructor(public rules: Rules) { this.remaining = this.duration(); }
  duration() { return this.rules[this.phase === 'focus' ? 'focusMinutes' : this.phase === 'shortBreak' ? 'shortBreakMinutes' : 'longBreakMinutes'] * 60_000; }
  start(now = Date.now()) { if (this.deadline === null) this.deadline = now + this.remaining; }
  pause(now = Date.now()) { this.tick(now); if (this.deadline !== null) { this.remaining = Math.max(0, this.deadline - now); this.deadline = null; } }
  reset() { this.phase = 'focus'; this.completed = 0; this.deadline = null; this.remaining = this.duration(); }
  next(countFocus = true) {
    if (this.phase === 'focus') { const round = this.completed + 1; if (countFocus) this.completed++; this.phase = round % this.rules.longBreakEvery === 0 ? 'longBreak' : 'shortBreak'; }
    else this.phase = 'focus';
    this.remaining = this.duration();
  }
  skip(now = Date.now()) { const running = this.deadline !== null; this.next(false); this.deadline = running ? now + this.remaining : null; }
  tick(now = Date.now()) {
    if (this.deadline === null) return;
    // After sleep, complete one real session; do not count unattended cycles.
    if (now >= this.deadline) { this.ended++; this.lastEnded = this.phase; this.next(); this.deadline = this.rules.autoStart ? now + this.remaining : null; }
    else this.remaining = this.deadline - now;
  }
  configure(rules: Rules) { const previous = this.duration(); this.rules = rules; if (this.deadline === null && previous !== this.duration()) this.remaining = this.duration(); }
  snapshot(now = Date.now()) { this.tick(now); return { phase: this.phase, completed: this.completed, running: this.deadline !== null, remaining: this.remaining, duration: this.duration(), deadline: this.deadline }; }
}
