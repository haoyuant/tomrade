import { Timer } from './timer.js';
export default async function(t: any) {
 const rules = { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4, autoStart: false };
 const timer = new Timer(rules);
 timer.start(0); timer.pause(60_000);
 t.check('pause preserves remaining time', timer.remaining === 24 * 60_000 && timer.deadline === null);
 timer.configure({...rules});t.check('display-only changes preserve paused time', timer.remaining === 24 * 60_000);
 timer.start(100_000); timer.tick(100_000 + 24 * 60_000);
 t.check('focus ends at short break, paused by default', timer.phase === 'shortBreak' && timer.completed === 1 && timer.deadline === null);
 for(let n=1;n<4;n++) {timer.skip(0);timer.start(0);timer.tick(25*60_000);}
 t.check('fourth focus selects long break', timer.phase === 'longBreak' && timer.completed === 4 && timer.remaining === 15*60_000);
 timer.reset();timer.configure({...rules,autoStart:true});timer.start(0);timer.tick(100*60_000);
 t.check('sleep counts one session and starts a fresh break', timer.completed === 1 && timer.phase === 'shortBreak' && timer.deadline === 105*60_000);
 timer.pause(101*60_000);timer.reset();
 t.check('reset restores first focus',timer.phase === 'focus' && timer.completed === 0 && timer.remaining === 25*60_000 && timer.deadline === null);
 timer.configure({...rules,focusMinutes:30});t.check('rules update idle duration', timer.remaining === 30*60_000);
 timer.reset();timer.skip(0);t.check('skipping focus does not count a completed session', timer.completed === 0);
 const status:any = await t.tool('pomodoro_status',{});t.check('default mode is embedded',status.config.mode === 'embedded' && !status.running);
 await t.tool('pomodoro_control',{action:'toggle'});const running:any=await t.tool('pomodoro_status',{});t.check('control starts timer',running.running);
 await t.tool('pomodoro_control',{action:'reset'});
}
