import { Permission } from '@hearer/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { visibleNav } from '../src/lib/nav.ts';
import { METHODS_LOCAL, STATUS_DONE, apiError, meReply, mockApi, renderApp } from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const labels = (permissions: number) => visibleNav(permissions).map((i) => i.label);

describe('permission-filtered navigation', () => {
  it('shows only Home and Search to a user with no permissions', () => {
    expect(labels(0)).toEqual(['Home', 'Search']);
  });

  it('adds Requests and Upload from their permission bits', () => {
    expect(labels(Permission.REQUEST)).toEqual(['Home', 'Search', 'Requests']);
    expect(labels(Permission.UPLOAD)).toEqual(['Home', 'Search', 'Upload']);
    expect(labels(Permission.REQUEST | Permission.UPLOAD)).toEqual([
      'Home',
      'Search',
      'Requests',
      'Upload',
    ]);
  });

  it('shows Admin to managers and to everyone with ADMIN', () => {
    expect(labels(Permission.MANAGE_USERS)).toContain('Admin');
    expect(labels(Permission.MANAGE_SETTINGS)).toContain('Admin');
    expect(labels(Permission.ADMIN)).toEqual(['Home', 'Search', 'Requests', 'Upload', 'Admin']);
  });
});

function signedIn(permissions: number, extra: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({
    'GET /api/v1/setup/status': { json: STATUS_DONE },
    'GET /api/v1/auth/methods': { json: { ...METHODS_LOCAL, appTitle: 'Tunes' } },
    'GET /api/v1/auth/me': meReply(permissions),
    ...extra,
  });
}

describe('layout', () => {
  it('renders the app title and the nav for the signed-in user', async () => {
    signedIn(Permission.REQUEST | Permission.UPLOAD);
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Home', 'Search', 'Requests', 'Upload']);
    expect(
      within(screen.getByRole('navigation', { name: 'Mobile navigation' })).getAllByRole('link'),
    ).toHaveLength(4);
    expect(await screen.findAllByText('Tunes')).not.toHaveLength(0);
  });

  it('hides Admin from a regular user but shows it to an admin', async () => {
    signedIn(Permission.REQUEST);
    const { unmount } = renderApp('/');
    await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
    unmount();
    vi.unstubAllGlobals();
    signedIn(Permission.ADMIN);
    renderApp('/');
    expect(await screen.findAllByRole('link', { name: 'Admin' })).not.toHaveLength(0);
  });

  it('has no dead links: every nav target renders a page', async () => {
    const user = userEvent.setup();
    signedIn(Permission.ADMIN);
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    for (const name of ['Search', 'Requests', 'Upload', 'Admin']) {
      await user.click(within(nav).getByRole('link', { name }));
      expect(await screen.findByRole('heading', { name })).toBeInTheDocument();
      expect(screen.queryByText('Page not found')).not.toBeInTheDocument();
    }
  });

  it('opens the user menu and signs out', async () => {
    const user = userEvent.setup();
    let active = true;
    const { calls } = signedIn(0, {
      'GET /api/v1/auth/me': () => (active ? meReply(0) : apiError(401, 'unauthorized', 'Sign in')),
      'POST /api/v1/auth/logout': () => {
        active = false;
        return { status: 204 };
      },
    });
    const { router } = renderApp('/');
    const buttons = await screen.findAllByRole('button', { name: /Account menu for Alice/ });
    await user.click(buttons[0] as HTMLElement); // eslint-disable-line @typescript-eslint/non-nullable-type-assertion-style
    expect(screen.getByRole('menuitem', { name: /Profile/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /API keys/ })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /Sign out/ }));
    const logout = calls.find((c) => c.path === '/api/v1/auth/logout');
    expect(logout?.headers['x-csrf-token']).toBe('csrf-1');
    await screen.findByLabelText('Username');
    expect(router.state.location.pathname).toBe('/login');
  });

  it('home search navigates to /search?q=', async () => {
    const user = userEvent.setup();
    signedIn(0);
    const { router } = renderApp('/');
    await user.type(
      await screen.findByRole('searchbox', { name: 'Search music' }),
      'ok computer{Enter}',
    );
    expect(await screen.findByRole('heading', { name: 'Search' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/search');
    expect(router.state.location.search).toEqual({ q: 'ok computer' });
  });

  it('sends a 401 from any call back to /login with the current page', async () => {
    signedIn(0, {
      'GET /api/v1/auth/me': () => apiError(401, 'unauthorized', 'Sign in required'),
    });
    const { router } = renderApp('/search?q=x');
    await screen.findByLabelText('Username');
    expect(router.state.location.search).toMatchObject({ returnTo: '/search?q=x' });
  });

  it('shows the 404 page for unknown routes', async () => {
    signedIn(0);
    renderApp('/definitely/not/here');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });

  it('sends a signed-in user to the wizard while setup is incomplete', async () => {
    signedIn(Permission.ADMIN, {
      'GET /api/v1/setup/status': {
        json: { setupComplete: false, hasAdmin: true, steps: { admin: true, directories: true } },
      },
    });
    const { router } = renderApp('/');
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/setup');
    });
  });
});
