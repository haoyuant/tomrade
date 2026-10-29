import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { parseProcessTable, type ProcessRow } from "./agents.js";
import type { SpawnPty } from "./host.js";
import type { Pane } from "./pane.js";

/** A program on a pseudoconsole: node-pty over ConPTY with the OpenConsole it ships, the same on Windows 10 and 11 and twice as fast as the system's conhost. */
export const spawnConpty: SpawnPty = (file, args, opts) => {
  const pty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
  return pty.spawn(file, args, { name: "xterm-256color", cwd: opts.cwd, env: opts.env, cols: opts.cols, rows: opts.rows, useConpty: true, useConptyDll: true });
};

/** Ends each table the reader prints; no row holds a control character. */
const END = "\u0003";

/**
 * For each line on stdin, every process's pid, parent, start (FILETIME), name and command line, one per line, tabs
 * between, UTF-8. Read through the Win32 API (a snapshot, then each process's times and command line), compiled once:
 * a WMI query costs about half a second. Where C# cannot be compiled, WMI it is.
 */
const READER_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "$native = $true",
  "try {",
  "Add-Type -ErrorAction Stop -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "using System.Text;",
  "public static class TomradeProcessTable {",
  "  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
  "  struct Entry { public uint size; public uint usage; public uint pid; public IntPtr heap; public uint module; public uint threads; public uint ppid; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe; }",
  '  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);',
  '  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);',
  '  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);',
  '  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);',
  '  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, IntPtr buffer, int length, out int needed);',
  // ProcessCommandLineInformation (60): a UNICODE_STRING (byte length, capacity, pointer) and its characters after it.
  "  static string CommandLine(IntPtr process) {",
  "    int needed;",
  "    NtQueryInformationProcess(process, 60, IntPtr.Zero, 0, out needed);",
  '    if (needed <= 0) return "";',
  "    IntPtr buffer = Marshal.AllocHGlobal(needed);",
  "    try {",
  '      if (NtQueryInformationProcess(process, 60, buffer, needed, out needed) != 0) return "";',
  "      int bytes = Marshal.ReadInt16(buffer) & 0xffff;",
  "      IntPtr chars = Marshal.ReadIntPtr(buffer, IntPtr.Size);",
  '      return bytes > 0 && chars != IntPtr.Zero ? Marshal.PtrToStringUni(chars, bytes / 2) : "";',
  "    } finally { Marshal.FreeHGlobal(buffer); }",
  "  }",
  "  static string Plain(string text) {",
  "    var plain = new StringBuilder(text.Length);",
  "    foreach (char c in text) plain.Append(c < ' ' ? ' ' : c);",
  "    return plain.ToString();",
  "  }",
  "  public static string Read() {",
  "    var table = new StringBuilder();",
  "    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);",
  '    if (snapshot == new IntPtr(-1)) throw new InvalidOperationException("no snapshot");',
  "    try {",
  "      var e = new Entry();",
  "      e.size = (uint)Marshal.SizeOf(typeof(Entry));",
  "      for (bool more = Process32FirstW(snapshot, ref e); more; more = Process32NextW(snapshot, ref e)) {",
  '        long created = 0; string command = "";',
  "        IntPtr process = OpenProcess(0x1000, false, e.pid);",
  "        if (process != IntPtr.Zero) {",
  "          long exited, kernel, user;",
  "          if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) created = 0;",
  "          command = CommandLine(process);",
  "          CloseHandle(process);",
  "        }",
  "        table.Append(e.pid).Append('\\t').Append(e.ppid).Append('\\t').Append(created).Append('\\t').Append(Plain(e.exe)).Append('\\t').Append(Plain(command)).Append('\\n');",
  "      }",
  "    } finally { CloseHandle(snapshot); }",
  "    return table.ToString();",
  "  }",
  "}",
  "'@",
  "} catch { $native = $false }",
  "while ($null -ne [Console]::In.ReadLine()) {",
  "  if ($native) { [Console]::Out.Write([TomradeProcessTable]::Read()) }",
  "  else {",
  "    Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,CommandLine | ForEach-Object {",
  "      $created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }",
  "      [Console]::Out.Write(\"$($_.ProcessId)`t$($_.ParentProcessId)`t$created`t$($_.Name -replace '[\\x00-\\x1f]', ' ')`t$($_.CommandLine -replace '[\\x00-\\x1f]', ' ')`n\")",
  "    }",
  "  }",
  `  [Console]::Out.Write([char]${END.charCodeAt(0)})`,
  "  [Console]::Out.Flush()",
  "}"
].join("\n");

/** How long the reader waits for the next read; it exits after that, and the next read starts another. */
export const READER_IDLE_MS = 60_000;

/**
 * The process table through one Windows PowerShell (always there), kept for the next read: starting one costs more
 * than the read. Reads go one at a time; one that fails or takes longer than its timeout ends the reader.
 */
export class ProcessReader {
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly idleMs = READER_IDLE_MS) {}

  /** The reader's pid while it runs. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  read(timeoutMs = 15_000): Promise<ProcessRow[]> {
    const next = this.queue.then(() => this.once(timeoutMs));
    this.queue = next.catch(() => undefined);
    return next;
  }

  dispose(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin.end();
    child.kill();
  }

  private start(): ChildProcessByStdio<Writable, Readable, null> {
    const encoded = Buffer.from(READER_SCRIPT, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    child.stdout.setEncoding("utf8");
    child.stdin.on("error", () => undefined);
    child.on("error", () => undefined);
    child.once("exit", () => {
      if (this.child === child) this.child = null;
    });
    // A waiting reader keeps nothing alive: a read in flight has its timer for that.
    child.unref();
    (child.stdin as unknown as Socket).unref?.();
    (child.stdout as unknown as Socket).unref?.();
    this.child = child;
    return child;
  }

  private once(timeoutMs: number): Promise<ProcessRow[]> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const child = this.child ?? this.start();
    return new Promise<ProcessRow[]>((resolve, reject) => {
      let text = "";
      const done = (err: Error | null) => {
        clearTimeout(timer);
        child.stdout.off("data", data);
        child.off("exit", gone);
        child.off("error", gone);
        if (err) {
          if (this.child === child) this.dispose();
          return reject(err);
        }
        this.idle = setTimeout(() => this.dispose(), this.idleMs);
        this.idle.unref();
        resolve(parseProcessTable(text));
      };
      const data = (chunk: string) => {
        text += chunk;
        const end = text.indexOf(END);
        if (end < 0) return;
        text = text.slice(0, end);
        done(null);
      };
      const gone = () => done(new Error("the process table reader ended"));
      const timer = setTimeout(() => done(new Error(`the process table took longer than ${timeoutMs / 1000} s`)), timeoutMs);
      child.stdout.on("data", data);
      child.once("exit", gone);
      child.once("error", gone);
      child.stdin.write("read\n");
    });
  }
}

const reader = new ProcessReader();

/** The process table; rejects when it cannot be read or takes longer than `timeoutMs`. */
export function scanProcesses(timeoutMs = 15_000): Promise<ProcessRow[]> {
  return reader.read(timeoutMs);
}

/**
 * Ends a pane's process and everything it started. taskkill /T walks the tree from the live root, so it goes first;
 * node-pty's kill then closes the console (its helper's "AttachConsole failed" goes to the host's ignored stderr).
 */
export function killTree(pane: Pane): Promise<void> {
  return new Promise<void>((resolve) => {
    execFile("taskkill", ["/T", "/F", "/PID", String(pane.pid)], { windowsHide: true }, () => {
      try {
        pane.pty.kill();
      } catch {
        // already gone
      }
      resolve();
    });
  });
}
