import { app, BrowserWindow, powerMonitor } from "electron";
import type { Context } from "cordis";
import { Analytics, reportedClient, type AnalyticsConfig, type HostSignals } from "@tomradex/analytics";
import { DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_PUBLISHABLE_KEY } from "./hub-cloud.js";

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

const endpoint = (value: string | undefined): "auto" | "global" | "cn" =>
  value === "cn" || value === "global" ? value : "auto";

export default function analytics(ctx: Context, config: Omit<AnalyticsConfig, "host">) {
  // The account project's edge, with the same public key: analytics tables are
  // separate and the ingest function is granted to the anonymous role. A
  // deployment pins regions with the two URLs; an ordinary build does not
  // expose the choice.
  const upload = {
    url: process.env.TOMRADE_ANALYTICS_URL ?? DEFAULT_SUPABASE_URL,
    key: process.env.TOMRADE_ANALYTICS_KEY ?? DEFAULT_SUPABASE_PUBLISHABLE_KEY,
    endpoint: endpoint(process.env.TOMRADE_ANALYTICS_ENDPOINT),
    cnUrl: process.env.TOMRADE_ANALYTICS_URL_CN,
    globalUrl: process.env.TOMRADE_ANALYTICS_URL_GLOBAL
  };
  ctx.plugin(Analytics, { ...config, client: reportedClient(config.client), host, upload });
}
