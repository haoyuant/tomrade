import type { LayoutLook, LayoutModule } from "@tomradex/plugin-sdk";
import { awaitConnect, clientApi } from "./client";
import type { FrameMessage } from "./protocol";

/**
 * The page a sandboxed layout runs in. It has no origin of its own and nothing
 * of Tomrade's: it waits for the window's port, wears the look it is told,
 * imports the plugin's module and mounts it on the root element.
 */

const wear = (look: LayoutLook): void => {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(look.tokens)) root.style.setProperty(name, value);
  root.classList.toggle("dark", look.dark);
  root.lang = look.locale;
};

async function main(): Promise<void> {
  const { port, module, state } = await awaitConnect(window);
  const say = (message: FrameMessage) => port.postMessage(message);
  wear(state.look);
  const api = clientApi(port, state);
  api.onChange((next, changed) => {
    if (changed.has("look")) wear(next.look);
  });
  try {
    const mod = (await import(/* @vite-ignore */ module)) as { default?: LayoutModule };
    if (typeof mod.default?.mount !== "function") throw new Error("the module's default export has no mount()");
    await mod.default.mount(document.getElementById("root")!, api);
    say({ type: "ready" });
  } catch (error) {
    say({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

void main();
