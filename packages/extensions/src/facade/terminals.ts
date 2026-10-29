import type { TerminalsApi } from "@tomradex/plugin-sdk";
import type { Facade } from "./shared.js";

export const terminalsApi = ({ host }: Facade): TerminalsApi => {
  const herdr = () => host.svc("terminals");
  return {
    state: () =>
      host.call(async () => {
        const bridge = await herdr().bridge();
        // The SDK has no word for a host this app may not open: to a plugin it does not answer.
        return bridge.state === "forbidden" ? { state: "notRunning", version: (await herdr().installed()) ?? "0" } : bridge;
      }),
    open: (paneId, opts) =>
      host.call(async () => {
        const stream = await herdr().terminal(String(paneId), { mode: opts.mode === "observe" ? "observe" : "control", cols: Number(opts.cols), rows: Number(opts.rows) });
        // One the plugin leaves open goes with it.
        const release = host.ctx.effect(() => () => stream.close(), `terminal ${stream.paneId}`);
        stream.onClose(() => release());
        const label = `terminal ${stream.paneId}`;
        return {
          paneId: stream.paneId,
          mode: stream.mode,
          onFrame: (listener) => host.disposerOf(stream.onFrame(host.listen(listener, `${label} frame`))),
          onClose: (listener) => host.disposerOf(stream.onClose(host.listen(listener, `${label} close`))),
          input: (data) => stream.input(data),
          resize: (cols, rows) => stream.resize(cols, rows),
          scroll: (scroll) => stream.scroll(scroll),
          mouse: (mouse) => stream.mouse(mouse),
          close: () => stream.close()
        };
      })
  };
};
