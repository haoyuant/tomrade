import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router.js";
import { subscribe } from "./lib/api.js";
import type {} from "@tomrade/repos";
import type {} from "@tomrade/code-link";
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
  subscribe("account.changed", () => {
    void queryClient.invalidateQueries({ queryKey: ["account"] });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
  });
  subscribe("contributions.changed", () => void queryClient.invalidateQueries({ queryKey: ["contributions"] }));
  // Switched from another window, or from the manager in this one.
  subscribe("plugins.changed", () => void queryClient.invalidateQueries({ queryKey: ["plugins"] }));
  // A destination was published to, or its copy replaced this project's rows.
  // An import spares nothing, so neither does this.
  subscribe("storage.changed", (projectId) => invalidateProject(queryClient, projectId));
  // A project was created, renamed, archived or removed — in this window or another.
  subscribe("projects.changed", () => void queryClient.invalidateQueries({ queryKey: ["projects"] }));
  // The Hub folder was chosen or moved, or its remote changed.
  subscribe("hub.changed", () => {
    void queryClient.invalidateQueries({ queryKey: ["hub"] });
    void queryClient.invalidateQueries({ queryKey: ["storage", "hub"] });
  });
  // A repository was added or a checkout named: where a workstream's agent runs may have changed.
  subscribe("repos.changed", () => {
    void queryClient.invalidateQueries({ queryKey: ["repos"] });
    void queryClient.invalidateQueries({ queryKey: ["codeLink"] });
    void queryClient.invalidateQueries({ queryKey: ["agent", "workdir"] });
  });
  // A scan found new branches, pull requests or merges: the Code section, the badges and any moved status.
  subscribe("codeLink.changed", (projectId) => {
    void queryClient.invalidateQueries({ queryKey: ["codeLink", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["contributions"] });
    invalidateProject(queryClient, projectId);
  });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
);
