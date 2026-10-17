import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service } from 'cordis';
import { afterEach, expect, it, vi } from 'vitest';
import type { AlertNotice } from '@tomradex/alerts';
import { Contributions } from '@tomradex/contributions';
import { Settings } from '@tomradex/settings';
import { Tools } from '@tomradex/tools';
import type { DesktopSurfaceSpec, SurfaceBounds } from '@tomradex/desktop-surface';
import { fresh, sdk, settle } from '@tomradex/testkit';
import pomodoro from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

afterEach(() => { vi.useRealTimers(); });

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomrade-pomodoro-'));
  const surfaces = new Map<string, { spec: DesktopSurfaceSpec; state: any; bounds: SurfaceBounds }>();
  const played: { sound: string; volume?: number }[] = [];
  const notices: AlertNotice[] = [];
  class Native extends Service {
    static provide = 'desktopSurfaces';
    constructor(ctx: Context) { super(ctx, 'desktopSurfaces'); }
    open(spec: DesktopSurfaceSpec) {
      const record = { spec, state: spec.initialState, bounds: { x: 100, y: 100, width: spec.width, height: spec.height } };
      surfaces.set(spec.id, record);
      return { id: spec.id, capabilities: { programmaticPosition: true, forwardedMouseMoves: true }, bounds: () => record.bounds,
        workArea: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
        setPosition: (x: number, y: number) => { record.bounds = { ...record.bounds, x, y }; },
        setState: (state: unknown) => { record.state = state; }, close: () => { surfaces.delete(spec.id); }
      };
    }
  }
  class Alerts extends Service {
    static provide = 'alerts';
    constructor(ctx: Context) { super(ctx, 'alerts'); }
    sounds() { return [{ id: 'system:Glass', title: 'Glass' }, { id: 'system:Ping', title: 'Ping' }]; }
    async play(sound: string, opts?: { volume?: number }) { played.push({ sound, volume: opts?.volume }); }
    notify(notice: AlertNotice) { notices.push(notice); }
  }
  const w = await fresh({ plugins: [Tools, Contributions, [Settings, { path: path.join(dir, 'settings.json') }], Native, Alerts] });
  const fiber = w.ctx.plugin(sdk(pomodoro, { id: 'pomodoro', root }));
  await fiber; await settle();
  const status = () => w.ctx.tools.execute('pomodoro_status', {}, { by: 'human' }) as Promise<any>;
  const configure = async (patch: Record<string, unknown>) => {
    w.ctx.settings.set({ pomodoro: { ...(w.ctx.settings.get() as any).pomodoro, ...patch } } as never);
    await settle();
  };
  const cleanup = async () => { await fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { w, fiber, surfaces, played, notices, status, configure, cleanup };
}

it('Pomodoro ships on with its desktop widget, lives in the status bar with a quick menu, opens its Settings pane, clamps dragging and cleans up', async () => {
  const { w, fiber, surfaces, status, cleanup } = await boot();
  try {
    const c = w.ctx.contributions;
    const menu = async () => ((await c.statusItems({}))[0]!.menu ?? []).map((m) => m.title);
    // The widget is out from the first start, just above the sidebar's Project settings.
    await vi.waitFor(() => expect(surfaces.has('pomodoro.desktop')).toBe(true));
    const desktop = surfaces.get('pomodoro.desktop')!;
    expect(desktop.spec).toMatchObject({ transparent: true, clickThrough: true, anchor: 'sidebar-foot' });
    expect(desktop.spec.url).toMatch(/\/static\/timer\.html$/);
    expect((await status()).config).toMatchObject({ desktop: true, notify: true, sound: 'system:Glass', volume: 70 });
    // Few conversations need the timer, so its tools wait in a kit until the model loads it.
    expect(w.ctx.tools.describe().filter((t) => t.name.startsWith('pomodoro_')).map((t) => t.kit)).toEqual(['pomodoro', 'pomodoro']);
    expect(w.ctx.tools.kits().pomodoro).toMatch(/Pomodoro/);
    // It speaks the app's language, English until the person picks another.
    expect(await c.statusItems({})).toMatchObject([{ id: 'pomodoro.status', text: 'Focus 25:00', icon: 'i-tomato', align: 'end', title: 'Pomodoro' }]);
    expect(await menu()).toEqual(['Start', 'Skip', 'Reset', 'Hide desktop widget', 'All settings…']);
    expect(c.commands().find((x) => x.id === 'pomodoro.skip')).toMatchObject({ title: 'Pomodoro: Skip', group: 'Pomodoro' });
    w.ctx.settings.set({ ...w.ctx.settings.get(), language: 'zh' });
    await settle();
    expect(await c.statusItems({})).toMatchObject([{ text: '专注 25:00', title: '番茄钟' }]);
    expect(await menu()).toEqual(['开始', '跳过', '重置', '收起桌面浮窗', '完整设置…']);
    expect(c.commands().find((x) => x.id === 'pomodoro.skip')).toMatchObject({ title: '番茄钟：跳过', group: '番茄钟' });
    const section = w.ctx.settings.sections('zh').find((s) => s.id === 'pomodoro')!;
    expect(section).toMatchObject({ title: '番茄钟' });
    expect((section.schema as any).properties.sound).toMatchObject({ enum: ['none', 'system:Glass', 'system:Ping', 'file'], enumLabels: { none: '无', 'system:Glass': 'Glass', file: '下方选择的音频文件' } });
    expect((section.schema as any).properties.soundFile).toMatchObject({ format: 'audio', title: '音频文件' });

    await c.run('pomodoro.toggle', {});
    const first = await status();
    expect(await c.statusItems({})).toMatchObject([{ text: '专注', until: first.deadline }]);
    expect((await menu())[0]).toBe('暂停');
    await vi.waitFor(() => expect(desktop.state).toMatchObject({ deadline: first.deadline, round: '第 1/4 轮' }));
    // The status bar stays put while the widget is out.
    expect(await c.statusItems({})).toHaveLength(1);
    await desktop.spec.onMessage?.({ type: 'move', x: 3000, y: -3000 });
    await vi.waitFor(() => expect(desktop.bounds).toMatchObject({ x: 960, y: 0 }));
    await desktop.spec.onMessage?.({ type: 'action', action: 'toggle' });
    await vi.waitFor(() => expect(desktop.state.running).toBe(false));
    expect((await c.statusItems({}))[0]!.text).toMatch(/^专注 \d\d:\d\d · 已暂停$/);
    expect((await menu())[0]).toBe('继续');

    const shown: string[] = [];
    w.ctx.on('settings/show', (id) => void shown.push(id));
    await desktop.spec.onMessage?.({ type: 'action', action: 'settings' });
    await vi.waitFor(() => expect(shown).toEqual(['pomodoro']));

    // Hidden, it stays hidden; reopened, it comes back where it was left rather than at the anchor.
    await desktop.spec.onMessage?.({ type: 'action', action: 'desktop' });
    await vi.waitFor(() => expect(surfaces.has('pomodoro.desktop')).toBe(false));
    expect((await status()).config.desktop).toBe(false);
    expect((await menu())[3]).toBe('打开桌面浮窗');
    await c.run('pomodoro.desktop', {});
    await vi.waitFor(() => expect(surfaces.get('pomodoro.desktop')?.bounds).toMatchObject({ x: 960, y: 0 }));
    expect(surfaces.get('pomodoro.desktop')!.spec.anchor).toBeUndefined();

    await fiber.dispose(); await settle();
    expect(await c.statusItems({})).toEqual([]);
    expect(surfaces.size).toBe(0);
  } finally { await cleanup(); }
});

it('announces the end of a phase with a notification and the chosen sound, and previews a sound when it is picked', async () => {
  const { surfaces, played, notices, status, configure, cleanup, w } = await boot();
  try {
    await vi.waitFor(() => expect(surfaces.has('pomodoro.desktop')).toBe(true));
    vi.useFakeTimers({ toFake: ['Date'] });
    await w.ctx.contributions.run('pomodoro.toggle', {});
    vi.setSystemTime(Date.now() + 25 * 60_000 + 1);
    // The next one-second tick sees the focus run out.
    await vi.waitFor(() => expect(notices).toHaveLength(1), { timeout: 3_000 });
    expect(notices[0]).toEqual({ title: 'Time for a short break', body: 'Focus session done · Start it when you are ready.' });
    expect(played).toEqual([{ sound: 'system:Glass', volume: 0.7 }]);
    expect(await status()).toMatchObject({ phase: 'shortBreak', running: false, completed: 1 });

    played.length = 0;
    await configure({ sound: 'system:Ping', volume: 40 });
    await vi.waitFor(() => expect(played).toEqual([{ sound: 'system:Ping', volume: 0.4 }]));
    // Choosing a file switches the sound to it, and plays it once.
    played.length = 0;
    await configure({ soundFile: '/Users/me/Music/bell.mp3' });
    await vi.waitFor(async () => expect((await status()).config.sound).toBe('file'));
    await vi.waitFor(() => expect(played).toEqual([{ sound: '/Users/me/Music/bell.mp3', volume: 0.4 }]));

    // No sound, no notification: the phase still ends quietly.
    played.length = 0;
    await configure({ sound: 'none', notify: false });
    await w.ctx.contributions.run('pomodoro.toggle', {});
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await vi.waitFor(async () => expect((await status()).phase).toBe('focus'), { timeout: 3_000 });
    expect(notices).toHaveLength(1);
    expect(played).toEqual([]);
  } finally { await cleanup(); }
});

it('falls back to the first system sound when the saved one is not on this machine', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomrade-pomodoro-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ pomodoro: { sound: 'system:Windows Notify' } }));
  class Alerts extends Service {
    static provide = 'alerts';
    constructor(ctx: Context) { super(ctx, 'alerts'); }
    sounds() { return [{ id: 'system:Glass', title: 'Glass' }]; }
    async play() {}
    notify() {}
  }
  const w = await fresh({ plugins: [Tools, Contributions, [Settings, { path: path.join(dir, 'settings.json') }], Alerts] });
  const fiber = w.ctx.plugin(sdk(pomodoro, { id: 'pomodoro', root }));
  try {
    await fiber; await settle();
    const s = await w.ctx.tools.execute('pomodoro_status', {}, { by: 'human' }) as any;
    expect(s.config.sound).toBe('system:Glass');
  } finally { await fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});
