/// <reference types="vite/client" />

import type { Invoke, Subscribe } from "@tomradex/ipc";
import type {} from "@tomradex/agent";
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
}

declare module "@tomradex/ipc" {
  interface Broadcasts {
    "window.chrome": (state: WindowChrome) => void;
  }
}

declare global {
  interface Window {
    tomrade: {
      invoke: Invoke;
      on: Subscribe;
      /** The main process never sees the File — only the preload world can resolve its disk path. */
      getPathForFile: (file: File) => string;
    };
  }
}
