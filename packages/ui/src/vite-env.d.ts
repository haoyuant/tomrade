/// <reference types="vite/client" />

import type { Invoke, Subscribe } from "@tomrade/ipc";
import type {} from "@tomrade/assistant";
import type {} from "@tomrade/boards";
import type {} from "@tomrade/contributions";
import type {} from "@tomrade/db";
import type {} from "@tomrade/items";
import type {} from "@tomrade/mcp";
import type {} from "@tomrade/oplog";
import type {} from "@tomrade/projects";
import type {} from "@tomrade/settings";

export interface WindowChrome {
  /** macOS draws the traffic lights over the header while windowed. */
  trafficLights: boolean;
}

declare module "@tomrade/ipc" {
  interface Broadcasts {
    "window.chrome": (state: WindowChrome) => void;
  }
}

declare global {
  interface Window {
    tomrade: {
      invoke: Invoke;
      on: Subscribe;
    };
  }
}
