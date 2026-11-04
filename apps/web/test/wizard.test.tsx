import { DEFAULT_NAMING_TEMPLATE, DEFAULT_SINGLES_TEMPLATE, Permission } from '@hearer/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { METHODS_LOCAL, apiError, meReply, mockApi, renderApp, type Handler } from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const dir = (path: string, writable = true) => ({
  path,
  exists: writable,
  writable,
  ...(writable ? {} : { error: 'Not writable (EACCES)' }),
});

const status = (over: Record<string, unknown> = {}, library = true) => ({
  json: {
    setupComplete: false,
    hasAdmin: true,
    steps: { admin: true, directories: library },
    directories: { library: dir('/music', library), staging: dir('/staging') },
    ...over,
  },
});

const GENERAL = {
  appTitle: 'Hearer',
  applicationUrl: '',
  setupComplete: false,
  defaultPermissions: Permission.REQUEST | Permission.UPLOAD,
  defaultRequestQuota: { limit: 0, days: 7 },
  defaultUploadQuota: { mb: 0, days: 7 },
};
const MEDIA = { type: 'jellyfin', url: '', externalUrl: '', apiKey: '', serverId: '' };
const LIBRARY = {
  namingTemplate: DEFAULT_NAMING_TEMPLATE,
  singlesTemplate: DEFAULT_SINGLES_TEMPLATE,
};
const UPLOADS = {
  maxFileSizeMb: 2048,
  allowedFormats: ['flac'],
  autoApproveThreshold: 0.9,
  coverMaxPx: 1200,
};

/** Admin exists and is signed in; every section GET/PUT is mocked. */
function wizard(extra: Record<string, Handler> = {}) {
  return mockApi({
    'GET /api/v1/auth/methods': { json: METHODS_LOCAL },
    'GET /api/v1/setup/status': status(),
    'GET /api/v1/auth/me': meReply(Permission.ADMIN),
    'GET /api/v1/setup/general': { json: GENERAL },
    'GET /api/v1/setup/mediaServer': { json: MEDIA },
    'GET /api/v1/setup/library': { json: LIBRARY },
    'GET /api/v1/setup/uploads': { json: UPLOADS },
    'PUT /api/v1/setup/general': (c) => ({ json: c.body }),
    'PUT /api/v1/setup/mediaServer': (c) => ({ json: c.body }),
    'PUT /api/v1/setup/library': (c) => ({ json: c.body }),
    'PUT /api/v1/setup/uploads': (c) => ({ json: c.body }),
    ...extra,
  });
}

describe('setup wizard: admin step', () => {
  const noAdmin = {
    'GET /api/v1/setup/status': {
      json: { setupComplete: false, hasAdmin: false, steps: { admin: false, directories: true } },
    },
    'GET /api/v1/auth/me': apiError(401, 'unauthorized', 'Sign in'),
  };

  it('starts at step 1 when there is no admin and validates the form', async () => {
    const user = userEvent.setup();
    const { calls } = wizard(noAdmin);
    renderApp('/setup');
    expect(await screen.findByText('Create the administrator')).toBeInTheDocument();
    expect(screen.getByText(/Step 1 of 5/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Create account/ }));
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'longenough1');
    await user.type(screen.getByLabelText('Confirm password'), 'different');
    await user.click(screen.getByRole('button', { name: /Create account/ }));
    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('creates the admin and moves on to General', async () => {
    const user = userEvent.setup();
    let created = false;
    const { calls } = wizard({
      ...noAdmin,
      'GET /api/v1/setup/status': () =>
        created
          ? status()
          : {
              json: {
                setupComplete: false,
                hasAdmin: false,
                steps: { admin: false, directories: true },
              },
            },
      'GET /api/v1/auth/me': () =>
        created ? meReply(Permission.ADMIN) : apiError(401, 'unauthorized', 'Sign in'),
      'POST /api/v1/setup/admin': () => {
        created = true;
        return {
          status: 201,
          json: {
            user: meReply(Permission.ADMIN).json.user,
            permissions: ['ADMIN'],
            csrfToken: 'csrf-1',
          },
        };
      },
    });
    renderApp('/setup');
    await user.type(await screen.findByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'longenough1');
    await user.type(screen.getByLabelText('Confirm password'), 'longenough1');
    await user.click(screen.getByRole('button', { name: /Create account/ }));
    expect(await screen.findByLabelText('Application title')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/v1/setup/admin')?.body).toEqual({
      username: 'admin',
      password: 'longenough1',
    });
  });

  it('shows the server error inline (admin already exists)', async () => {
    const user = userEvent.setup();
    wizard({
      ...noAdmin,
      'POST /api/v1/setup/admin': apiError(
        409,
        'setup_admin_exists',
        'An administrator already exists',
      ),
    });
    renderApp('/setup');
    await user.type(await screen.findByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'longenough1');
    await user.type(screen.getByLabelText('Confirm password'), 'longenough1');
    await user.click(screen.getByRole('button', { name: /Create account/ }));
    expect(await screen.findByText('An administrator already exists')).toBeInTheDocument();
  });
});

describe('setup wizard: resuming', () => {
  it('resumes at General when the admin exists and is signed in', async () => {
    wizard();
    renderApp('/setup');
    expect(await screen.findByLabelText('Application title')).toHaveValue('Hearer');
    expect(screen.getByText(/Step 2 of 5/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });

  it('asks the admin to sign in when there is no session', async () => {
    wizard({ 'GET /api/v1/auth/me': apiError(401, 'unauthorized', 'Sign in') });
    renderApp('/setup');
    expect(await screen.findByText('Sign in to continue setup')).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
  });

  it('bounces to the app once setup is complete', async () => {
    wizard({
      'GET /api/v1/setup/status': {
        json: { setupComplete: true, hasAdmin: true, steps: { admin: true, directories: true } },
      },
    });
    const { router } = renderApp('/setup');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
  });
});

describe('setup wizard: steps', () => {
  it('validates General, then saves merged values', async () => {
    const user = userEvent.setup();
    const { calls } = wizard();
    renderApp('/setup');
    const title = await screen.findByLabelText('Application title');
    await user.clear(title);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    await user.type(title, 'My Music');
    await user.type(screen.getByLabelText(/Application URL/), 'not a url');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
    await user.clear(screen.getByLabelText(/Application URL/));
    await user.type(screen.getByLabelText(/Application URL/), 'https://music.example.com');
    await user.click(screen.getByRole('checkbox', { name: /Request artists/ }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByLabelText('Jellyfin URL')).toBeInTheDocument();
    const put = calls.find((c) => c.method === 'PUT' && c.path.endsWith('/general'));
    expect(put?.headers['x-csrf-token']).toBe('csrf-1');
    expect(put?.body).toMatchObject({
      appTitle: 'My Music',
      applicationUrl: 'https://music.example.com',
      defaultPermissions: Permission.REQUEST | Permission.UPLOAD | Permission.REQUEST_ARTIST,
      defaultRequestQuota: { limit: 0, days: 7 },
      setupComplete: false,
    });
  });

  async function toMedia(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByLabelText('Jellyfin URL');
  }

  it('tests the Jellyfin connection and reports success and failure', async () => {
    const user = userEvent.setup();
    let ok = false;
    const { calls } = wizard({
      'POST /api/v1/settings/mediaServer/test': () =>
        ok
          ? {
              json: {
                ok: true,
                server: { id: 's1', name: 'Home', version: '10.11.0', versionSupported: true },
              },
            }
          : {
              json: {
                ok: false,
                error: { code: 'media_server_unreachable', message: 'Could not reach the server' },
              },
            },
    });
    renderApp('/setup');
    await toMedia(user);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Enter an API key/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Jellyfin URL'), 'http://jellyfin:8096');
    await user.type(screen.getByLabelText('API key'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Could not reach the server')).toBeInTheDocument();
    ok = true;
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Connected to Home/)).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith('/mediaServer/test'))).toHaveLength(2);
    expect(calls.at(-1)?.body).toEqual({ url: 'http://jellyfin:8096', apiKey: 'abc' });
  });

  it('shows the server rejection when saving the media server and can skip it', async () => {
    const user = userEvent.setup();
    wizard({
      'PUT /api/v1/setup/mediaServer': apiError(
        400,
        'media_server_test_failed',
        'Could not connect to the media server: bad key',
      ),
    });
    renderApp('/setup');
    await toMedia(user);
    await user.type(screen.getByLabelText('Jellyfin URL'), 'http://jellyfin:8096');
    await user.type(screen.getByLabelText('API key'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText(/bad key/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByLabelText('Naming template')).toBeInTheDocument();
  });

  it('goes back a step', async () => {
    const user = userEvent.setup();
    wizard();
    renderApp('/setup');
    await toMedia(user);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByLabelText('Application title')).toBeInTheDocument();
  });

  async function toLibrary(user: ReturnType<typeof userEvent.setup>) {
    await toMedia(user);
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await screen.findByLabelText('Naming template');
  }

  it('shows folder status, a live preview, and validates the template', async () => {
    const user = userEvent.setup();
    const { calls } = wizard();
    renderApp('/setup');
    await toLibrary(user);
    expect(await screen.findByText('/music')).toBeInTheDocument();
    expect(screen.getByText('/staging')).toBeInTheDocument();
    expect(screen.getByTestId('template-preview')).toHaveTextContent(
      'Radiohead/OK Computer (1997)/02 - Paranoid Android.flac',
    );
    const field = screen.getByLabelText('Naming template');
    await user.clear(field);
    await user.type(field, '{{album}/{{title}.{{ext}');
    expect(screen.getByTestId('template-preview')).toHaveTextContent(
      'OK Computer/Paranoid Android.flac',
    );

    await user.clear(field);
    await user.type(field, '{{bogus}/{{title}.{{ext}');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Unknown variable {bogus}')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT' && c.path.endsWith('/library'))).toBe(false);

    await user.clear(field);
    await user.type(field, '{{album}/{{title}.{{ext}');
    const size = screen.getByLabelText('Maximum upload size (MB)');
    await user.clear(size);
    await user.type(size, '0');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/whole number of megabytes/)).toBeInTheDocument();
    await user.clear(size);
    await user.type(size, '512');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Review and finish')).toBeInTheDocument();
    expect(
      calls.find((c) => c.method === 'PUT' && c.path.endsWith('/library'))?.body,
    ).toMatchObject({
      namingTemplate: '{album}/{title}.{ext}',
    });
    expect(
      calls.find((c) => c.method === 'PUT' && c.path.endsWith('/uploads'))?.body,
    ).toMatchObject({
      maxFileSizeMb: 512,
      coverMaxPx: 1200,
    });
  });

  it('blocks Continue while a folder is not writable', async () => {
    const user = userEvent.setup();
    wizard({ 'GET /api/v1/setup/status': status({}, false) });
    renderApp('/setup');
    await toLibrary(user);
    expect(await screen.findByText('Not writable (EACCES)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('finishes: review summary, complete, then lands on the home page', async () => {
    const user = userEvent.setup();
    let done = false;
    const { calls } = wizard({
      'GET /api/v1/setup/status': () =>
        done
          ? {
              json: {
                setupComplete: true,
                hasAdmin: true,
                steps: { admin: true, directories: true },
              },
            }
          : status(),
      'POST /api/v1/setup/complete': () => {
        done = true;
        return {
          json: { setupComplete: true, hasAdmin: true, steps: { admin: true, directories: true } },
        };
      },
    });
    const { router } = renderApp('/setup');
    await toLibrary(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Review and finish');
    expect(screen.getByText('Not configured (you can add it later)')).toBeInTheDocument();
    expect(screen.getByText('/music')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    expect(calls.some((c) => c.path.endsWith('/setup/complete') && c.method === 'POST')).toBe(true);
    expect(await screen.findByText(/Welcome back/)).toBeInTheDocument();
  });

  it('shows the server error when completing fails', async () => {
    const user = userEvent.setup();
    wizard({
      'POST /api/v1/setup/complete': apiError(
        400,
        'directories_not_ready',
        'The library and staging directories must exist and be writable',
      ),
    });
    renderApp('/setup');
    await toLibrary(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByText(/must exist and be writable/)).toBeInTheDocument();
  });
});
