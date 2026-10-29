import fs from "node:fs";
import path from "node:path";

/** The first file of that name on PATH, with Windows' own extensions; null when there is none. */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): string | null {
  const w = path.win32;
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean);
  for (const dir of pathValue.split(";").map((d) => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean)) {
    for (const ext of exts) {
      const file = w.join(dir, `${name}${ext}`);
      if (exists(file)) return file;
    }
  }
  return null;
}

/**
 * Windows PowerShell 5.1 ships PSReadLine 2.0, which paints the console's background color behind every redraw as an
 * explicit color, leaving blocks under spaces and erased characters; without it the line still edits, with history and Tab.
 */
const dropOldPSReadLine = "if ((Get-Module PSReadLine).Version -lt [version]'2.1') { Remove-Module PSReadLine -ErrorAction Ignore }";

/** What a plain terminal runs: PowerShell 7 when it is installed, else Windows PowerShell. */
export function defaultShell(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): { file: string; args: string[] } {
  const pwsh = onPath("pwsh", env, exists);
  if (pwsh) return { file: pwsh, args: ["-NoLogo"] };
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  const builtin = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return { file: exists(builtin) ? builtin : "powershell.exe", args: ["-NoLogo", "-NoExit", "-Command", dropOldPSReadLine] };
}
