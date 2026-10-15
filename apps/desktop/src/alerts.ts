import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, Notification } from "electron";
import { Context, Service } from "cordis";
import { AUDIO_EXTENSIONS, type AlertHost, type AlertNotice, type AlertSound } from "@tomradex/alerts";

interface SoundSource {
  dir: string;
  extensions: string[];
  /** The one the system itself alerts with, listed first. */
  preferred: string[];
}

const SOURCES: Partial<Record<NodeJS.Platform, SoundSource>> = {
  darwin: { dir: "/System/Library/Sounds", extensions: ["aiff"], preferred: ["Glass"] },
  win32: { dir: path.join(process.env.SystemRoot ?? "C:\\Windows", "Media"), extensions: ["wav"], preferred: ["Windows Notify System Generic", "Windows Notify", "chimes"] },
  linux: { dir: "/usr/share/sounds/freedesktop/stereo", extensions: ["oga", "ogg", "wav"], preferred: ["complete", "bell"] }
};

const clamp = (volume: number | undefined) => Math.max(0, Math.min(1, volume ?? 1));

/** The system's sounds as files, by the name the system gives them. */
export function systemSounds(source = SOURCES[process.platform]): Map<string, string> {
  const found = new Map<string, string>();
  if (!source) return found;
  let names: string[];
  try {
    names = fs.readdirSync(source.dir);
  } catch {
    return found;
  }
  for (const file of names.sort((a, b) => a.localeCompare(b))) {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (source.extensions.includes(ext)) found.set(path.basename(file, path.extname(file)), path.join(source.dir, file));
  }
  const first = source.preferred.filter((name) => found.has(name));
  return new Map([...first.map((name) => [name, found.get(name)!] as const), ...[...found].filter(([name]) => !first.includes(name))]);
}

/** A command that plays one file at a volume and exits; the shell has no audio of its own. */
function player(file: string, volume: number): [string, string[]] {
  if (process.platform === "darwin") return ["afplay", ["-v", String(volume), file]];
  if (process.platform === "win32") {
    const quoted = file.replace(/'/g, "''");
    // MediaPlayer reads mp3 and m4a too, unlike SoundPlayer; it plays only while the process lives.
    const script = `Add-Type -AssemblyName PresentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Volume = ${volume}; $p.Open([Uri]'${quoted}'); $p.Play(); Start-Sleep -Milliseconds 400; while ($p.NaturalDuration.HasTimeSpan -and $p.Position -lt $p.NaturalDuration.TimeSpan) { Start-Sleep -Milliseconds 200 }; Start-Sleep -Milliseconds 200`;
    return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]];
  }
  return ["paplay", [`--volume=${Math.round(volume * 65536)}`, file]];
}

/** Notifications through the system, sounds through the system's own player. */
export class ElectronAlerts extends Service implements AlertHost {
  static provide = "alerts";

  constructor(ctx: Context) {
    super(ctx, "alerts");
  }

  sounds(): AlertSound[] {
    return [...systemSounds().keys()].map((name) => ({ id: `system:${name}`, title: name }));
  }

  async play(sound: string, opts: { volume?: number } = {}): Promise<void> {
    const file = sound.startsWith("system:") ? systemSounds().get(sound.slice("system:".length)) : sound;
    if (!file) throw new Error(`no system sound named "${sound.slice("system:".length)}"`);
    if (!path.isAbsolute(file)) throw new Error(`a sound file must be an absolute path, not "${file}"`);
    if (!AUDIO_EXTENSIONS.includes(path.extname(file).slice(1).toLowerCase())) throw new Error(`"${path.basename(file)}" is not an audio file`);
    if (!fs.existsSync(file)) throw new Error(`the sound file "${file}" does not exist`);
    const volume = clamp(opts.volume);
    if (volume === 0) return;
    const [cmd, args] = player(file, volume);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
      child.once("spawn", () => resolve());
      child.once("error", (error) => {
        this.ctx.logger("alerts").warn(`${cmd}: ${error.message}`);
        reject(error);
      });
      child.unref();
    });
  }

  notify(notice: AlertNotice): void {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: notice.title, body: notice.body ?? "", silent: true });
    note.on("click", () => {
      // the main window, not a plugin's surface (those never take focus)
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.getParentWindow() && w.isFocusable());
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    note.show();
  }
}

export default ElectronAlerts;
