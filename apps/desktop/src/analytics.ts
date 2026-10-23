import { app, BrowserWindow, powerMonitor } from "electron";
import type { Context } from "cordis";
import { Analytics, type AnalyticsConfig, type HostSignals } from "@tomradex/analytics";

/**
 * The Electron half of analytics: only here can the app see window focus, the
 * system's idle time and the lock/suspend events the tracker's timing rules
 * depend on. The package itself stays Electron-free, so its clock and signals
 * can be faked in tests.
 */
const host: HostSignals = {
  isFocused: () => {
    const focused = BrowserWindow.getFocusedWindow();
    return !!focused && !focused.isDestroyed();
  },
  idleMs: () => powerMonitor.getSystemIdleTime() * 1000,
  on(event, listener) {
    if (event === "quit") {
      app.on("before-quit", listener);
      return () => app.off("before-quit", listener);
    }
    if (event === "lock") {
      powerMonitor.on("lock-screen", listener);
      return () => powerMonitor.off("lock-screen", listener);
    }
    if (event === "suspend") {
      powerMonitor.on("suspend", listener);
      return () => powerMonitor.off("suspend", listener);
    }
    powerMonitor.on("resume", listener);
    return () => powerMonitor.off("resume", listener);
  }
};

export default function analytics(ctx: Context, config: Omit<AnalyticsConfig, "host">) {
  ctx.plugin(Analytics, { ...config, host });
}
