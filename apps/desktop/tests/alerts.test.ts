import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: {}, Notification: {} }));
import { ElectronAlerts, systemSounds } from "../src/alerts.js";

it("lists the system's sounds by name, its own alert sound first, and skips what is not audio", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-sounds-"));
  try {
    for (const file of ["Basso.aiff", "Glass.aiff", "Tink.aiff", "README.txt"]) fs.writeFileSync(path.join(dir, file), "");
    expect([...systemSounds({ dir, extensions: ["aiff"], preferred: ["Glass"] }).keys()]).toEqual(["Glass", "Basso", "Tink"]);
    expect(systemSounds({ dir: path.join(dir, "missing"), extensions: ["aiff"], preferred: [] }).size).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("plays only audio files given by absolute path", async () => {
  const alerts = Object.create(ElectronAlerts.prototype) as ElectronAlerts;
  await expect(alerts.play("relative/bell.mp3")).rejects.toThrow(/absolute path/);
  await expect(alerts.play(path.join(os.tmpdir(), "notes.txt"))).rejects.toThrow(/not an audio file/);
  await expect(alerts.play(path.join(os.tmpdir(), "tomrade-missing-bell.mp3"))).rejects.toThrow(/does not exist/);
  await expect(alerts.play("system:No Such Sound")).rejects.toThrow(/no system sound/);
});
