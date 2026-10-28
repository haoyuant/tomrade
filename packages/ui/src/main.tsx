import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router.js";
import { subscribe } from "./lib/api.js";
import type {} from "@tomradex/repos";
import type {} from "@tomradex/code-link";
import type {} from "@tomradex/doctor";
import type {} from "@tomradex/files";
import type {} from "@tomradex/notes";
import type {} from "@tomradex/community";
import type {} from "@tomradex/plugin-studio";
import { invalidateContributions, invalidateProject, invalidateWorkspace, keys, sessionsRefresher } from "./lib/queries/index.js";
import { isLeadWindow, watchWindowChrome } from "./lib/window-chrome.js";
import { openSettingsPane } from "./lib/settingsHost.js";
import { letOpenSelectsScroll } from "./lib/select-wheel.js";
import "./styles/app.css";
import "./styles/layouts.css";

// Local SQLite over IPC: refetching on focus buys nothing, invalidation is explicit.
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 30_000 } }
});

// The header's left gutter tracks the traffic lights, which live outside React.
watchWindowChrome();

// A sheet's scroll lock would otherwise swallow the wheel over an open select's list.
letOpenSelectsScroll();

// A plugin loading or unloading changes what the palette, cards and status bar show.
if (window.tomrade) {
  subscribe("account.changed", () => {
    void queryClient.invalidateQueries({ queryKey: keys.account });
    void queryClient.invalidateQueries({ queryKey: keys.settings });
  });
  subscribe("contributions.changed", () => void queryClient.invalidateQueries({ queryKey: keys.contributions }));
  // An agent, or another machine, changed a setting: the theme and language follow at once.
  subscribe("settings.changed", (next) => {
    const before = queryClient.getQueryData<typeof next>(keys.settings);
    queryClient.setQueryData(keys.settings, next);
    // Plugins' words come in the person's language.
    if (before?.language !== next.language) void queryClient.invalidateQueries({ queryKey: keys.contributions });
  });
  // A language pack came or went: Settings → Language lists it, and "system" may now pick it.
  subscribe("settings.languagesChanged", () => {
    void queryClient.invalidateQueries({ queryKey: keys.languages });
    void queryClient.invalidateQueries({ queryKey: keys.contributions });
  });
  // A plugin's desktop surface asked for its section; the shell has already brought the leading window forward.
  subscribe("settings.show", (id) => void (isLeadWindow() && openSettingsPane(id)));
  // Switched from another window, or from the manager in this one.
  subscribe("plugins.changed", () => {
    void queryClient.invalidateQueries({ queryKey: keys.plugins });
    void queryClient.invalidateQueries({ queryKey: keys.studio.root });
  });
  // The store answered: installs, updates, revocations or a submission moved.
  subscribe("community.changed", () => void queryClient.invalidateQueries({ queryKey: keys.community.root }));
  // A workspace in Plugin Studio was created, changed or removed.
  subscribe("studio.changed", () => void queryClient.invalidateQueries({ queryKey: keys.studio.root }));
  // A destination was published to, or its copy replaced this project's rows.
  // An import spares nothing, so neither does this.
  subscribe("storage.changed", (projectId) => invalidateProject(queryClient, projectId));
  // A merge left delivery records to settle, or they were settled.
  subscribe("storage.attentionChanged", (projectId) => void queryClient.invalidateQueries({ queryKey: keys.syncAttention(projectId) }));
  // A project the account names started coming back, moved a step, arrived or stopped to wait.
  subscribe("storage.restoresChanged", () => void queryClient.invalidateQueries({ queryKey: keys.restores }));
  // A project was created, renamed, archived or removed — in this window or another.
  subscribe("projects.changed", () => void queryClient.invalidateQueries({ queryKey: keys.projects }));
  // The Hub folder was chosen or moved, or its remote changed.
  subscribe("hub.changed", () => {
    void queryClient.invalidateQueries({ queryKey: keys.hub });
    void queryClient.invalidateQueries({ queryKey: keys.hubRemote });
  });
  // A repository was added or a checkout named: where a workstream's agent runs may have changed.
  subscribe("repos.changed", () => {
    void queryClient.invalidateQueries({ queryKey: keys.reposAll });
    void queryClient.invalidateQueries({ queryKey: keys.codeLink.root });
    void queryClient.invalidateQueries({ queryKey: keys.agent.workdirAll });
  });
  // A scan found new branches, pull requests or merges: the Code section, the badges and any moved status.
  // A save, a sync or an outside edit moved a project's files or their state.
  subscribe("files.changed", (projectId) => {
    void queryClient.invalidateQueries({ queryKey: keys.files.all(projectId) });
    // A file operation is a record in the history window too.
    void queryClient.invalidateQueries({ queryKey: keys.timeline(projectId) });
  });
  // The notes index caught up with a change: search hits, backlinks and tags may read differently.
  subscribe("notes.changed", (projectId) => void queryClient.invalidateQueries({ queryKey: keys.notes.all(projectId) }));
  // Someone wrote to a project — an agent, MCP, an undo, another view of it: its board catches up at once,
  // so the next edit carries the version that stands rather than being refused as stale.
  subscribe("items.changed", (projectId, entities) => {
    if (entities.some((e) => e !== "item")) invalidateProject(queryClient, projectId);
    else invalidateWorkspace(queryClient, projectId);
  });
  // Code-link writes only its own tables; a ticket it moves comes as items.changed. A session's hook
  // comes as codeLink.sessionsChanged and asks again only for what reads sessions, once per burst of them.
  // Asked again only when a start changed it: hook events do not touch it.
  subscribe("codeLink.startDefaultsChanged", () => void queryClient.invalidateQueries({ queryKey: keys.codeLink.startDefaults }));
  subscribe("codeLink.cellsChanged", (projectId) => void queryClient.invalidateQueries({ queryKey: keys.codeLink.cells(projectId) }));
  subscribe("codeLink.sessionsChanged", sessionsRefresher(queryClient));
  subscribe("codeLink.changed", (projectId) => {
    void queryClient.invalidateQueries({ queryKey: keys.codeLink.all(projectId) });
    // A finished ticket's conversations may have just been archived.
    void queryClient.invalidateQueries({ queryKey: keys.agent.threads(projectId) });
    void queryClient.invalidateQueries({ queryKey: keys.agent.threadAll(projectId) });
    invalidateContributions(queryClient, projectId);
    // Derived fields may read its tables.
    void queryClient.invalidateQueries({ queryKey: keys.items(projectId) });
    // Its exported tables travel with the project.
    void queryClient.invalidateQueries({ queryKey: keys.storageStatus(projectId) });
  });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
);
