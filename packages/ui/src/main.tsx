import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router.js";
import { subscribe } from "./lib/api.js";
import { invalidateProject } from "./lib/queries.js";
import { watchWindowChrome } from "./lib/window-chrome.js";
import "./styles/app.css";
import "./styles/layouts.css";

// Local SQLite over IPC: refetching on focus buys nothing, invalidation is explicit.
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 30_000 } }
});

// The header's left gutter tracks the traffic lights, which live outside React.
watchWindowChrome();

// A plugin loading or unloading changes what the palette, cards and status bar show.
if (window.tomrade) {
  subscribe("contributions.changed", () => void queryClient.invalidateQueries({ queryKey: ["contributions"] }));
  // Switched from another window, or from the manager in this one.
  subscribe("plugins.changed", () => void queryClient.invalidateQueries({ queryKey: ["plugins"] }));
  // A destination was published to, or its copy replaced this project's rows.
  // An import spares nothing, so neither does this.
  subscribe("storage.changed", (projectId) => invalidateProject(queryClient, projectId));
  // A project was created, renamed, archived or removed — in this window or another.
  subscribe("projects.changed", () => void queryClient.invalidateQueries({ queryKey: ["projects"] }));
  // The Hub folder was chosen or moved.
  subscribe("hub.changed", () => void queryClient.invalidateQueries({ queryKey: ["hub"] }));
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
);
