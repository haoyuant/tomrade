import fs from "node:fs";
import path from "node:path";
import { Logger } from "cordis";
import { redactSecrets } from "@tomradex/agent";

const KEEP_DAYS = 7;
const PREFIX = "tomrade-";

/** Older than a week: gone, so the folder never grows past a few days of lines. */
function prune(dir: string, now = Date.now()): void {
  for (const name of fs.readdirSync(dir)) {
    const day = name.startsWith(PREFIX) && name.endsWith(".log") ? Date.parse(name.slice(PREFIX.length, -4)) : NaN;
    if (Number.isFinite(day) && now - day > KEEP_DAYS * 86_400_000) fs.rmSync(path.join(dir, name), { force: true });
  }
}

/**
 * The log a packaged build used to lose: one file a day under `dir`, a week
 * kept, keys and tokens masked before a line is written. The troubleshooter
 * reads its tail into a report.
 */
export function fileExporter(dir: string) {
  let day = "";
  let stream: fs.WriteStream | null = null;
  const current = (): fs.WriteStream | null => {
    const today = new Date().toISOString().slice(0, 10);
    if (today === day) return stream;
    stream?.end();
    day = today;
    try {
      fs.mkdirSync(dir, { recursive: true });
      prune(dir);
      stream = fs.createWriteStream(path.join(dir, `${PREFIX}${today}.log`), { flags: "a" });
      stream.on("error", () => { stream = null; });
    } catch {
      stream = null;
    }
    return stream;
  };
  return {
    colors: 0,
    export(message: Parameters<typeof Logger.format>[1]) {
      const line = `${new Date(message.ts ?? Date.now()).toISOString()} ${message.type.toUpperCase().padEnd(5)} [${message.name}] ${Logger.format(this, message)}`;
      current()?.write(`${redactSecrets(line)}\n`);
    }
  };
}
