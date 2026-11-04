import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineInstaller, EngineSetupProgress } from "@tomradex/agent";
import { ArchiveError, archiveDir, listZip, unpackArchive } from "../src/archive.js";
import { archiveFailure, applicableInstallers, bareLaunch, installerLaunch, paced, runArchive, runInstall, type SetupHost } from "../src/run.js";

/** One file as a zip holds it: its central-directory record and its local header. */
function zipOf(files: { name: string; data: Buffer; method?: 0 | 8 }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data, method = 0 } of files) {
    const body = method === 8 ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const EXE = Buffer.from("#!/bin/sh\necho 1.4.1\n");
const TOP = zipOf([{ name: "agy_acp_server.par", data: EXE, method: 8 }, { name: "README.txt", data: Buffer.from("docs") }]);

const dirs: string[] = [];
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-archive-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const URL_ = "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.1-macos-arm64.zip";
const ARCHIVE: EngineInstaller = { kind: "archive", url: URL_, file: "agy_acp_server.par", platform: { os: "darwin", arch: "arm64" } };

describe("reading an archive", () => {
  it("lists what the zip holds, and finds the named file whole and executable", () => {
    expect(listZip(TOP).map((entry) => entry.name)).toEqual(["agy_acp_server.par", "README.txt"]);
    const dir = scratch();
    const target = { dir: path.join(dir, "bin"), file: "agy_acp_server.par" };
    const landed = unpackArchive(TOP, "agy_acp_server.par", target, "darwin");
    expect(landed.file).toBe(path.join(dir, "bin", "agy_acp_server.par"));
    expect(fs.readFileSync(landed.file)).toEqual(EXE);
    // Windows has no executable bit; the file landing whole, above, is what it has.
    if (process.platform !== "win32") expect(fs.statSync(landed.file).mode & 0o111).not.toBe(0);
  });

  it("puts each release in its own folder under the app's agents folder", () => {
    const root = "/data/agents";
    expect(archiveDir(root, "agy", URL_)).toBe(path.join(root, "agy", "agy-acp-server-1.4.1-macos-arm64"));
    expect(archiveDir(root, "agy", "https://x.dev/2.0.0-win.zip")).toBe(path.join(root, "agy", "2.0.0-win"));
  });

  it("names what failed: not a zip, a file the release does not ship, a platform it does not fit", () => {
    expect(() => listZip(Buffer.from("<html>404</html>"))).toThrow(ArchiveError);
    expect(() => listZip(Buffer.from("<html>404</html>"))).toThrow(/not a zip archive/);
    const dir = scratch();
    expect(() => unpackArchive(TOP, "agy_acp_server.exe", { dir, file: "agy_acp_server.exe" }, "win32")).toThrow(/has no agy_acp_server\.exe/);
    expect(() => unpackArchive(TOP, "agy_acp_server.exe", { dir, file: "agy_acp_server.exe" }, "win32")).toThrow(/release does not ship/);
  });

  it("only runs the archive it declares a platform for", async () => {
    const host: SetupHost = { platform: "darwin", arch: "arm64", env: {}, answers: async () => false, npm: async () => null };
    expect(await applicableInstallers([ARCHIVE], host)).toEqual([ARCHIVE]);
    expect(await applicableInstallers([ARCHIVE], { ...host, arch: "x64" })).toEqual([]);
    expect(await applicableInstallers([ARCHIVE], { ...host, platform: "win32" })).toEqual([]);
    const launch = await installerLaunch(ARCHIVE, host);
    expect("failure" in launch && launch.failure.message).toContain("no command to run");
  });
});

describe("installing from an archive without a command", () => {
  const host = (over: Partial<SetupHost> = {}): SetupHost => {
    const dir = scratch();
    return {
      platform: "darwin",
      arch: "arm64",
      env: {},
      answers: async () => false,
      npm: async () => null,
      download: async () => ({ ok: true, status: 200, arrayBuffer: async () => TOP.buffer.slice(TOP.byteOffset, TOP.byteOffset + TOP.length) as ArrayBuffer }),
      archiveDir: (engineId, url) => path.join(dir, archiveDir("agents", engineId, url)),
      ...over
    };
  };

  it("downloads, unpacks where the locator looks, and says so in output", async () => {
    const lines: string[] = [];
    const landed = await runArchive(ARCHIVE as Extract<EngineInstaller, { kind: "archive" }>, { engineId: "agy", host: host(), signal: new AbortController().signal, say: (line) => void lines.push(line) });
    expect("file" in landed).toBe(true);
    if (!("file" in landed)) return;
    expect(path.basename(landed.file)).toBe("agy_acp_server.par");
    expect(fs.readFileSync(landed.file)).toEqual(EXE);
    expect(lines[0]).toContain(`Downloading ${URL_}`);
    expect(lines.at(-1)).toContain(`Unpacked to ${landed.file}`);
  });

  it("says a download failed in words a person can act on", async () => {
    const refused = await runArchive(ARCHIVE as Extract<EngineInstaller, { kind: "archive" }>, {
      engineId: "agy",
      host: host({ download: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }) }),
      signal: new AbortController().signal
    });
    expect("failure" in refused && refused.failure).toMatchObject({ kind: "not-found", message: expect.stringContaining("answered 404") });

    const offline = await runArchive(ARCHIVE as Extract<EngineInstaller, { kind: "archive" }>, {
      engineId: "agy",
      host: host({ download: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND dl.google.com"), { code: "ENOTFOUND" }); } }),
      signal: new AbortController().signal
    });
    expect("failure" in offline && offline.failure).toMatchObject({ kind: "network", message: expect.stringContaining("check your connection or proxy") });
    expect(archiveFailure(new Error("boom"), URL_).message).toBe(`could not download ${URL_}: boom — check your connection or proxy, then retry`);
  });

  it("runs as the one-click install and finishes once the engine finds what landed", async () => {
    const seen: EngineSetupProgress[] = [];
    let found = false;
    const end = await runInstall({
      engineId: "agy",
      installers: [ARCHIVE],
      host: host(),
      detect: async () => (found ? { ready: true, version: "1.4.1" } : { ready: false }),
      report: (progress) => void seen.push(progress),
      signal: new AbortController().signal,
      unpack: async (installer, deps) => {
        const ok = await runArchive(installer, deps);
        found = "file" in ok;
        return ok;
      }
    });
    expect(end).toMatchObject({ phase: "done", installer: "archive", version: "1.4.1" });
    expect(seen.filter((p) => p.phase === "running").length).toBeGreaterThanOrEqual(2);
    expect(seen.at(-2)?.phase).toBe("checking");
    expect(seen.at(-1)).toMatchObject({ phase: "done", output: expect.stringContaining("Unpacked to") });
  });

  it("pushes the bytes received as they arrive, against the whole size, then the unpack — at a pace", async () => {
    const pushes: { at: number; progress: EngineSetupProgress }[] = [];
    const piece = Math.ceil(TOP.length / 8);
    // A slow server: eight chunks, one every 40ms.
    const body = () => new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let at = 0; at < TOP.length; at += piece) {
          await new Promise((r) => setTimeout(r, 40));
          controller.enqueue(new Uint8Array(TOP.subarray(at, at + piece)));
        }
        controller.close();
      }
    });
    let found = false;
    const end = await runInstall({
      engineId: "agy",
      installers: [ARCHIVE],
      host: host({ download: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0), body: body(), headers: new Headers({ "content-length": String(TOP.length) }) }) }),
      detect: async () => (found ? { ready: true, version: "1.4.1" } : { ready: false }),
      report: paced((progress) => void pushes.push({ at: Date.now(), progress }), 100),
      signal: new AbortController().signal,
      unpack: async (installer, deps) => {
        const ok = await runArchive(installer, deps);
        found = "file" in ok;
        return ok;
      }
    });
    expect(end).toMatchObject({ phase: "done", installer: "archive", attempt: 1, attempts: 1 });
    const running = pushes.map((p) => p.progress).filter((p) => p.phase === "running");
    expect(running.map((p) => p.stage).filter((stage, i, all) => i === 0 || stage !== all[i - 1])).toEqual([undefined, "download", "unpack"]);
    const downloading = running.filter((p) => p.stage === "download" && p.received !== undefined);
    expect(downloading.length).toBeGreaterThanOrEqual(2);
    expect(downloading.every((p) => p.size === TOP.length)).toBe(true);
    const received = downloading.map((p) => p.received!);
    expect(received).toEqual([...received].sort((a, b) => a - b));
    expect(new Set(received).size).toBeGreaterThanOrEqual(2);
    expect(running.find((p) => p.stage === "unpack")).toMatchObject({ received: TOP.length, size: TOP.length });
    // Eight chunks and their lines, folded into fewer pushes, none of the same stage closer than the pace.
    expect(downloading.length).toBeLessThan(8);
    for (let i = 1; i < pushes.length; i++) {
      const [a, b] = [pushes[i - 1]!, pushes[i]!];
      if (a.progress.phase === b.progress.phase && a.progress.stage === b.progress.stage) expect(b.at - a.at).toBeGreaterThanOrEqual(95);
    }
  });

  it("writes the unpacked path into the engine's command when its own lookup misses it", async () => {
    const adopted: string[] = [];
    const end = await runInstall({
      engineId: "agy",
      installers: [ARCHIVE],
      host: host(),
      detect: async () => ({ ready: false, path: "agy_acp_server.par", error: "not found" }),
      report: () => {},
      signal: new AbortController().signal,
      adopt: async (file) => void adopted.push(file)
    });
    expect(end).toMatchObject({ phase: "failed", installer: "archive", failure: { kind: "not-on-path" } });
    expect(adopted).toHaveLength(1);
    expect(path.basename(adopted[0]!)).toBe("agy_acp_server.par");
  });

  it("falls on to the next installer when the archive fails", async () => {
    const NPM: EngineInstaller = { kind: "npm", package: "agy" };
    let installed = false;
    const end = await runInstall({
      engineId: "agy",
      installers: [ARCHIVE, NPM],
      host: host({ download: async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }) }),
      detect: async () => (installed ? { ready: true } : { ready: false }),
      report: () => {},
      signal: new AbortController().signal,
      resolve: (installer, registry) => installerLaunch(installer, host({ npm: async () => bareLaunch("npm") }), registry),
      exec: async () => {
        installed = true;
        return { code: 0, output: "" };
      }
    });
    expect(end).toMatchObject({ phase: "done", installer: "npm" });
  });
});
