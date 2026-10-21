import { THEME_TOKEN_NAMES, THEME_TYPOGRAPHY_NAMES } from "@tomradex/domain";
import { logQuietly } from "./api";
import { cssColorToHex } from "./theme";

declare module "@tomradex/ipc" {
  interface Channels {
    "surfaces.look": (look: { theme: string; dark: boolean; tokens: Record<string, string>; locale: string }) => void;
  }
}

/** Dark by the background's lightness, so custom themes are judged by how they look, not by their base. */
const isDark = (hex: string): boolean => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.5;
};

/** Tells the shell how the app looks now, for plugin windows to match: the theme's variables as painted, and the language. */
export function sendSurfaceLook(theme: string, locale: string): void {
  if (typeof window === "undefined" || !window.tomrade) return;
  const styles = getComputedStyle(document.documentElement);
  const tokens = Object.fromEntries([...THEME_TOKEN_NAMES, ...THEME_TYPOGRAPHY_NAMES].map((name) => [`--${name}`, styles.getPropertyValue(`--${name}`).trim()]).filter(([, value]) => value));
  const dark = isDark(cssColorToHex(tokens["--bg"] ?? "#ffffff"));
  void window.tomrade.invoke("surfaces.look", { theme, dark, tokens, locale }).catch(logQuietly("surfaces.look"));
}
