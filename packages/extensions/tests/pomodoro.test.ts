import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context, Service } from 'cordis';
import { expect, it, vi } from 'vitest';
import { Contributions } from '@tomradex/contributions';
import { Settings } from '@tomradex/settings';
import { Tools } from '@tomradex/tools';
import type { DesktopSurfaceSpec, SurfaceBounds } from '@tomradex/desktop-surface';
import { fresh, sdk, settle } from '@tomradex/testkit';
import pomodoro from '../examples-pomodoro/src/index.js';

it('Pomodoro lives in the status bar with a quick menu, shares one timer with the backgroundless desktop widget, opens its Settings pane, clamps dragging and cleans up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomrade-pomodoro-'));
  fs.mkdirSync(path.join(dir, 'dist/static'), { recursive: true });
  for (const doc of ['timer.html']) fs.copyFileSync(path.resolve('packages/extensions/examples-pomodoro/static', doc), path.join(dir, 'dist/static', doc));
  const surfaces = new Map<string, { spec: DesktopSurfaceSpec; state: any; bounds: SurfaceBounds }>();
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
  const w = await fresh({ plugins: [Tools, Contributions, [Settings, { path: path.join(dir, 'settings.json') }], Native] });
  const fiber = w.ctx.plugin(sdk(pomodoro, { id: 'local/pomodoro', namespace: 'pomodoro', origin: 'extension', root: dir, dataDir: dir }));
  try {
    await fiber; await settle();
    const c = w.ctx.contributions;
    const status = () => w.ctx.tools.execute('pomodoro_status', {}, { by: 'human' }) as Promise<any>;
    const menu = async () => ((await c.statusItems({}))[0]!.menu ?? []).map((m) => m.title);
    // It speaks the app's language, English until the person picks another.
    expect(await c.statusItems({})).toMatchObject([{ id: 'pomodoro.status', text: 'Focus 25:00', icon: 'i-tomato', align: 'end', title: 'Pomodoro' }]);
    expect(await menu()).toEqual(['Start', 'Skip', 'Reset', 'Open desktop widget', 'All settings…']);
    expect(c.commands().find((x) => x.id === 'pomodoro.skip')).toMatchObject({ title: 'Pomodoro: Skip', group: 'Pomodoro' });
    w.ctx.settings.set({ ...w.ctx.settings.get(), language: 'zh' });
    await settle();
    expect(await c.statusItems({})).toMatchObject([{ text: '专注 25:00', title: '番茄钟' }]);
    expect(await menu()).toEqual(['开始', '跳过', '重置', '打开桌面浮窗', '完整设置…']);
    expect(c.commands().find((x) => x.id === 'pomodoro.skip')).toMatchObject({ title: '番茄钟：跳过', group: '番茄钟' });
    expect(w.ctx.settings.sections('zh').find((s) => s.id === 'pomodoro')).toMatchObject({ title: '番茄钟' });
    await c.run('pomodoro.toggle', {});
    const first = await status();
    expect(await c.statusItems({})).toMatchObject([{ text: '专注', until: first.deadline }]);
    expect((await menu())[0]).toBe('暂停');
    expect(surfaces.size).toBe(0);

    await c.run('pomodoro.desktop', {});
    await vi.waitFor(() => expect(surfaces.has('pomodoro.desktop')).toBe(true));
    const desktop = surfaces.get('pomodoro.desktop')!;
    expect(desktop.spec).toMatchObject({ transparent: true, clickThrough: true, anchor: 'sidebar-foot' });
    expect((await menu())[3]).toBe('收起桌面浮窗');
    expect(desktop.state).toMatchObject({ deadline: first.deadline, round: '第 1/4 轮' });
    // The status bar stays put while the widget is out.
    expect(await c.statusItems({})).toHaveLength(1);
    await desktop.spec.onMessage?.({ type: 'move', x: 3000, y: -3000 });
    await vi.waitFor(() => expect(desktop.bounds).toMatchObject({ x: 980, y: 0 }));
    await desktop.spec.onMessage?.({ type: 'action', action: 'toggle' });
    await vi.waitFor(() => expect(desktop.state.running).toBe(false));
    expect((await c.statusItems({}))[0]!.text).toMatch(/^专注 \d\d:\d\d · 已暂停$/);
    expect((await menu())[0]).toBe('继续');

    const shown: string[] = [];
    w.ctx.on('settings/show', (id) => void shown.push(id));
    await desktop.spec.onMessage?.({ type: 'action', action: 'settings' });
    await vi.waitFor(() => expect(shown).toEqual(['pomodoro']));

    await desktop.spec.onMessage?.({ type: 'action', action: 'desktop' });
    await vi.waitFor(() => expect(surfaces.has('pomodoro.desktop')).toBe(false));
    await c.run('pomodoro.desktop', {});
    await vi.waitFor(() => expect(surfaces.get('pomodoro.desktop')?.bounds).toMatchObject({ x: 980, y: 0 }));
    // Once moved, it reopens where it was left rather than at the anchor.
    expect(surfaces.get('pomodoro.desktop')!.spec.anchor).toBeUndefined();

    await fiber.dispose(); await settle();
    expect(await c.statusItems({})).toEqual([]);
    expect(surfaces.size).toBe(0);
  } finally { await fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});
