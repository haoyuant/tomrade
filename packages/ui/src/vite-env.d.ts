/// <reference types="vite/client" />

import type { Invoke, Subscribe } from "@tomradex/ipc";
import type {} from "@tomradex/agent";
import type {} from "@tomradex/analytics";
import type {} from "@tomradex/boards";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/db";
import type {} from "@tomradex/items";
import type {} from "@tomradex/mcp";
import type {} from "@tomradex/onboarding";
import type {} from "@tomradex/oplog";
import type {} from "@tomradex/projects";
import type {} from "@tomradex/settings";

export interface WindowChrome {
  /** macOS draws the traffic lights over the header while windowed. */
  trafficLights: boolean;
  /** App-wide prompts land in this window; the shell brings it forward. Absent from an older shell. */
  lead?: boolean;
  /** The window wears the system's frosted material (Glass on macOS and Windows 11): the page leaves its own background off. */
  frosted?: boolean;
}

declare module "@tomradex/ipc" {
  interface Broadcasts {
    "window.chrome": (state: WindowChrome) => void;
    /** The system woke, the screen unlocked or the window came back from minimized. */
    "window.wake": () => void;
  }
}

declare global {
  interface Window {
    tomrade: {
      invoke: Invoke;
      on: Subscribe;
      /** The main process never sees the File — only the preload world can resolve its disk path. */
      getPathForFile: (file: File) => string;
      /** How the shell opened this window; absent outside it. */
      window?: { detached: boolean };
    };
  }
}
