import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { setCsrfToken } from '../src/api/client.ts';
import { ToastProvider } from '../src/components/Toast.tsx';
import { ThemeProvider } from '../src/lib/theme.tsx';
import { STATUS_DONE, METHODS_LOCAL, meReply, mockApi } from './helpers.tsx';

/**
 * Mount one component inside a minimal router (so Links work), query client and toasts,
 * signed in with `permissions`. Extra routes can be mocked via `routes`.
 */
export async function renderWithProviders(
  ui: ReactNode,
  permissions: number,
  routes: Parameters<typeof mockApi>[0] = {},
) {
  mockApi({
    'GET /api/v1/setup/status': { json: STATUS_DONE },
    'GET /api/v1/auth/methods': { json: METHODS_LOCAL },
    'GET /api/v1/auth/me': meReply(permissions),
    ...routes,
  });
  setCsrfToken('csrf-1');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seed the session so permission checks are synchronous on first render.
  queryClient.setQueryData(['auth', 'me'], meReply(permissions).json);
  const root = createRootRoute({ component: () => <>{ui}</> });
  const catchAll = createRoute({ getParentRoute: () => root, path: '$', component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([catchAll]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  const view = render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { ...view, queryClient };
}
