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
import { SEARCH_TYPES } from '@hearer/shared';
import { AlbumPage } from './routes/album.tsx';
import { ArtistPage } from './routes/artist.tsx';
import { HomePage } from './routes/home.tsx';
import { LoginPage } from './routes/login.tsx';
import { SearchPage } from './routes/search.tsx';
import { SetupPage } from './routes/setup.tsx';
import { AccountPage, AdminPage, ApiKeysPage, RequestsPage, UploadPage } from './routes/stubs.tsx';
import { TrackPage } from './routes/track.tsx';

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
  validateSearch: z.object({
    q: z.string().optional().catch(undefined),
    type: z.enum(SEARCH_TYPES).optional().catch(undefined),
  }),
  component: function Search() {
    const { q, type } = searchRoute.useSearch();
    return <SearchPage q={q} type={type ?? 'album'} />;
  },
});
const artistRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/artists/$mbid',
  component: function Artist() {
    return <ArtistPage mbid={artistRoute.useParams().mbid} />;
  },
});
const albumRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/albums/$mbid',
  component: function Album() {
    return <AlbumPage mbid={albumRoute.useParams().mbid} />;
  },
});
const trackRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/tracks/$mbid',
  component: function Track() {
    return <TrackPage mbid={trackRoute.useParams().mbid} />;
  },
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
const accountRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/account',
  component: AccountPage,
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
    artistRoute,
    albumRoute,
    trackRoute,
    requestsRoute,
    uploadRoute,
    adminRoute,
    accountRoute,
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
