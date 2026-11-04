import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { meKey } from './api/auth.ts';
import { ApiError, configureApi } from './api/client.ts';
import { ErrorBoundary } from './components/ErrorPages.tsx';
import { ThemeProvider } from './lib/theme.tsx';
import { createAppRouter } from './router.tsx';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});
const router = createAppRouter(queryClient);

// Global answers to "not signed in" and "setup not finished" from any API call.
configureApi({
  onUnauthorized: () => {
    queryClient.setQueryData(meKey, null);
    const { pathname } = router.state.location;
    if (pathname === '/login' || pathname === '/setup') return;
    void router.navigate({ to: '/login', search: { returnTo: router.state.location.href } });
  },
  onSetupRequired: () => {
    if (router.state.location.pathname !== '/setup') void router.navigate({ to: '/setup' });
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
