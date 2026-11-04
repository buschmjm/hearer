import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { configureApi, setCsrfToken } from '../src/api/client.ts';
import { ThemeProvider } from '../src/lib/theme.tsx';
import { createAppRouter } from '../src/router.tsx';

export interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; json?: unknown } | Response;
export type Handler = Reply | ((call: RecordedCall) => Reply);

/**
 * A hand-rolled fetch mock. Keys are `METHOD /api/v1/path` (query string ignored). Unmatched
 * requests fail the test loudly instead of hitting the network.
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const call: RecordedCall = {
      method,
      path: url.pathname,
      headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`Unmocked request: ${method} ${url.pathname}`);
    const reply = typeof handler === 'function' ? handler(call) : handler;
    if (reply instanceof Response) return Promise.resolve(reply);
    return Promise.resolve(
      new Response(reply.json === undefined ? null : JSON.stringify(reply.json), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export const apiError = (status: number, code: string, message: string, details?: unknown) => ({
  status,
  json: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});

export const makeUser = (overrides: Record<string, unknown> = {}) => ({
  id: 'u1',
  username: 'alice',
  email: 'alice@example.test',
  displayName: 'Alice',
  avatar: null,
  authType: 'local',
  permissions: 0,
  requestQuotaLimit: null,
  requestQuotaDays: null,
  uploadQuotaMb: null,
  uploadQuotaDays: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
  ...overrides,
});

export const meReply = (permissions: number, csrfToken = 'csrf-1') => ({
  json: {
    user: makeUser({ permissions }),
    permissions: [],
    csrfToken,
    authMethod: 'session',
  },
});

export const STATUS_DONE = {
  setupComplete: true,
  hasAdmin: true,
  steps: { admin: true, directories: true },
};

export const METHODS_LOCAL = {
  appTitle: 'Hearer',
  local: true,
  jellyfin: false,
  oidc: { enabled: false, buttonLabel: 'Sign in with SSO' },
};

/** Mount the real router at `path` with fresh state. */
export function renderApp(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  configureApi({
    onUnauthorized: () => {
      void router.navigate({ to: '/login', search: { returnTo: router.state.location.href } });
    },
    onSetupRequired: () => {
      void router.navigate({ to: '/setup' });
    },
  });
  setCsrfToken(null);
  const view = render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { ...view, router, queryClient };
}
