import path from "node:path";
import { powerMonitor } from "electron";
import { Context } from "cordis";
import { Dispatch } from "@tomradex/dispatch";

/** The shell says how long nobody has used the machine and whether it runs on battery; the record stays in this machine's own data. */
export default function dispatch(ctx: Context, config: { userData: string }) {
  ctx.plugin(Dispatch, {
    logFile: path.join(config.userData, "dispatch-log.json"),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    onBattery: () => powerMonitor.isOnBatteryPower()
  });
}
