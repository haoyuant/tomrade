import { createHashHistory, createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { IconSprite } from "~/components/icons";
import { ProjectShell } from "~/components/chrome/ProjectShell";
import { IssueScreen } from "~/components/issue/IssueScreen";
import { ProjectsScreen } from "~/components/projects/ProjectsScreen";
import { Workspace } from "~/components/workspace/Workspace";
import { WorkspaceProvider } from "~/components/workspace/context";
import { invoke } from "~/lib/api";
import { I18nProvider } from "~/lib/i18n";
import { ThemeProvider } from "~/lib/theme";
import { ToastProvider } from "~/lib/toast";
import { AccountGate } from "~/components/dialogs/AccountPanel";

const rootRoute = createRootRoute({
  component: () => (
    <I18nProvider>
      <ThemeProvider>
        <ToastProvider>
          <IconSprite />
          <AccountGate><Outlet /></AccountGate>
        </ToastProvider>
      </ThemeProvider>
    </I18nProvider>
  )
});

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: ProjectsScreen });

/** Everything inside a project shares one shell — the assistant panel mounts once, above the screens. */
const projectShellRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$projectId",
  component: ProjectShell
});

/** Opening a project resolves to its first saved view. */
const projectIndexRoute = createRoute({
  getParentRoute: () => projectShellRoute,
  path: "/",
  loader: async ({ params }) => {
    const views = await invoke("views.list", params.projectId);
    const view = [...views].sort((a, b) => a.rank - b.rank)[0];
    if (!view) throw redirect({ to: "/" });
    throw redirect({ to: "/p/$projectId/v/$viewId", params: { projectId: params.projectId, viewId: view.id } });
  }
});

const viewRoute = createRoute({
  getParentRoute: () => projectShellRoute,
  path: "v/$viewId",
  component: function ViewRoute() {
    const { projectId, viewId } = viewRoute.useParams();
    return (
      <WorkspaceProvider projectId={projectId} viewId={viewId}>
        {() => <Workspace />}
      </WorkspaceProvider>
    );
  }
});

/** A workstream's page: an unsaved board pinned to it. Saving makes a view. */
const workstreamRoute = createRoute({
  getParentRoute: () => projectShellRoute,
  path: "w/$boardId",
  component: function WorkstreamRoute() {
    const { projectId, boardId } = workstreamRoute.useParams();
    return (
      <WorkspaceProvider projectId={projectId} boardId={boardId}>
        {() => <Workspace />}
      </WorkspaceProvider>
    );
  }
});

const issueRoute = createRoute({
  getParentRoute: () => projectShellRoute,
  path: "i/$itemId",
  component: function IssueRoute() {
    const { projectId, itemId } = issueRoute.useParams();
    return <IssueScreen projectId={projectId} itemId={itemId} />;
  }
});

const routeTree = rootRoute.addChildren([indexRoute, projectShellRoute.addChildren([projectIndexRoute, viewRoute, workstreamRoute, issueRoute])]);

// Hash history: the production build is loaded from file://, where a path-based
// history has nothing to resolve a reload against.
export const router = createRouter({ routeTree, history: createHashHistory() });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
