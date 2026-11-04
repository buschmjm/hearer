/* eslint-disable @typescript-eslint/only-throw-error -- TanStack Router's redirect() is thrown by design */
import type { QueryClient } from '@tanstack/react-query';
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { z } from 'zod';
import { meQuery } from './api/auth.ts';
import { ensureSetupStatus } from './api/setup.ts';
import { ErrorFallback, NotFound } from './components/ErrorPages.tsx';
import { Layout } from './components/Layout.tsx';
import { safeReturnTo } from './lib/returnTo.ts';
import { HomePage } from './routes/home.tsx';
import { LoginPage } from './routes/login.tsx';
import { SetupPage } from './routes/setup.tsx';
import { RequestsPage, SearchPage, UploadPage } from './routes/stubs.tsx';
// H-20: admin, settings, users, jobs and account pages.
import { AccountNotificationsPage, AccountPage, ApiKeysPage } from './routes/account.tsx';
import { AdminPage } from './routes/admin.tsx';
import { JobsPage } from './routes/jobs.tsx';
import {
  AuthSettingsPage,
  FulfillmentSettingsPage,
  GeneralSettingsPage,
  LibrarySettingsPage,
  MediaServerSettingsPage,
  MetadataSettingsPage,
  NotificationsSettingsPage,
  SettingsLayout,
} from './routes/settings.tsx';
import { UsersPage } from './routes/users.tsx';

/*
 * Routes are declared in code (no generated route tree). To add a page: create a component under
 * src/routes, then add a `createRoute` below with `getParentRoute: () => appRoute` (signed-in
 * area) and list it in `routeTree`. Nav entries live in lib/nav.ts.
 */

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: ({ error, reset }) => <ErrorFallback error={error} reset={reset} />,
});

const loginSearch = z.object({
  returnTo: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: loginSearch,
  beforeLoad: async ({ context: { queryClient }, search }) => {
    const status = await ensureSetupStatus(queryClient);
    if (!status.hasAdmin) throw redirect({ to: '/setup' });
    const me = await queryClient.query(meQuery());
    if (me) throw redirect({ to: safeReturnTo(search.returnTo) ?? '/' });
  },
  component: function Login() {
    const { returnTo, error } = loginRoute.useSearch();
    return <LoginPage returnTo={returnTo} error={error} />;
  },
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  beforeLoad: async ({ context: { queryClient } }) => {
    const status = await ensureSetupStatus(queryClient);
    if (status.setupComplete) throw redirect({ to: '/' });
  },
  component: SetupPage,
});

/** Everything below requires a session, and setup to be finished. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context: { queryClient }, location }) => {
    const me = await queryClient.query(meQuery());
    const status = await ensureSetupStatus(queryClient);
    if (!status.setupComplete) throw redirect({ to: '/setup' });
    if (!me) {
      throw redirect({ to: '/login', search: { returnTo: safeReturnTo(location.href) } });
    }
  },
  component: Layout,
});

const indexRoute = createRoute({ getParentRoute: () => appRoute, path: '/', component: HomePage });

const searchRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/search',
  validateSearch: z.object({ q: z.string().optional().catch(undefined) }),
  component: SearchPage,
});
const requestsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/requests',
  component: RequestsPage,
});
const uploadRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/upload',
  component: UploadPage,
});
const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin',
  component: AdminPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/settings',
  component: SettingsLayout,
});
const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/admin/settings/general' });
  },
});
const settingsTab = <P extends string>(path: P, component: () => React.JSX.Element) =>
  createRoute({ getParentRoute: () => settingsRoute, path, component });
const settingsGeneralRoute = settingsTab('/general', GeneralSettingsPage);
const settingsAuthRoute = settingsTab('/auth', AuthSettingsPage);
const settingsMediaRoute = settingsTab('/media-server', MediaServerSettingsPage);
const settingsLibraryRoute = settingsTab('/library', LibrarySettingsPage);
const settingsMetadataRoute = settingsTab('/metadata', MetadataSettingsPage);
const settingsFulfillmentRoute = settingsTab('/fulfillment', FulfillmentSettingsPage);
const settingsNotificationsRoute = settingsTab('/notifications', NotificationsSettingsPage);
const usersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/users',
  component: UsersPage,
});
const jobsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/jobs',
  component: JobsPage,
});
const accountRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/account',
  component: AccountPage,
});
const accountNotificationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/account/notifications',
  component: AccountNotificationsPage,
});
const apiKeysRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/account/api-keys',
  component: ApiKeysPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  setupRoute,
  appRoute.addChildren([
    indexRoute,
    searchRoute,
    requestsRoute,
    uploadRoute,
    adminRoute,
    settingsRoute.addChildren([
      settingsIndexRoute,
      settingsGeneralRoute,
      settingsAuthRoute,
      settingsMediaRoute,
      settingsLibraryRoute,
      settingsMetadataRoute,
      settingsFulfillmentRoute,
      settingsNotificationsRoute,
    ]),
    usersRoute,
    jobsRoute,
    accountRoute,
    accountNotificationsRoute,
    apiKeysRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    defaultNotFoundComponent: NotFound,
    ...(history ? { history } : {}),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
