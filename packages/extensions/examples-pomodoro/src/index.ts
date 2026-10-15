import { z } from 'zod';
import { definePlugin, defineTool, type SurfaceHandle } from '@tomradex/plugin-sdk';
import { Timer } from './timer.js';

const schema = z.object({
  mode: z.enum(['embedded', 'desktop']).default('embedded').describe('显示位置 / Display mode'),
  focusMinutes: z.number().int().min(1).max(180).default(25).describe('专注分钟 / Focus minutes'),
  shortBreakMinutes: z.number().int().min(1).max(60).default(5).describe('短休息分钟 / Short break minutes'),
  longBreakMinutes: z.number().int().min(1).max(120).default(15).describe('长休息分钟 / Long break minutes'),
  longBreakEvery: z.number().int().min(1).max(12).default(4).describe('长休息间隔轮次 / Sessions per long break'),
  autoStart: z.boolean().default(false).describe('自动开始下一阶段 / Auto-start next phase'),
  language: z.enum(['zh', 'en']).default('zh').describe('语言 / Language')
});
type Config = z.infer<typeof schema>;
const words = {
  zh: { title: '番茄钟', focus: '专注', shortBreak: '短休息', longBreak: '长休息', start: '开始', pause: '暂停', skip: '跳过', reset: '重置', desktop: '桌面', embedded: '宠物区', settings: '规则', done: '已完成', save: '保存', cancel: '取消', focusMinutes: '专注（分钟）', shortBreakMinutes: '短休息（分钟）', longBreakMinutes: '长休息（分钟）', longBreakEvery: '长休息间隔（轮次）', autoStart: '自动开始下一阶段', invalid: '请输入有效范围内的整数' },
  en: { title: 'Pomodoro', focus: 'Focus', shortBreak: 'Short break', longBreak: 'Long break', start: 'Start', pause: 'Pause', skip: 'Skip', reset: 'Reset', desktop: 'Desktop', embedded: 'Pet area', settings: 'Rules', done: 'Completed', save: 'Save', cancel: 'Cancel', focusMinutes: 'Focus (minutes)', shortBreakMinutes: 'Short break (minutes)', longBreakMinutes: 'Long break (minutes)', longBreakEvery: 'Sessions per long break', autoStart: 'Auto-start next phase', invalid: 'Enter whole numbers within the allowed range' }
};
export default definePlugin({
  inject: ['settings', 'contributions', 'tools'],
  optional: ['surfaces'],
  async apply(ctx) {
    await ctx.settings.register({ title: 'Pomodoro · 番茄钟', schema, defaults: schema.parse({}), agent: 'write' });
    let config = schema.parse(await ctx.settings.get());
    const timer = new Timer(config);
    let desktop: SurfaceHandle | null = null;
    let editor: SurfaceHandle | null = null;
    let position: { x: number; y: number } | null = null;
    let stopped = false;
    let serial = Promise.resolve();
    const label = () => words[config.language];
    const state = () => ({ ...timer.snapshot(), words: label(), config });
    const clock = () => { const seconds = Math.ceil(timer.snapshot().remaining / 1000); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; };
    const openEditor = async () => {
      if (!ctx.has('surfaces')) throw new Error('Desktop surfaces are unavailable');
      if (editor) return;
      editor = await ctx.surfaces.open({ id: 'pomodoro.rules', title: label().settings, document: 'dist/static/rules.html', width: 340, height: 430, alwaysOnTop: true, focusable: true, initialState: state(), onMessage: async (m: any) => {
        if (m?.type === 'close') { await editor?.close(); editor = null; }
        if (m?.type === 'save') { const next = schema.parse({ ...config, ...m.rules }); await ctx.settings.set(next); await editor?.close(); editor = null; }
      } });
    };
    const sync = async () => {
      if (stopped) return;
      const next = schema.parse(await ctx.settings.get());
      if (JSON.stringify(next) !== JSON.stringify(config)) { config = next; timer.configure(config); }
      if (config.mode === 'desktop' && ctx.has('surfaces') && !desktop) {
        desktop = await ctx.surfaces.open({ id: 'pomodoro.desktop', title: label().title, document: 'dist/static/timer.html', width: 280, height: 154, transparent: true, alwaysOnTop: true, initialState: state(), onMessage: async (m: any) => {
          if (m?.type === 'move' && Number.isFinite(m.dx) && Number.isFinite(m.dy) && desktop) { const b = await desktop.bounds(); const a = await desktop.workArea(); await desktop.setPosition(Math.max(a.x, Math.min(a.x + a.width - b.width, b.x + m.dx)), Math.max(a.y, Math.min(a.y + a.height - b.height, b.y + m.dy))); const moved = await desktop.bounds(); position = { x: moved.x, y: moved.y }; }
          else if (m?.type === 'action') await action(m.action);
        } });
        if (position) await desktop.setPosition(position.x, position.y);
      }
      if (config.mode !== 'desktop' && desktop) { const b = await desktop.bounds(); position = { x: b.x, y: b.y }; await desktop.close(); desktop = null; }
      await desktop?.setState(state());
    };
    const schedule = () => { serial = serial.then(sync).catch(e => ctx.logger.warn(String(e))); return serial; };
    const action = async (name: string) => {
      if (name === 'toggle') timer.deadline === null ? timer.start() : timer.pause();
      else if (name === 'skip') timer.skip();
      else if (name === 'reset') timer.reset();
      else if (name === 'mode') await ctx.settings.set({ ...config, mode: config.mode === 'desktop' ? 'embedded' : 'desktop' });
      else if (name === 'settings') await openEditor();
      await schedule();
    };
    for (const name of ['toggle', 'skip', 'reset', 'mode', 'settings']) await ctx.contributions.command({ id: `pomodoro.${name}`, title: `Pomodoro · ${name}`, run: () => action(name) });
    await ctx.contributions.assistantWidget({ id: 'pomodoro.timer', title: 'Pomodoro', render: () => {
      if (config.mode === 'desktop' && desktop) return null;
      const s = timer.snapshot(); const w = label();
      return { text: clock(), detail: `${w[s.phase]} · ${w.done} ${s.completed}`, progress: 1 - s.remaining / s.duration, actions: [
        { title: s.running ? w.pause : w.start, command: 'pomodoro.toggle' }, { title: w.skip, command: 'pomodoro.skip' }, { title: w.reset, command: 'pomodoro.reset' }, { title: w.desktop, command: 'pomodoro.mode' }, { title: w.settings, command: 'pomodoro.settings' }
      ] };
    } });
    await ctx.tools.register(defineTool({ name: 'pomodoro_status', title: 'Pomodoro status', description: 'Current phase, time remaining and time rules.', input: z.object({}), execute: () => state() }));
    await ctx.tools.register(defineTool({ name: 'pomodoro_control', title: 'Control Pomodoro', description: 'Start/pause, skip or reset the Pomodoro timer.', input: z.object({ action: z.enum(['toggle', 'skip', 'reset']) }), execute: async (args) => { await action(args.action); return state(); } }));
    ctx.on('settings.changed', () => void schedule());
    ctx.when('surfaces', () => { void schedule(); return () => { desktop = null; editor = null; }; });
    ctx.interval(() => { timer.tick(); void schedule(); }, 1000);
    ctx.effect(() => () => { stopped = true; void desktop?.close(); void editor?.close(); });
  }
});
