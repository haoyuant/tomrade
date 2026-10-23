/**
 * Whether these arguments fit on one command line here, with headroom for the
 * program's path and the environment. Windows caps the whole line at 32,767
 * UTF-16 units (quotes and escapes included); Linux caps each argument at
 * 128 KiB (MAX_ARG_STRLEN); macOS caps arguments and environment together at
 * 1 MiB (ARG_MAX).
 */
export function fitsCommandLine(args: string[], platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") {
    // Each argument is quoted and spaced; a quote or backslash may be escaped.
    const units = args.reduce((sum, arg) => sum + arg.length + 3 + (arg.match(/["\\]/g)?.length ?? 0), 0);
    return units <= 32_767 - 2_048;
  }
  const bytes = args.map((arg) => Buffer.byteLength(arg) + 1);
  if (platform === "linux") return bytes.every((n) => n <= 128 * 1024 - 1_024) && sum(bytes) <= 1536 * 1024;
  return sum(bytes) <= 768 * 1024;
}

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

/** Whether a terminal template hands the prompt file's text over as an argument (`"$(cat "{prompt}")"`) rather than the file. */
export function promptAsArgument(template: string): boolean {
  return /\$\(\s*(?:cat\s+|<\s*)["']?\{prompt\}/.test(template);
}
