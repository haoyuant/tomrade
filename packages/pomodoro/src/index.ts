import { z } from 'zod';
import { definePlugin, defineTool, type Locale, type SurfaceHandle } from '@tomradex/plugin-sdk';
import { Timer } from './timer.js';

// System sounds differ per machine, so the choice is built from what this one offers.
const schemaFor = (sounds: string[]) => {
  const options = ['none', ...sounds, 'file'] as [string, ...string[]];
  const fallback = sounds[0] ?? 'none';
  return z.object({
    desktop: z.boolean().default(true).meta({ title: 'Desktop widget' }).describe('A clock without a card, floating above other windows.'),
    focusMinutes: z.number().int().min(1).max(180).default(25).meta({ title: 'Focus minutes' }),
    shortBreakMinutes: z.number().int().min(1).max(60).default(5).meta({ title: 'Short break minutes' }),
    longBreakMinutes: z.number().int().min(1).max(120).default(15).meta({ title: 'Long break minutes' }),
    longBreakEvery: z.number().int().min(1).max(12).default(4).meta({ title: 'Sessions per long break' }),
    autoStart: z.boolean().default(false).meta({ title: 'Auto-start next phase' }).describe('Start the next focus or break as soon as one ends.'),
    notify: z.boolean().default(true).meta({ title: 'System notification' }).describe('Notify when a focus or break ends.'),
    // A sound this machine no longer has falls back rather than refusing the whole section.
    sound: z.enum(options).default(fallback).catch(fallback).meta({ title: 'Alert sound' }).describe('Played when a focus or break ends. Picking one plays it.'),
    soundFile: z.string().default('').meta({ title: 'Audio file', format: 'audio' }).describe('Your own sound, used when Alert sound is set to the audio file.'),
    volume: z.number().int().min(0).max(100).default(70).meta({ title: 'Volume' }).describe('0–100.')
  });
};
type Config = z.infer<ReturnType<typeof schemaFor>>;
const words = {
  en: { title: 'Pomodoro', focus: 'Focus', shortBreak: 'Short break', longBreak: 'Long break', start: 'Start', resume: 'Resume', pause: 'Pause', paused: 'Paused', skip: 'Skip', reset: 'Reset', desktop: 'Open desktop widget', hide: 'Hide desktop widget', settings: 'All settings…', round: 'Round {n}/{of}',
    ended: { focus: 'Focus session done', shortBreak: 'Break is over', longBreak: 'Long break is over' }, next: { focus: 'Back to focus', shortBreak: 'Time for a short break', longBreak: 'Time for a long break' }, started: 'It has started.', ready: 'Start it when you are ready.' },
  zh: { title: '番茄钟', focus: '专注', shortBreak: '短休息', longBreak: '长休息', start: '开始', resume: '继续', pause: '暂停', paused: '已暂停', skip: '跳过', reset: '重置', desktop: '打开桌面浮窗', hide: '收起桌面浮窗', settings: '完整设置…', round: '第 {n}/{of} 轮',
    ended: { focus: '专注完成', shortBreak: '休息结束', longBreak: '长休息结束' }, next: { focus: '回到专注', shortBreak: '该短休息了', longBreak: '该长休息了' }, started: '已经开始计时。', ready: '准备好了就开始。' }
};
const WIDGET = { width: 240, height: 148 };
const clock = (ms: number) => { const s = Math.ceil(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
// Command titles: one per language, picked by the app each time it shows them.
const both = (pick: (w: typeof words.en) => string) => ({ en: `${words.en.title}: ${pick(words.en)}`, zh: `${words.zh.title}：${pick(words.zh)}` });

export default definePlugin({
  inject: ['settings', 'contributions', 'tools', 'alerts'],
  optional: ['surfaces'],
  async apply(ctx) {
    const sounds = await ctx.alerts.sounds();
    const schema = schemaFor(sounds.map(s => s.id));
    const soundNames = Object.fromEntries(sounds.map(s => [s.id, s.title]));
    await ctx.settings.register({
      title: 'Pomodoro', description: 'Focus and break lengths, and how the end of each is announced, for the status bar timer and its desktop widget.', schema, defaults: schema.parse({}), agent: 'write',
      words: { en: { fields: { sound: { options: { none: 'None', ...soundNames, file: 'Audio file below' } } } }, zh: { title: '番茄钟', description: '状态栏计时器和桌面浮窗使用的专注与休息时长，以及每段结束时如何提醒。', fields: {
        desktop: { title: '桌面浮窗', description: '没有卡片的时钟，浮在其他窗口之上。' },
        focusMinutes: { title: '专注（分钟）' },
        shortBreakMinutes: { title: '短休息（分钟）' },
        longBreakMinutes: { title: '长休息（分钟）' },
        longBreakEvery: { title: '长休息间隔（轮次）' },
        autoStart: { title: '自动开始下一阶段', description: '一个阶段结束后立即开始下一段专注或休息。' },
        notify: { title: '系统通知', description: '专注或休息结束时发送系统通知。' },
        sound: { title: '提示音', description: '专注或休息结束时播放。选中即试听。', options: { none: '无', ...soundNames, file: '下方选择的音频文件' } },
        soundFile: { title: '音频文件', description: '你自己的声音，提示音选「下方选择的音频文件」时使用。' },
        volume: { title: '音量', description: '0–100。' }
      } } }
    });
    let config: Config = schema.parse(await ctx.settings.get());
    let locale: Locale = await ctx.settings.locale();
    const timer = new Timer(config);
    let desktop: SurfaceHandle | null = null;
    let position: { x: number; y: number } | null = null;
    let shown = '';
    let stopped = false;
    let serial = Promise.resolve();
    let announced = 0;
    const label = () => words[locale];
    const round = (s: ReturnType<Timer['snapshot']>) => label().round.replace('{n}', String(s.round)).replace('{of}', String(config.longBreakEvery));
    const state = () => { const s = timer.snapshot(); return { ...s, round: round(s), words: label(), lang: locale, config }; };
    const place = async (x: number, y: number) => {
      if (!desktop) return;
      const a = await desktop.workArea();
      position = { x: Math.max(a.x, Math.min(a.x + a.width - WIDGET.width, Math.round(x))), y: Math.max(a.y, Math.min(a.y + a.height - WIDGET.height, Math.round(y))) };
      await desktop.setPosition(position.x, position.y);
    };
    const soundOf = (c: Config) => c.sound === 'none' ? null : c.sound === 'file' ? c.soundFile || null : c.sound;
    const play = async (c: Config) => {
      const sound = soundOf(c);
      if (sound && c.volume > 0) await ctx.alerts.play(sound, { volume: c.volume / 100 }).catch(e => ctx.logger.warn(`sound: ${String(e)}`));
    };
    const announce = async () => {
      const l = label(), ended = timer.lastEnded ?? 'focus';
      if (config.notify) await ctx.alerts.notify({ title: l.next[timer.phase], body: `${l.ended[ended]} · ${timer.deadline === null ? l.ready : l.started}` });
      await play(config);
    };
    const sync = async () => {
      if (stopped) return;
      const next = schema.parse(await ctx.settings.get());
      if (JSON.stringify(next) !== JSON.stringify(config)) {
        const previous = config;
        config = next; timer.configure(config);
        // A newly chosen file is what the person wants to hear; changing the sound previews it.
        if (next.soundFile && next.soundFile !== previous.soundFile && next.sound !== 'file') await ctx.settings.set({ ...next, sound: 'file' });
        else if (next.sound !== previous.sound || next.soundFile !== previous.soundFile || next.volume !== previous.volume) void play(next);
      }
      locale = await ctx.settings.locale();
      if (config.desktop && ctx.has('surfaces') && !desktop) {
        desktop = await ctx.surfaces.open({ id: 'pomodoro.desktop', title: label().title, document: 'static/timer.html', ...WIDGET, transparent: true, alwaysOnTop: true, clickThrough: true, ...(position ? {} : { anchor: 'sidebar-foot' }), initialState: state(), onMessage: async (m: any) => {
          if (m?.type === 'move' && Number.isFinite(m.x) && Number.isFinite(m.y)) await place(m.x, m.y);
          else if (m?.type === 'action' && typeof m.action === 'string') await action(m.action);
        } });
        if (position) await place(position.x, position.y);
        shown = '';
      }
      if (!config.desktop && desktop) { await desktop.close(); desktop = null; }
      // Windows count down from the deadline themselves; only a real change is pushed.
      const s = state();
      if (timer.ended !== announced) { announced = timer.ended; void announce(); }
      const signature = JSON.stringify({ ...s, remaining: s.running ? null : s.remaining });
      if (signature === shown) return;
      shown = signature;
      await desktop?.setState(s);
      await ctx.contributions.refresh();
    };
    const schedule = () => { serial = serial.then(sync).catch(e => ctx.logger.warn(String(e))); return serial; };
    const action = async (name: string) => {
      if (name === 'toggle') timer.deadline === null ? timer.start() : timer.pause();
      else if (name === 'skip') timer.skip();
      else if (name === 'reset') timer.reset();
      else if (name === 'desktop') await ctx.settings.set({ ...config, desktop: !config.desktop });
      else if (name === 'settings') await ctx.settings.show();
      await schedule();
    };
    const titles = {
      toggle: both(w => `${w.start} / ${w.pause}`), skip: both(w => w.skip), reset: both(w => w.reset),
      desktop: both(w => `${w.desktop} / ${w.hide}`), settings: both(w => w.settings.replace('…', ''))
    };
    for (const [name, title] of Object.entries(titles)) await ctx.contributions.command({ id: `pomodoro.${name}`, title, group: { en: words.en.title, zh: words.zh.title }, run: () => action(name) });
    await ctx.contributions.statusItem({
      id: 'pomodoro.status', icon: 'i-tomato', align: 'end', title: { en: words.en.title, zh: words.zh.title },
      text: () => { const s = timer.snapshot(); const l = label(); return s.running ? l[s.phase] : `${l[s.phase]} ${clock(s.remaining)}${s.remaining < s.duration ? ` · ${l.paused}` : ''}`; },
      until: () => timer.snapshot().deadline,
      menu: () => {
        const s = timer.snapshot(); const l = label();
        return [
          { title: s.running ? l.pause : s.remaining < s.duration ? l.resume : l.start, command: 'pomodoro.toggle', icon: s.running ? 'i-stop' : 'i-clock' },
          { title: l.skip, command: 'pomodoro.skip', icon: 'i-redo' },
          { title: l.reset, command: 'pomodoro.reset', icon: 'i-undo' },
          { title: config.desktop ? l.hide : l.desktop, command: 'pomodoro.desktop', icon: 'i-monitor' },
          { title: l.settings, command: 'pomodoro.settings', icon: 'i-gear' }
        ];
      }
    });
    await ctx.tools.kit('pomodoro', 'the Pomodoro focus timer: its state, start/pause, skip, reset');
    await ctx.tools.register(defineTool({ name: 'pomodoro_status', title: 'Pomodoro status', kit: 'pomodoro', description: 'Current phase, time remaining and time rules.', input: z.object({}), execute: () => state() }));
    await ctx.tools.register(defineTool({ name: 'pomodoro_control', title: 'Control Pomodoro', kit: 'pomodoro', description: 'Start/pause, skip or reset the Pomodoro timer.', input: z.object({ action: z.enum(['toggle', 'skip', 'reset']) }), execute: async (args) => { await action(args.action); return state(); } }));
    ctx.on('settings.changed', () => void schedule());
    ctx.when('surfaces', () => { void schedule(); return () => { desktop = null; }; });
    ctx.interval(() => { timer.tick(); void schedule(); }, 1000);
    ctx.effect(() => () => { stopped = true; void desktop?.close(); });
  }
});
