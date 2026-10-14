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

it('Pomodoro shares one timer across pet and desktop, edits rules, clamps dragging and cleans up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomrade-pomodoro-'));
  fs.mkdirSync(path.join(dir, 'dist/static'), { recursive: true });
  for (const doc of ['timer.html', 'rules.html']) fs.copyFileSync(path.resolve('packages/extensions/examples-pomodoro/static', doc), path.join(dir, 'dist/static', doc));
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
    const commands = w.ctx.contributions;
    expect(await commands.assistantWidgets()).toHaveLength(1);
    await commands.run('pomodoro.toggle', {});
    const status = () => w.ctx.tools.execute('pomodoro_status', {}, { by: 'human' }) as Promise<any>;
    const first = await status();
    await commands.run('pomodoro.mode', {});
    expect(await commands.assistantWidgets()).toEqual([]);
    const desktop = surfaces.get('pomodoro.desktop')!;
    expect(desktop.state.deadline).toBe(first.deadline);
    await desktop.spec.onMessage?.({ type: 'move', dx: 3000, dy: -3000 });
    await vi.waitFor(() => expect(desktop.bounds).toMatchObject({ x: 920, y: 0 }));
    await commands.run('pomodoro.settings', {});
    const editor = surfaces.get('pomodoro.rules')!;
    expect(editor.spec.focusable).toBe(true);
    await editor.spec.onMessage?.({ type: 'save', rules: { focusMinutes: 30, longBreakEvery: 3 } });
    await vi.waitFor(() => expect(surfaces.has('pomodoro.rules')).toBe(false));
    await commands.run('pomodoro.mode', {});
    expect((await status()).config.focusMinutes).toBe(30);
    expect((await status()).deadline).toBe(first.deadline);
    expect(surfaces.has('pomodoro.rules')).toBe(false);
    expect(await commands.assistantWidgets()).toHaveLength(1);
    await commands.run('pomodoro.mode', {});
    expect(surfaces.get('pomodoro.desktop')!.bounds).toMatchObject({ x: 920, y: 0 });
    await fiber.dispose(); await settle();
    expect(await commands.assistantWidgets()).toEqual([]);
    expect(surfaces.size).toBe(0);
  } finally { await fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});
