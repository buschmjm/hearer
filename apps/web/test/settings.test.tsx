import { Permission, REDACTED_SECRET } from '@hearer/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  METHODS_LOCAL,
  STATUS_DONE,
  apiError,
  meReply,
  mockApi,
  renderApp,
  type Handler,
} from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const GENERAL = {
  appTitle: 'Hearer',
  applicationUrl: '',
  setupComplete: true,
  defaultPermissions: Permission.REQUEST,
  defaultRequestQuota: { limit: 0, days: 7 },
  defaultUploadQuota: { mb: 0, days: 7 },
};

function admin(extra: Record<string, Handler> = {}, permissions: number = Permission.ADMIN) {
  return mockApi({
    'GET /api/v1/setup/status': { json: STATUS_DONE },
    'GET /api/v1/auth/methods': { json: METHODS_LOCAL },
    'GET /api/v1/auth/me': meReply(permissions),
    ...extra,
  });
}

describe('settings: general', () => {
  it('saves the whole section and shows a toast', async () => {
    const user = userEvent.setup();
    const { calls } = admin({
      'GET /api/v1/settings/general': { json: GENERAL },
      'PUT /api/v1/settings/general': (call) => ({ json: call.body }),
    });
    renderApp('/admin/settings/general');
    const title = await screen.findByLabelText('Title');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await user.clear(title);
    await user.type(title, 'Tunes');
    expect(screen.getByText('You have unsaved changes.')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Request albums/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/api/v1/settings/general');
    expect(put?.headers['x-csrf-token']).toBe('csrf-1');
    // Everything, including fields the form does not show.
    expect(put?.body).toEqual({
      ...GENERAL,
      appTitle: 'Tunes',
      defaultPermissions: Permission.REQUEST | Permission.REQUEST_ALBUM,
    });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('cancel restores the saved values', async () => {
    const user = userEvent.setup();
    admin({ 'GET /api/v1/settings/general': { json: GENERAL } });
    renderApp('/admin/settings/general');
    const title = await screen.findByLabelText('Title');
    await user.type(title, 'xyz');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Title')).toHaveValue('Hearer');
  });

  it('shows client validation errors without calling the server', async () => {
    const user = userEvent.setup();
    const { calls } = admin({ 'GET /api/v1/settings/general': { json: GENERAL } });
    renderApp('/admin/settings/general');
    const url = await screen.findByLabelText('Application URL');
    await user.type(url, 'not a url');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Fix the highlighted fields/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('shows the server field errors inline', async () => {
    const user = userEvent.setup();
    admin({
      'GET /api/v1/settings/general': { json: GENERAL },
      'PUT /api/v1/settings/general': apiError(400, 'validation_error', 'Invalid settings', [
        { path: ['appTitle'], message: 'Title is reserved' },
      ]),
    });
    renderApp('/admin/settings/general');
    const title = await screen.findByLabelText('Title');
    await user.type(title, '2');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Title is reserved')).toBeInTheDocument();
  });
});

describe('settings: media server', () => {
  const MEDIA = {
    type: 'jellyfin',
    url: 'http://jf:8096',
    externalUrl: '',
    apiKey: REDACTED_SECRET,
    serverId: 'abc',
    pathMappings: [],
  };
  const LIBRARY_STATUS = {
    configured: true,
    state: {
      lastIncrementalAt: null,
      lastFullAt: null,
      lastMode: null,
      lastCounts: null,
      lastError: null,
      lastErrorAt: null,
    },
    counts: { artist: 3, album: 5, track: 40 },
    total: 48,
  };

  it('echoes the masked key unchanged when saving, tests the draft and queues a sync', async () => {
    const user = userEvent.setup();
    const { calls } = admin({
      'GET /api/v1/settings/mediaServer': { json: MEDIA },
      'GET /api/v1/library/status': { json: LIBRARY_STATUS },
      'PUT /api/v1/settings/mediaServer': (call) => ({ json: call.body }),
      'POST /api/v1/settings/mediaServer/test': {
        json: {
          ok: true,
          server: { id: 'abc', name: 'Home', version: '10.11.0', versionSupported: true },
        },
      },
      'POST /api/v1/library/sync': { status: 202, json: { jobId: 9, mode: 'full' } },
      'GET /api/v1/jobs/9': {
        json: {
          id: 9,
          type: 'library.sync',
          status: 'succeeded',
          priority: 0,
          uniqueKey: null,
          attempts: 1,
          maxAttempts: 5,
          runAfter: '2026-01-01T00:00:00.000Z',
          lockedBy: null,
          lockedAt: null,
          lastError: null,
          finishedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          payload: {},
        },
      },
    });
    renderApp('/admin/settings/media-server');
    const url = await screen.findByLabelText('Server URL');
    expect(screen.getByLabelText('API key (saved)')).toBeInTheDocument();
    expect(await screen.findByText('40')).toBeInTheDocument();

    await user.clear(url);
    await user.type(url, 'http://jellyfin:8096');
    await user.click(screen.getByRole('button', { name: 'Add mapping' }));
    await user.type(screen.getByLabelText('Media server path 1'), '/data/music');
    await user.type(screen.getByLabelText('Hearer path 1'), '/music');

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Connected to Home/)).toBeInTheDocument();
    const test = calls.find((c) => c.path.endsWith('/test'));
    expect(test?.body).toMatchObject({ url: 'http://jellyfin:8096', apiKey: REDACTED_SECRET });

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    });
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      ...MEDIA,
      url: 'http://jellyfin:8096',
      pathMappings: [{ serverPath: '/data/music', localPath: '/music' }],
    });

    await user.click(screen.getByRole('button', { name: 'Full sync' }));
    expect(await screen.findByText('Library sync finished.')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/v1/library/sync')?.body).toEqual({ mode: 'full' });
  });
});

describe('settings: auth', () => {
  const AUTH = {
    localEnabled: true,
    jellyfinEnabled: false,
    oidc: {
      enabled: true,
      issuerUrl: 'https://sso.test/realms/x',
      clientId: 'hearer',
      clientSecret: REDACTED_SECRET,
      scopes: 'openid profile email',
      buttonLabel: 'Sign in with SSO',
      autoCreateUsers: true,
      usernameClaim: 'preferred_username',
      emailClaim: 'email',
      groupsClaim: '',
      adminGroup: '',
      allowedGroups: [],
      linkExistingByEmail: false,
      linkAdminAccounts: false,
      allowInsecureHttp: false,
    },
  };

  it('shows the redirect URI, runs discovery and warns about risky options', async () => {
    const user = userEvent.setup();
    const { calls } = admin({
      'GET /api/v1/settings/auth': { json: AUTH },
      'GET /api/v1/settings/auth/oidc/redirect-uri': {
        json: { redirectUri: 'https://hearer.test/api/v1/auth/oidc/callback' },
      },
      'POST /api/v1/settings/auth/oidc/test': {
        json: {
          ok: true,
          redirectUri: 'x',
          issuer: 'https://sso.test/realms/x',
          pkceS256: true,
          idTokenAlgs: ['RS256'],
        },
      },
      'PUT /api/v1/settings/auth': apiError(
        400,
        'would_lock_out',
        'At least one sign-in method must stay enabled',
      ),
    });
    renderApp('/admin/settings/auth');
    expect(
      await screen.findByText('https://hearer.test/api/v1/auth/oidc/callback'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Client secret (saved)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Test discovery' }));
    expect(await screen.findByText('Discovery worked')).toBeInTheDocument();
    expect(calls.find((c) => c.path.endsWith('/oidc/test'))?.body).toEqual({
      issuerUrl: 'https://sso.test/realms/x',
      allowInsecureHttp: false,
    });

    expect(screen.queryByText(/take over the matching account/)).toBeNull();
    await user.click(screen.getByRole('switch', { name: /Link to existing accounts/ }));
    expect(screen.getByText(/take over the matching account/)).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: /Allow an http/ }));
    expect(screen.getByText(/travel unencrypted/)).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: /Local accounts/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('At least one sign-in method must stay enabled'),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      localEnabled: false,
      oidc: { clientSecret: REDACTED_SECRET, linkExistingByEmail: true },
    });
  });
});

describe('settings: library & uploads', () => {
  it('previews templates live and saves both sections', async () => {
    const user = userEvent.setup();
    const LIB = { namingTemplate: '{albumartist}/{title}.{ext}', singlesTemplate: '{title}.{ext}' };
    const UP = {
      maxFileSizeMb: 2048,
      allowedFormats: ['flac', 'mp3'],
      autoApproveThreshold: 0.9,
      coverMaxPx: 1200,
      allowDuplicateOverride: false,
    };
    const { calls } = admin({
      'GET /api/v1/settings/library': { json: LIB },
      'GET /api/v1/settings/uploads': { json: UP },
      'PUT /api/v1/settings/library': (c) => ({ json: c.body }),
      'PUT /api/v1/settings/uploads': (c) => ({ json: c.body }),
    });
    renderApp('/admin/settings/library');
    const naming = await screen.findByLabelText('Naming template');
    expect(screen.getByTestId('naming-preview')).toHaveTextContent(
      'Radiohead/Paranoid Android.flac',
    );

    await user.clear(naming);
    await user.type(naming, '{{title}');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Include \{ext\}|Unbalanced|Unknown/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    await user.clear(naming);
    await user.type(naming, '{{artist}/{{title}.{{ext}');
    expect(screen.getByTestId('naming-preview')).toHaveTextContent(
      'Radiohead/Paranoid Android.flac',
    );
    await user.click(screen.getByRole('checkbox', { name: 'opus' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.path)).toEqual([
      '/api/v1/settings/library',
      '/api/v1/settings/uploads',
    ]);
    expect(puts[0]?.body).toEqual({ ...LIB, namingTemplate: '{artist}/{title}.{ext}' });
    expect(puts[1]?.body).toEqual({ ...UP, allowedFormats: ['flac', 'mp3', 'opus'] });
  });
});

describe('settings: fulfillment', () => {
  const FULFILL = {
    manual: { enabled: true },
    lidarr: {
      enabled: true,
      url: 'http://lidarr:8686',
      apiKey: REDACTED_SECRET,
      rootFolder: '/music',
      qualityProfileId: 2,
      metadataProfileId: 1,
      trackPolicy: 'album',
    },
  };
  const LIDARR_SCHEMA = {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      url: {
        default: '',
        anyOf: [
          { type: 'string', const: '' },
          { type: 'string', format: 'uri' },
        ],
      },
      apiKey: { type: 'string', 'x-secret': true },
      rootFolder: { type: 'string' },
      qualityProfileId: { type: 'integer', minimum: 0 },
      metadataProfileId: { type: 'integer', minimum: 0 },
      trackPolicy: { type: 'string', enum: ['album', 'skip'] },
    },
  };

  it('renders the schema form, fills dropdowns from Lidarr and saves the full section', async () => {
    const user = userEvent.setup();
    const { calls } = admin({
      'GET /api/v1/settings/fulfillment': { json: FULFILL },
      'GET /api/v1/fulfillment/providers': {
        json: {
          providers: [
            {
              id: 'lidarr',
              label: 'Lidarr',
              enabled: true,
              supports: { track: true, album: true, artist: true },
              settingsPath: 'fulfillment.lidarr',
              configSchema: LIDARR_SCHEMA,
              config: FULFILL.lidarr,
            },
            {
              id: 'manual',
              label: 'Manual (upload)',
              enabled: true,
              supports: { track: true, album: true, artist: true },
              settingsPath: 'fulfillment.manual',
              configSchema: { type: 'object', properties: { enabled: { type: 'boolean' } } },
              config: FULFILL.manual,
            },
          ],
        },
      },
      'GET /api/v1/settings/fulfillment/lidarr/options': {
        json: {
          qualityProfiles: [
            { id: 1, name: 'Any' },
            { id: 2, name: 'Lossless' },
          ],
          metadataProfiles: [{ id: 1, name: 'Standard' }],
          rootFolders: [
            { id: 1, path: '/music' },
            { id: 2, path: '/other' },
          ],
        },
      },
      'POST /api/v1/settings/fulfillment/lidarr/test': { json: { ok: true, version: '2.5.0' } },
      'PUT /api/v1/settings/fulfillment': (c) => ({ json: c.body }),
    });
    renderApp('/admin/settings/fulfillment');
    await waitFor(() => {
      expect(screen.getByLabelText('Quality profile ID')).toHaveDisplayValue('Lossless');
    });
    const quality = screen.getByLabelText('Quality profile ID');
    expect(screen.getByLabelText('Root folder')).toHaveDisplayValue('/music');
    expect(screen.getByLabelText('API key (saved)')).toBeInTheDocument();

    await user.selectOptions(quality, 'Any');
    await user.selectOptions(screen.getByLabelText('Root folder'), '/other');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connected (Lidarr 2.5.0).')).toBeInTheDocument();
    expect(calls.find((c) => c.path.endsWith('/lidarr/test'))?.body).toMatchObject({
      apiKey: REDACTED_SECRET,
      qualityProfileId: 1,
    });

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      manual: { enabled: true },
      lidarr: { ...FULFILL.lidarr, qualityProfileId: 1, rootFolder: '/other' },
    });
  });
});

describe('settings: access', () => {
  it('redirects /admin/settings to the general tab', async () => {
    admin({ 'GET /api/v1/settings/general': { json: GENERAL } });
    const { router } = renderApp('/admin/settings');
    await screen.findByLabelText('Title');
    expect(router.state.location.pathname).toBe('/admin/settings/general');
  });

  it('keeps users without MANAGE_SETTINGS out, without calling the settings API', async () => {
    const { calls } = admin({}, Permission.MANAGE_USERS);
    renderApp('/admin/settings/general');
    expect(await screen.findByText('You do not have access to this page')).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/api/v1/settings'))).toBe(false);
  });

  it('shows the admin landing cards the user may use', async () => {
    admin({}, Permission.MANAGE_USERS);
    renderApp('/admin');
    expect(await screen.findByRole('link', { name: /Users/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Settings/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Jobs/ })).toBeNull();
  });
});
