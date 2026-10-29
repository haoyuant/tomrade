import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { lineReader, parseTerminalLine, pipePath, terminalCommand, frameLine } from "../src/protocol.js";
import { diffFrame, fullFrame, renderRow, type Screen } from "../src/render.js";
import { defaultShell, onPath } from "../src/shell.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");

describe("the pipe a host listens on", () => {
  it("is this user's, kept apart per data folder", () => {
    expect(pipePath("", "ann")).toBe("\\\\.\\pipe\\tomrade-pty-ann");
    const a = pipePath("C:\\Users\\ann\\AppData\\Roaming\\Tomrade", "ann");
    const b = pipePath("C:\\work\\tomrade\\.data", "ann");
    expect(a).toMatch(/^\\\\\.\\pipe\\tomrade-pty-ann-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(pipePath("x", "ann")).toBe(pipePath("x", "ann"));
  });

  it("takes no character of the user name a pipe name cannot hold", () => {
    expect(pipePath("", "DOMAIN\\Ann Lee")).toBe("\\\\.\\pipe\\tomrade-pty-DOMAIN_Ann_Lee");
  });
});

describe("lines on the pipe", () => {
  it("hands over whole lines, a partial one once the rest comes", () => {
    const lines: string[] = [];
    const read = lineReader((line) => lines.push(line));
    read('{"a":1}\n{"b"');
    expect(lines).toEqual(['{"a":1}']);
    read(':2}\r\n\n{"c":3}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("reads back the frames the host sends, bytes intact, and nothing it does not know", () => {
    const bytes = new Uint8Array(Buffer.from("\x1b[31mhé\x1b[0m"));
    const parsed = parseTerminalLine(JSON.stringify(frameLine({ seq: 3, width: 80, height: 24, full: true, bytes })));
    expect(parsed).toEqual({ type: "frame", frame: { seq: 3, width: 80, height: 24, full: true, bytes } });
    expect(parseTerminalLine('{"type":"terminal.closed","reason":"exited"}')).toEqual({ type: "closed", reason: "exited" });
    expect(parseTerminalLine('{"type":"terminal.later"}')).toBeNull();
    expect(parseTerminalLine("not json")).toBeNull();
  });

  it("sends herdr's command shapes, sizes kept in range", () => {
    expect(terminalCommand.input("ls\r")).toEqual({ type: "terminal.input", text: "ls\r" });
    expect(terminalCommand.input(new Uint8Array([1, 2]))).toEqual({ type: "terminal.input", bytes: "AQI=" });
    expect(terminalCommand.resize(0, 1e9)).toEqual({ type: "terminal.resize", cols: 1, rows: 0xffff });
    expect(terminalCommand.scroll({ direction: "up", lines: 3, source: "page_key" })).toEqual({ type: "terminal.scroll", direction: "up", lines: 3, source: "page_key", modifiers: 0 });
  });
});

/** A headless terminal with `text` written, once it has taken all of it. */
async function written(text: string, cols = 20, rows = 4) {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(text, resolve));
  return term;
}

describe("a row as the window paints it", () => {
  it("styles each run once and leaves out trailing blanks", async () => {
    const term = await written("ab\x1b[1;31mcd\x1b[0m  e  ");
    const row = renderRow(term.buffer.active.getLine(0), term.cols, term.buffer.active.getNullCell());
    expect(row.text).toBe("ab\x1b[0;1;31mcd\x1b[0m  e");
    expect(row.width).toBe(7);
  });

  it("keeps blanks that carry a colour, and paints a wide character once", async () => {
    const term = await written("\x1b[44m  \x1b[0m中x");
    const row = renderRow(term.buffer.active.getLine(0), term.cols, term.buffer.active.getNullCell());
    expect(row.text).toBe("\x1b[0;44m  \x1b[0m中x");
    expect(row.width).toBe(5);
  });

  it("names 256 and true colours the way the program set them", async () => {
    const term = await written("\x1b[38;5;208ma\x1b[48;2;1;2;3mb");
    const row = renderRow(term.buffer.active.getLine(0), term.cols, term.buffer.active.getNullCell());
    expect(row.text).toBe("\x1b[0;38;5;208ma\x1b[0;38;5;208;48;2;1;2;3mb\x1b[0m");
  });

  it("styles a cell anew when only its colour's kind or one attribute differs from the cell before", async () => {
    const term = await written("\x1b[31ma\x1b[38;2;0;0;1mb\x1b[3mc\x1b[23md");
    const row = renderRow(term.buffer.active.getLine(0), term.cols, term.buffer.active.getNullCell());
    expect(row.text).toBe("\x1b[0;31ma\x1b[0;38;2;0;0;1mb\x1b[0;3;38;2;0;0;1mc\x1b[0;38;2;0;0;1md\x1b[0m");
  });
});

const screen = (rows: string[], patch: Partial<Screen> = {}): Screen => ({ width: 10, height: rows.length, rows, widths: rows.map((r) => r.length), cursor: { x: 0, y: 0 }, modes: "M", ...patch });

describe("frames", () => {
  it("paints a whole screen from a cleared one, with the modes and the cursor", () => {
    const bytes = fullFrame(screen(["one", "", "three"], { cursor: { x: 2, y: 2 } }));
    expect(bytes).toBe("\x1b[0m\x1b[?25l\x1b[H\x1b[2JM\x1b[1;1Hone\x1b[3;1Hthree\x1b[3;3H\x1b[?25h");
  });

  it("paints only the rows that changed, clearing a shorter one to its end", () => {
    const before = screen(["one", "two", "three"]);
    const after = screen(["one", "2", "three"]);
    expect(diffFrame(before, after)).toBe("\x1b[?25l\x1b[2;1H2\x1b[K\x1b[1;1H\x1b[?25h");
  });

  it("does not clear after a row that fills its width", () => {
    const after = screen(["0123456789"]);
    expect(diffFrame(screen(["x"]), after)).toBe("\x1b[?25l\x1b[1;1H0123456789\x1b[1;1H\x1b[?25h");
  });

  it("sends nothing when nothing changed, and keeps a hidden cursor hidden", () => {
    const hidden = screen(["a"], { cursor: null });
    expect(diffFrame(hidden, screen(["a"], { cursor: null }))).toBe("");
    expect(diffFrame(hidden, screen(["b"], { cursor: null }))).toBe("\x1b[?25l\x1b[1;1Hb\x1b[K");
  });

  it("sends the modes again when the program changed one", () => {
    expect(diffFrame(screen(["a"]), screen(["a"], { modes: "N" }))).toBe("\x1b[?25lN\x1b[1;1H\x1b[?25h");
  });

  it("paints a screen of another size whole", () => {
    expect(diffFrame(screen(["a"]), screen(["a", "b"]))).toBe(fullFrame(screen(["a", "b"])));
  });
});

describe("the shell a plain terminal runs", () => {
  const env = { PATH: "C:\\Tools;C:\\Program Files\\PowerShell\\7", PATHEXT: ".COM;.EXE", SystemRoot: "C:\\Windows" };

  it("is PowerShell 7 when it is on PATH", () => {
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.EXE".toLowerCase();
    expect(defaultShell(env, (f) => f.toLowerCase() === pwsh).file.toLowerCase()).toBe(pwsh);
  });

  it("is Windows PowerShell otherwise", () => {
    const builtin = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    expect(defaultShell(env, (f) => f === builtin)).toEqual({ file: builtin, args: ["-NoLogo"] });
    expect(defaultShell(env, () => false).file).toBe("powershell.exe");
  });

  it("finds a command on PATH by Windows' own extensions", () => {
    expect(onPath("git", { Path: "C:\\a;\"C:\\b\"", PATHEXT: ".EXE;.CMD" }, (f) => f === "C:\\b\\git.cmd")).toBe("C:\\b\\git.cmd");
    expect(onPath("git", { PATH: "C:\\a" }, () => false)).toBeNull();
  });
});
