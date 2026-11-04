import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { oidcErrorMessage } from '../src/lib/oidcErrors.ts';
import { safeReturnTo } from '../src/lib/returnTo.ts';
import { METHODS_LOCAL, STATUS_DONE, apiError, meReply, mockApi, renderApp } from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const base = {
  'GET /api/v1/setup/status': { json: STATUS_DONE },
  'GET /api/v1/auth/me': apiError(401, 'unauthorized', 'Sign in required'),
};

describe('login page', () => {
  it('shows only the local form when only local sign-in is enabled', async () => {
    mockApi({ ...base, 'GET /api/v1/auth/methods': { json: METHODS_LOCAL } });
    renderApp('/login');
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /sso/i })).not.toBeInTheDocument();
  });

  it('offers a Jellyfin tab and an OIDC button when enabled', async () => {
    const user = userEvent.setup();
    mockApi({
      ...base,
      'GET /api/v1/auth/methods': {
        json: {
          appTitle: 'Tunes',
          local: true,
          jellyfin: true,
          oidc: { enabled: true, buttonLabel: 'Sign in with Keycloak' },
        },
      },
    });
    renderApp('/login?returnTo=%2Fsearch%3Fq%3Dradiohead');
    const oidc = await screen.findByRole('link', { name: 'Sign in with Keycloak' });
    expect(oidc).toHaveAttribute(
      'href',
      '/api/v1/auth/oidc/login?returnTo=%2Fsearch%3Fq%3Dradiohead',
    );
    expect(screen.getByText('Tunes')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Jellyfin' }));
    expect(screen.getByLabelText('Jellyfin username')).toBeInTheDocument();
  });

  it('shows just the SSO button when local and Jellyfin are off', async () => {
    mockApi({
      ...base,
      'GET /api/v1/auth/methods': {
        json: {
          appTitle: 'Hearer',
          local: false,
          jellyfin: false,
          oidc: { enabled: true, buttonLabel: 'Company SSO' },
        },
      },
    });
    renderApp('/login');
    expect(await screen.findByRole('link', { name: 'Company SSO' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
  });

  it('says so when nothing is enabled', async () => {
    mockApi({
      ...base,
      'GET /api/v1/auth/methods': {
        json: { ...METHODS_LOCAL, local: false },
      },
    });
    renderApp('/login');
    expect(await screen.findByText(/No sign-in method is enabled/)).toBeInTheDocument();
  });

  it('validates required fields before calling the API', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ ...base, 'GET /api/v1/auth/methods': { json: METHODS_LOCAL } });
    renderApp('/login');
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter your username.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('signs in, stores the csrf token and lands on the home page', async () => {
    const user = userEvent.setup();
    let signedIn = false;
    const { calls } = mockApi({
      'GET /api/v1/setup/status': { json: STATUS_DONE },
      'GET /api/v1/auth/methods': { json: METHODS_LOCAL },
      'GET /api/v1/auth/me': () =>
        signedIn ? meReply(0) : apiError(401, 'unauthorized', 'Sign in required'),
      'POST /api/v1/auth/login': () => {
        signedIn = true;
        return {
          json: {
            user: meReply(0).json.user,
            permissions: [],
            csrfToken: 'csrf-1',
          },
        };
      },
    });
    renderApp('/login');
    await user.type(await screen.findByLabelText('Username'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/Welcome back, Alice/)).toBeInTheDocument();
    const login = calls.find((c) => c.method === 'POST');
    expect(login?.body).toEqual({ username: 'alice', password: 'correct horse' });
  });

  it('returns to the saved destination after signing in', async () => {
    const user = userEvent.setup();
    let signedIn = false;
    mockApi({
      'GET /api/v1/setup/status': { json: STATUS_DONE },
      'GET /api/v1/auth/methods': { json: METHODS_LOCAL },
      'GET /api/v1/auth/me': () =>
        signedIn ? meReply(0) : apiError(401, 'unauthorized', 'Sign in required'),
      'POST /api/v1/auth/login': () => {
        signedIn = true;
        return { json: { user: meReply(0).json.user, permissions: [], csrfToken: 'c' } };
      },
    });
    const { router } = renderApp('/requests');
    // Not signed in: the guard sends us to /login with the original location.
    await screen.findByLabelText('Username');
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toMatchObject({ returnTo: '/requests' });
    await user.type(screen.getByLabelText('Username'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/requests');
    });
  });

  it('shows the server error for bad credentials and stays on the page', async () => {
    const user = userEvent.setup();
    mockApi({
      ...base,
      'GET /api/v1/auth/methods': { json: METHODS_LOCAL },
      'POST /api/v1/auth/login': apiError(
        401,
        'invalid_credentials',
        'Invalid username or password',
      ),
    });
    const { router } = renderApp('/login');
    await user.type(await screen.findByLabelText('Username'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password');
    expect(router.state.location.pathname).toBe('/login');
  });

  it('posts Jellyfin credentials to /auth/jellyfin', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      ...base,
      'GET /api/v1/auth/methods': { json: { ...METHODS_LOCAL, jellyfin: true } },
      'POST /api/v1/auth/jellyfin': apiError(
        401,
        'invalid_credentials',
        'Invalid username or password',
      ),
    });
    renderApp('/login');
    await user.click(await screen.findByRole('tab', { name: 'Jellyfin' }));
    await user.type(screen.getByLabelText('Jellyfin username'), 'bob');
    await user.type(screen.getByLabelText('Jellyfin password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('alert');
    expect(calls.find((c) => c.method === 'POST')?.path).toBe('/api/v1/auth/jellyfin');
  });

  it('shows friendly messages for OIDC callback errors', async () => {
    mockApi({ ...base, 'GET /api/v1/auth/methods': { json: METHODS_LOCAL } });
    renderApp('/login?error=signup_disabled');
    const alert = await screen.findByText(/cannot be created with single sign-on/i);
    expect(alert).toHaveTextContent(/Ask an administrator/);
  });

  it('redirects to the setup wizard when no admin exists yet', async () => {
    mockApi({
      'GET /api/v1/setup/status': {
        json: { setupComplete: false, hasAdmin: false, steps: { admin: false, directories: true } },
      },
    });
    const { router } = renderApp('/login');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/setup');
    });
  });
});

describe('login helpers', () => {
  it('maps every known OIDC error code and falls back for unknown ones', () => {
    expect(oidcErrorMessage(undefined)).toBeUndefined();
    expect(oidcErrorMessage('state_mismatch')).toMatch(/start again/);
    expect(oidcErrorMessage('something_new')).toBe('Sign-in failed. Please try again.');
  });

  it('only accepts same-site return paths', () => {
    expect(safeReturnTo('/search?q=a')).toBe('/search?q=a');
    expect(safeReturnTo('//evil.example')).toBeUndefined();
    expect(safeReturnTo('https://evil.example')).toBeUndefined();
    expect(safeReturnTo('/\\evil.example')).toBeUndefined();
    expect(safeReturnTo('/login')).toBeUndefined();
    expect(safeReturnTo('/setup')).toBeUndefined();
    expect(safeReturnTo(undefined)).toBeUndefined();
  });
});
