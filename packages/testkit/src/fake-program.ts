import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * A test's stand-in for a program the code under test runs (git, gh, an agent's CLI): a script with its shebang.
 * macOS and Linux run it as it is. Windows runs no script directly, and Node will not start a .cmd without a shell, so
 * there each fake is a small launcher, `<file>.exe`, that runs the script with Git for Windows' sh (or Node, for a
 * `#!…node` script) and passes on its arguments, input, output and exit code. It runs the script in a job that ends
 * with it, so a fake the code under test kills takes its script down too, as a killed process does elsewhere.
 */

const LAUNCHER = String.raw`using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class Launcher {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, int length);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
    var s = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in a) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { s.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
      s.Append('\\', slashes).Append(c);
      slashes = 0;
    }
    return s.Append('\\', slashes * 2).Append('"').ToString();
  }

  static int Main(string[] args) {
    var job = CreateJobObject(IntPtr.Zero, null);
    var limits = new ExtendedLimits();
    limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)));
    AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle);
    string self = Process.GetCurrentProcess().MainModule.FileName;
    // Line 1: the program; line 2: a folder to put first on PATH, or nothing; line 3: the script.
    string[] launch = File.ReadAllLines(self + ".launch");
    var argv = new List<string> { launch[2] };
    argv.AddRange(args);
    var info = new ProcessStartInfo(launch[0]) { UseShellExecute = false };
    if (launch[1].Length > 0) info.EnvironmentVariables["PATH"] = launch[1] + ";" + Environment.GetEnvironmentVariable("PATH");
    var quoted = new string[argv.Count];
    for (int i = 0; i < argv.Count; i++) quoted[i] = Quote(argv[i]);
    info.Arguments = string.Join(" ", quoted);
    try {
      using (var child = Process.Start(info)) {
        child.WaitForExit();
        return child.ExitCode;
      }
    } catch (Win32Exception e) {
      Console.Error.WriteLine("fake program: " + e.Message);
      return 127;
    }
  }
}
`;

let launcher: string | null = null;

/** The launcher, compiled once per machine with the C# compiler every Windows has, and kept in the temp folder. */
function launcherExe(): string {
  if (launcher && fs.existsSync(launcher)) return launcher;
  const tag = createHash("sha256").update(LAUNCHER).digest("hex").slice(0, 12);
  const exe = path.join(os.tmpdir(), `tomrade-fake-program-${tag}.exe`);
  if (!fs.existsSync(exe)) {
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    const csc = ["Framework64", "Framework"].map((f) => path.join(root, "Microsoft.NET", f, "v4.0.30319", "csc.exe")).find((f) => fs.existsSync(f));
    if (!csc) throw new Error("fakeProgram needs the .NET Framework C# compiler (csc.exe) on Windows");
    // Built under a name of its own, then moved into place: workers starting together never run a half-written one.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-fake-program-"));
    fs.writeFileSync(path.join(work, "Launcher.cs"), LAUNCHER);
    execFileSync(csc, ["-nologo", "-optimize", "-out:launcher.exe", "Launcher.cs"], { cwd: work, stdio: "pipe" });
    try {
      fs.renameSync(path.join(work, "launcher.exe"), exe);
    } catch (err) {
      if (!fs.existsSync(exe)) throw err;
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
  return (launcher = exe);
}

let gitSh: string | null = null;

/** Git for Windows' sh, beside the git on PATH: the tests that fake programs need git already. */
function shOfGit(): string {
  if (gitSh) return gitSh;
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(";").filter(Boolean)) {
    if (!fs.existsSync(path.join(dir, "git.exe"))) continue;
    // git.exe sits in <Git>\cmd, <Git>\bin or <Git>\mingw64\bin; sh in <Git>\usr\bin.
    for (const up of ["..", path.join("..", "..")]) {
      const sh = path.resolve(dir, up, "usr", "bin", "sh.exe");
      if (fs.existsSync(sh)) return (gitSh = sh);
    }
  }
  throw new Error("fakeProgram needs Git for Windows (its sh runs the fakes) on PATH");
}

/**
 * Writes `script` as a program at `file` (written whole, so a run meanwhile reads the old one or the new one) and returns
 * the path to hand the code under test: `file` itself on macOS and Linux, `<file>.exe` on Windows, which a bare `file`
 * on PATH or spawned without its extension finds as well.
 */
export function fakeProgram(file: string, script: string): string {
  const next = `${file}.next`;
  if (process.platform !== "win32") {
    fs.writeFileSync(next, script, { mode: 0o755 });
    fs.renameSync(next, file);
    return file;
  }
  const exe = `${file}.exe`;
  const body = `${exe}.script`;
  fs.writeFileSync(next, script);
  fs.renameSync(next, body);
  const node = /^#![^\n]*\bnode\b/.test(script);
  const sh = node ? null : shOfGit();
  fs.writeFileSync(`${exe}.launch`, [node ? process.execPath : sh, sh ? path.dirname(sh) : "", body].join("\n"));
  if (!fs.existsSync(exe)) fs.copyFileSync(launcherExe(), exe);
  return exe;
}
