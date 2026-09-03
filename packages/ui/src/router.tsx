import { createHashHistory, createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { IconSprite } from "~/components/icons";
import { IssueScreen } from "~/components/issue/IssueScreen";
import { ProjectsScreen } from "~/components/projects/ProjectsScreen";
import { Workspace } from "~/components/workspace/Workspace";
import { WorkspaceProvider } from "~/components/workspace/context";
import { invoke } from "~/lib/api";
import { I18nProvider } from "~/lib/i18n";
import { ThemeProvider } from "~/lib/theme";
import { ToastProvider } from "~/lib/toast";

const rootRoute = createRootRoute({
  component: () => (
    <I18nProvider>
      <ThemeProvider>
        <ToastProvider>
          <IconSprite />
          <Outlet />
        </ToastProvider>
      </ThemeProvider>
    </I18nProvider>
  )
});

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: ProjectsScreen });

/** Opening a project resolves to its first saved view. */
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$projectId",
  loader: async ({ params }) => {
    const views = await invoke("views.list", params.projectId);
    const view = [...views].sort((a, b) => a.rank - b.rank)[0];
    if (!view) throw redirect({ to: "/" });
    throw redirect({ to: "/p/$projectId/v/$viewId", params: { projectId: params.projectId, viewId: view.id } });
  }
});

const viewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$projectId/v/$viewId",
  component: function ViewRoute() {
    const { projectId, viewId } = viewRoute.useParams();
    return (
      <WorkspaceProvider projectId={projectId} viewId={viewId}>
        {() => <Workspace />}
      </WorkspaceProvider>
    );
  }
});

const issueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$projectId/i/$itemId",
  component: function IssueRoute() {
    const { projectId, itemId } = issueRoute.useParams();
    return <IssueScreen projectId={projectId} itemId={itemId} />;
  }
});

const routeTree = rootRoute.addChildren([indexRoute, projectRoute, viewRoute, issueRoute]);

// Hash history: the production build is loaded from file://, where a path-based
// history has nothing to resolve a reload against.
export const router = createRouter({ routeTree, history: createHashHistory() });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
