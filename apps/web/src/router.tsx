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
import { lazyPage } from './lib/lazyPage.tsx';
import { safeReturnTo } from './lib/returnTo.ts';
import { SEARCH_TYPES } from '@hearer/shared';
import { AlbumPage } from './routes/album.tsx';
import { ArtistPage } from './routes/artist.tsx';
import { HomePage } from './routes/home.tsx';
import { LoginPage } from './routes/login.tsx';
import { requestsSearchSchema, type RequestsSearch } from './lib/requestFilters.ts';
import { SearchPage } from './routes/search.tsx';
import { SetupPage } from './routes/setup.tsx';
import { TrackPage } from './routes/track.tsx';
// H-20: admin, settings, users, jobs and account pages.

/*
 * Routes are declared in code (no generated route tree). To add a page: create a component under
 * src/routes, then add a `createRoute` below with `getParentRoute: () => appRoute` (signed-in
 * area) and list it in `routeTree`. Nav entries live in lib/nav.ts.
 */

/*
 * Pages that most visitors never open (uploads, admin, settings, account, request queue) are
 * loaded on demand so the initial bundle stays small. Search, catalog pages, login and the setup
 * wizard stay in the main chunk.
 */
const RequestDetailPage = lazyPage<{ id: string }>(() =>
  import('./routes/request-detail.tsx').then((m) => m.RequestDetailPage),
);
const RequestsPage = lazyPage<{ search: RequestsSearch }>(() =>
  import('./routes/requests.tsx').then((m) => m.RequestsPage),
);
const UploadPage = lazyPage(() => import('./routes/upload.tsx').then((m) => m.UploadPage));
const UploadsPage = lazyPage(() => import('./routes/uploads.tsx').then((m) => m.UploadsPage));
const UploadBatchPage = lazyPage<{ batchId: string }>(() =>
  import('./routes/uploadBatch.tsx').then((m) => m.UploadBatchPage),
);
const UploadReviewPage = lazyPage<{ id: string }>(() =>
  import('./routes/uploadReview.tsx').then((m) => m.UploadReviewPage),
);
const AdminPage = lazyPage(() => import('./routes/admin.tsx').then((m) => m.AdminPage));
const JobsPage = lazyPage(() => import('./routes/jobs.tsx').then((m) => m.JobsPage));
const UsersPage = lazyPage(() => import('./routes/users.tsx').then((m) => m.UsersPage));
const AccountPage = lazyPage(() => import('./routes/account.tsx').then((m) => m.AccountPage));
const AccountNotificationsPage = lazyPage(() =>
  import('./routes/account.tsx').then((m) => m.AccountNotificationsPage),
);
const ApiKeysPage = lazyPage(() => import('./routes/account.tsx').then((m) => m.ApiKeysPage));
const SettingsLayout = lazyPage(() =>
  import('./routes/settings.tsx').then((m) => m.SettingsLayout),
);
const GeneralSettingsPage = lazyPage(() =>
  import('./routes/settings.tsx').then((m) => m.GeneralSettingsPage),
);
const AuthSettingsPage = lazyPage(() =>
  import('./routes/settings.tsx').then((m) => m.AuthSettingsPage),
);
const MediaServerSettingsPage = lazyPage(() =>
  import('./routes/settings.tsx').then((m) => m.MediaServerSettingsPage),
);
const LibrarySettingsPage = lazyPage(() =>
  import('./routes/settings.tsx').then((m) => m.LibrarySettingsPage),
);
const MetadataSettingsPage = lazyPage(() =>
  import('./routes/settings.tsx').then((m) => m.MetadataSettingsPage),
);
const FulfillmentSettingsPage = lazyPage(() =>
  import('./routes/settings.tsx').then((m) => m.FulfillmentSettingsPage),
);
const NotificationsSettingsPage = lazyPage(() =>
  import('./routes/settings.tsx').then((m) => m.NotificationsSettingsPage),
);

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
  validateSearch: requestsSearchSchema,
  component: function Requests() {
    return <RequestsPage search={requestsRoute.useSearch()} />;
  },
});
const requestDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/requests/$id',
  component: function RequestDetail() {
    return <RequestDetailPage id={requestDetailRoute.useParams().id} />;
  },
});
const uploadRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/upload',
  component: UploadPage,
});
// --- H-19 uploads routes ---
const uploadsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/uploads',
  component: UploadsPage,
});
const uploadBatchRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/uploads/batch/$batchId',
  component: function UploadBatch() {
    return <UploadBatchPage batchId={uploadBatchRoute.useParams().batchId} />;
  },
});
const uploadReviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/uploads/$id',
  component: function UploadReview() {
    return <UploadReviewPage id={uploadReviewRoute.useParams().id} />;
  },
});
// --- end H-19 uploads routes ---
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
    artistRoute,
    albumRoute,
    trackRoute,
    requestsRoute,
    requestDetailRoute,
    uploadRoute,
    // H-19
    uploadsRoute,
    uploadBatchRoute,
    uploadReviewRoute,
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
