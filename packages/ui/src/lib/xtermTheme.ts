import type { ITheme } from "@xterm/xterm";

/**
 * A CSS colour as xterm takes it (#rrggbb): the page resolves var(), oklch() and color-mix(),
 * a canvas pixel turns the result into sRGB.
 */
function hex(css: string, probe: HTMLElement, pixel: CanvasRenderingContext2D): string {
  probe.style.color = css;
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillStyle = getComputedStyle(probe).color;
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The terminal's colours from the theme on this page — the app's look once it has arrived, Tomrade's
 * default before — the ANSI palette included, so programs' colours read on light and dark themes alike.
 */
export function terminalTheme(): ITheme {
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const pixel = canvas.getContext("2d", { willReadFrequently: true })!;
  const c = (css: string) => hex(css, probe, pixel);
  const background = c("var(--surface)");
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16));
  const dark = 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 128;
  // Bright colours lean toward the text colour: darker on a light theme, lighter on a dark one.
  const bright = (css: string) => c(`color-mix(in oklch, ${css} 72%, var(--fg))`);
  const magenta = "color-mix(in oklch, var(--danger) 50%, var(--accent))";
  const cyan = "color-mix(in oklch, var(--success) 50%, var(--accent))";
  const theme: ITheme = {
    background,
    foreground: c("var(--fg)"),
    cursor: c("var(--accent)"),
    cursorAccent: background,
    selectionBackground: c("color-mix(in oklch, var(--accent) 22%, var(--surface))"),
    black: c(dark ? "var(--border-input)" : "var(--fg)"),
    brightBlack: c("var(--meta)"),
    red: c("var(--danger)"),
    brightRed: bright("var(--danger)"),
    green: c("var(--success)"),
    brightGreen: bright("var(--success)"),
    yellow: c("var(--warn)"),
    brightYellow: bright("var(--warn)"),
    blue: c("var(--accent)"),
    brightBlue: bright("var(--accent)"),
    magenta: c(magenta),
    brightMagenta: bright(magenta),
    cyan: c(cyan),
    brightCyan: bright(cyan),
    white: c(dark ? "var(--muted)" : "var(--meta)"),
    brightWhite: c(dark ? "var(--fg)" : "var(--muted)")
  };
  probe.remove();
  return theme;
}
