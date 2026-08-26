import { createHashHistory, createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { IconSprite } from "~/components/icons";
import { IssueScreen } from "~/components/issue/IssueScreen";
import { ProjectsScreen } from "~/components/projects/ProjectsScreen";
import { Workspace } from "~/components/workspace/Workspace";
import { WorkspaceProvider } from "~/components/workspace/context";
import { ThemeProvider } from "~/lib/theme";
import { ToastProvider } from "~/lib/toast";

const rootRoute = createRootRoute({
  component: () => (
    <ThemeProvider>
      <ToastProvider>
        <IconSprite />
        <Outlet />
      </ToastProvider>
    </ThemeProvider>
  )
});

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: ProjectsScreen });

/** Opening a project resolves to its first board and that board's first view. */
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$projectId",
  loader: async ({ params }) => {
    const boards = await window.tomrade.boardsList(params.projectId);
    const board = boards.find((b) => !b.across) ?? boards[0];
    if (!board) throw redirect({ to: "/" });
    const views = await window.tomrade.viewsList(params.projectId);
    const view = views.filter((v) => v.boardId === board.id).sort((a, b) => a.rank - b.rank)[0];
    if (!view) throw redirect({ to: "/" });
    throw redirect({ to: "/p/$projectId/b/$boardId/v/$viewId", params: { projectId: params.projectId, boardId: board.id, viewId: view.id } });
  }
});

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$projectId/b/$boardId/v/$viewId",
  component: function BoardRoute() {
    const { projectId, boardId, viewId } = boardRoute.useParams();
    return (
      <WorkspaceProvider projectId={projectId} boardId={boardId} viewId={viewId}>
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

const routeTree = rootRoute.addChildren([indexRoute, projectRoute, boardRoute, issueRoute]);

// Hash history: the production build is loaded from file://, where a path-based
// history has nothing to resolve a reload against.
export const router = createRouter({ routeTree, history: createHashHistory() });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
