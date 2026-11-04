import { Permission, REDACTED_SECRET } from '@hearer/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  METHODS_LOCAL,
  STATUS_DONE,
  apiError,
  makeUser,
  meReply,
  mockApi,
  renderApp,
  type Handler,
} from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function signedIn(extra: Record<string, Handler> = {}, permissions: number = Permission.ADMIN) {
  return mockApi({
    'GET /api/v1/setup/status': { json: STATUS_DONE },
    'GET /api/v1/auth/methods': { json: METHODS_LOCAL },
    'GET /api/v1/auth/me': meReply(permissions),
    ...extra,
  });
}

const EVENTS = [
  {
    id: 'request.created',
    label: 'New request',
    description: 'A request needs approval',
    subscribable: true,
  },
  {
    id: 'request.available',
    label: 'Request available',
    description: 'Music arrived',
    subscribable: true,
  },
  { id: 'test', label: 'Test', description: 'Test', subscribable: false },
];
const AGENTS = [
  {
    id: 'webhook',
    label: 'Webhook',
    description: 'POST JSON to a URL.',
    configSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', format: 'uri' },
        secret: { type: 'string', 'x-secret': true, default: '' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 60, default: 10 },
      },
    },
    defaultConfig: { secret: '', timeoutSeconds: 10 },
  },
  {
    id: 'slack',
    label: 'Slack',
    description: 'Slack channel.',
    configSchema: {
      type: 'object',
      required: ['webhookUrl'],
      properties: { webhookUrl: { type: 'string', format: 'uri', 'x-secret': true } },
    },
    defaultConfig: {},
  },
];
const TARGET = {
  id: 't1',
  name: 'Ops hook',
  agent: 'webhook',
  config: { url: 'https://hook.test/x', secret: REDACTED_SECRET, timeoutSeconds: 10 },
  events: ['request.created'],
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('notification targets', () => {
  it('creates a target from the agent schema, tests it unsaved, then saves', async () => {
    const user = userEvent.setup();
    const targets: unknown[] = [];
    const { calls } = signedIn({
      'GET /api/v1/notifications/agents': { json: { agents: AGENTS, events: EVENTS } },
      'GET /api/v1/notifications/targets': () => ({ json: { targets } }),
      'POST /api/v1/notifications/test': { json: { ok: true } },
      'POST /api/v1/notifications/targets': (call) => {
        targets.push({ ...TARGET, ...(call.body as object) });
        return { status: 201, json: TARGET };
      },
    });
    renderApp('/admin/settings/notifications');
    expect(await screen.findByText('No notification targets yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Add target/ }));

    const dialog = await screen.findByRole('dialog');
    // Only subscribable events are offered.
    expect(within(dialog).queryByRole('checkbox', { name: /^Test/ })).toBeNull();

    // Validation: the required URL and the name.
    await user.click(within(dialog).getByRole('button', { name: 'Add target' }));
    expect(await within(dialog).findByText('Give this target a name.')).toBeInTheDocument();
    expect(within(dialog).getByText('This field is required.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.type(within(dialog).getByLabelText('Name'), 'Ops hook');
    await user.type(within(dialog).getByLabelText(/^URL/), 'https://hook.test/x');
    await user.type(within(dialog).getByLabelText('Secret'), 'hunter2');
    await user.click(within(dialog).getByRole('checkbox', { name: /New request/ }));

    await user.click(within(dialog).getByRole('button', { name: 'Send test' }));
    expect(await within(dialog).findByText('Test notification sent.')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/v1/notifications/test')?.body).toEqual({
      agent: 'webhook',
      config: { secret: 'hunter2', timeoutSeconds: 10, url: 'https://hook.test/x' },
    });

    await user.click(within(dialog).getByRole('button', { name: 'Add target' }));
    expect(await screen.findByText('Target added.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/targets'))?.body).toEqual({
      name: 'Ops hook',
      agent: 'webhook',
      config: { secret: 'hunter2', timeoutSeconds: 10, url: 'https://hook.test/x' },
      events: ['request.created'],
      enabled: true,
    });
    expect(await screen.findByText('Ops hook')).toBeInTheDocument();
  });

  it('edits a saved target keeping the masked secret, tests with its id, and toggles enabled', async () => {
    const user = userEvent.setup();
    const { calls } = signedIn({
      'GET /api/v1/notifications/agents': { json: { agents: AGENTS, events: EVENTS } },
      'GET /api/v1/notifications/targets': { json: { targets: [TARGET] } },
      'PUT /api/v1/notifications/targets/t1': (c) => ({
        json: { ...TARGET, ...(c.body as object) },
      }),
      'POST /api/v1/notifications/test': {
        json: { ok: false, message: 'HTTP 500 from the destination' },
      },
      'POST /api/v1/notifications/targets/t1/test': { json: { ok: true } },
    });
    renderApp('/admin/settings/notifications');
    await screen.findByText('Ops hook');

    await user.click(screen.getByRole('button', { name: 'Send test to Ops hook' }));
    expect(await screen.findByText('Test sent to Ops hook.')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Enable Ops hook' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    });
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      enabled: false,
      config: { secret: REDACTED_SECRET },
    });

    await user.click(screen.getByRole('button', { name: 'Edit Ops hook' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Type')).toBeDisabled();
    expect(within(dialog).getByLabelText('Secret (saved)')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Send test' }));
    expect(await within(dialog).findByText('HTTP 500 from the destination')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/v1/notifications/test')?.body).toMatchObject({
      targetId: 't1',
      config: { secret: REDACTED_SECRET },
    });
  });

  it('deletes after confirmation and shows a server refusal inline', async () => {
    const user = userEvent.setup();
    let fail = true;
    const { calls } = signedIn({
      'GET /api/v1/notifications/agents': { json: { agents: AGENTS, events: EVENTS } },
      'GET /api/v1/notifications/targets': { json: { targets: [TARGET] } },
      'DELETE /api/v1/notifications/targets/t1': () => {
        if (fail) return apiError(500, 'internal', 'Could not delete');
        return { status: 204 };
      },
    });
    renderApp('/admin/settings/notifications');
    await screen.findByText('Ops hook');
    await user.click(screen.getByRole('button', { name: 'Delete Ops hook' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Delete Ops hook' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    );
    expect(await screen.findByText('Could not delete')).toBeInTheDocument();
    fail = false;
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Target deleted.')).toBeInTheDocument();
  });
});

const USERS = [
  makeUser({ id: 'u1', username: 'alice', displayName: 'Alice', permissions: Permission.ADMIN }),
  makeUser({
    id: 'u2',
    username: 'bob',
    displayName: 'Bob',
    email: 'bob@x.test',
    permissions: Permission.REQUEST | Permission.UPLOAD,
  }),
  makeUser({
    id: 'u3',
    username: 'jelly',
    displayName: 'Jelly',
    authType: 'jellyfin',
    email: null,
    permissions: Permission.REQUEST,
  }),
];
const list = (items = USERS) => ({ json: { items, total: items.length, page: 1, pageSize: 20 } });

describe('users page', () => {
  it('lists, searches (debounced) and shows auth badges and permission chips', async () => {
    const user = userEvent.setup();
    const { calls } = signedIn({ 'GET /api/v1/users': (c) => list(c.path ? USERS : USERS) });
    renderApp('/admin/users');
    expect(await screen.findByText('Bob')).toBeInTheDocument();
    expect(screen.getAllByText('Jellyfin').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Admin').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Upload').length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText('Search users'), 'bo');
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/api/v1/users' && c.method === 'GET')).toBe(true);
    });
  });

  it('creates a local user', async () => {
    const user = userEvent.setup();
    const { calls } = signedIn({
      'GET /api/v1/users': list(),
      'POST /api/v1/users': { status: 201, json: USERS[1] },
    });
    renderApp('/admin/users');
    await screen.findByText('Bob');
    await user.click(screen.getByRole('button', { name: /Create user/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));
    expect(await within(dialog).findAllByRole('alert')).not.toHaveLength(0);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.type(within(dialog).getByLabelText('Username'), 'carol');
    await user.type(within(dialog).getByLabelText('Password'), 'long enough pw');
    await user.type(within(dialog).getByLabelText('Display name'), 'Carol');
    await user.click(within(dialog).getByRole('checkbox', { name: /Request songs/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));
    expect(await screen.findByText('Created bob.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      username: 'carol',
      password: 'long enough pw',
      displayName: 'Carol',
      permissions: Permission.REQUEST,
    });
  });

  it('edits permissions and quotas; escalation-blocked bits are disabled for a delegated manager', async () => {
    const user = userEvent.setup();
    const { calls } = signedIn(
      {
        'GET /api/v1/users': list([
          makeUser({
            id: 'u2',
            username: 'bob',
            displayName: 'Bob',
            permissions: Permission.REQUEST,
          }),
          makeUser({
            id: 'u9',
            username: 'boss',
            displayName: 'Boss',
            permissions: Permission.ADMIN,
          }),
        ]),
        'PATCH /api/v1/users/u2': (c) => ({ json: { ...USERS[1], ...(c.body as object) } }),
      },
      Permission.MANAGE_USERS | Permission.REQUEST,
    );
    renderApp('/admin/users');
    await screen.findByText('Bob');
    // An administrator cannot be touched by this manager.
    expect(screen.getByRole('button', { name: 'Delete boss' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Edit bob' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('checkbox', { name: /Manage settings/ })).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: /Manage users/ })).toBeEnabled();
    expect(within(dialog).getByRole('checkbox', { name: /Request albums/ })).toBeDisabled();

    await user.click(within(dialog).getByRole('checkbox', { name: /Manage users/ }));
    await user.type(within(dialog).getByLabelText('Requests allowed'), '5');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved bob.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
      permissions: Permission.REQUEST | Permission.MANAGE_USERS,
      requestQuotaLimit: 5,
      requestQuotaDays: null,
      displayName: 'Bob',
    });
  });

  it('resets a password and deletes with confirmation, surfacing server guards', async () => {
    const user = userEvent.setup();
    const { calls } = signedIn({
      'GET /api/v1/users': list(),
      'POST /api/v1/users/u2/password': { status: 204 },
      'DELETE /api/v1/users/u2': apiError(
        409,
        'last_admin',
        'The last administrator cannot be removed',
      ),
    });
    renderApp('/admin/users');
    await screen.findByText('Bob');
    // You cannot delete yourself or reset your own password from here; external accounts have no password.
    expect(screen.getByRole('button', { name: 'Delete alice' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Reset password for alice' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset password for jelly' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Reset password for bob' }));
    let dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('New password'), 'short');
    await user.click(within(dialog).getByRole('button', { name: 'Reset password' }));
    expect(await within(dialog).findByText(/between 8 and 128/)).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('New password'));
    await user.type(within(dialog).getByLabelText('New password'), 'a better password');
    await user.click(within(dialog).getByRole('button', { name: 'Reset password' }));
    expect(await screen.findByText(/Password reset for bob/)).toBeInTheDocument();
    expect(calls.find((c) => c.path.endsWith('/password'))?.body).toEqual({
      newPassword: 'a better password',
    });

    await user.click(screen.getByRole('button', { name: 'Delete bob' }));
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete user' }));
    expect(
      await within(dialog).findByText('The last administrator cannot be removed'),
    ).toBeInTheDocument();
  });

  it('imports selected Jellyfin users and flags the ones already imported', async () => {
    const user = userEvent.setup();
    const { calls } = signedIn({
      'GET /api/v1/users': list(),
      'GET /api/v1/users/import/jellyfin': {
        json: {
          items: [
            { id: 'j1', name: 'zoe', isAdmin: false, isDisabled: false, importedUserId: null },
            { id: 'j2', name: 'jelly', isAdmin: false, isDisabled: false, importedUserId: 'u3' },
            { id: 'j3', name: 'old', isAdmin: false, isDisabled: true, importedUserId: null },
          ],
        },
      },
      'POST /api/v1/users/import/jellyfin': { json: { imported: [USERS[2]], skipped: [] } },
    });
    renderApp('/admin/users');
    await screen.findByText('Bob');
    await user.click(screen.getByRole('button', { name: /Import from Jellyfin/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Already imported')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: /jelly/ })).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: /old/ })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^Import/ })).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: /zoe/ }));
    await user.click(within(dialog).getByRole('button', { name: /^Import/ }));
    expect(await screen.findByText('Imported 1 user.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ ids: ['j1'] });
  });

  it('keeps users without MANAGE_USERS out', async () => {
    const { calls } = signedIn({}, Permission.MANAGE_SETTINGS);
    renderApp('/admin/users');
    expect(await screen.findByText('You do not have access to this page')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/v1/users')).toBe(false);
  });
});

const job = (over: Record<string, unknown> = {}) => ({
  id: 7,
  type: 'requests.submit',
  status: 'dead',
  priority: 0,
  uniqueKey: null,
  attempts: 5,
  maxAttempts: 5,
  runAfter: '2026-01-01T00:00:00.000Z',
  lockedBy: null,
  lockedAt: null,
  lastError: 'Error: provider refused\n    at somewhere',
  finishedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  payload: { requestId: 'r1' },
  ...over,
});
const SUMMARY = {
  counts: [{ type: 'requests.submit', status: 'dead', count: 1 }],
  totals: { queued: 2, running: 0, succeeded: 10, failed: 0, dead: 1 },
  schedules: [
    {
      key: 'schedule:maintenance.cleanup',
      type: 'maintenance.cleanup',
      nextRunAt: '2026-01-01T01:00:00.000Z',
      everyMs: 3600000,
    },
  ],
};

describe('jobs page', () => {
  it('shows summary cards, expands errors, retries and deletes', async () => {
    const user = userEvent.setup();
    const { calls } = signedIn({
      'GET /api/v1/jobs/summary': { json: SUMMARY },
      'GET /api/v1/jobs': {
        json: {
          items: [job(), job({ id: 8, status: 'queued', lastError: null })],
          total: 2,
          page: 1,
          pageSize: 25,
        },
      },
      'POST /api/v1/jobs/7/retry': { json: job({ status: 'queued', attempts: 0 }) },
      'DELETE /api/v1/jobs/8': { status: 204 },
    });
    renderApp('/admin/jobs');
    expect(await screen.findByTestId('total-dead')).toHaveTextContent('1');
    expect(screen.getByTestId('total-succeeded')).toHaveTextContent('10');

    expect(screen.queryByText(/provider refused/)).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Show details for job 7' }));
    expect(screen.getByText(/provider refused/)).toBeInTheDocument();
    expect(screen.getByText(/"requestId": "r1"/)).toBeInTheDocument();

    // Only dead/failed jobs can be retried; only queued/dead deleted.
    expect(screen.queryByRole('button', { name: 'Retry job 8' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry job 7' }));
    expect(await screen.findByText('Job 7 queued again.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/jobs/7/retry')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Delete job 8' }));
    expect(await screen.findByText('Job 8 deleted.')).toBeInTheDocument();
  });

  it('filters by status and type through the API', async () => {
    const user = userEvent.setup();
    const { calls } = signedIn({
      'GET /api/v1/jobs/summary': { json: SUMMARY },
      'GET /api/v1/jobs': { json: { items: [], total: 0, page: 1, pageSize: 25 } },
    });
    renderApp('/admin/jobs');
    await screen.findByText('No jobs match.');
    await user.selectOptions(screen.getByLabelText('Status'), 'dead');
    await user.selectOptions(await screen.findByLabelText('Type'), 'requests.submit');
    await waitFor(() => {
      expect(
        calls.some(
          (c) =>
            c.method === 'GET' &&
            c.path === '/api/v1/jobs' &&
            c.headers.accept === 'application/json',
        ),
      ).toBe(true);
    });
    const urls = vi.mocked(fetch).mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    expect(urls.some((u) => u.includes('status=dead') && u.includes('type=requests.submit'))).toBe(
      true,
    );
  });

  it('refreshes automatically every 5 seconds while visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { calls } = signedIn({
        'GET /api/v1/jobs/summary': { json: SUMMARY },
        'GET /api/v1/jobs': { json: { items: [job()], total: 1, page: 1, pageSize: 25 } },
      });
      renderApp('/admin/jobs');
      await screen.findByTestId('total-dead');
      const count = () => calls.filter((c) => c.path === '/api/v1/jobs').length;
      const before = count();
      await vi.advanceTimersByTimeAsync(5200);
      await waitFor(() => {
        expect(count()).toBeGreaterThan(before);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps non-admins out', async () => {
    const { calls } = signedIn({}, Permission.MANAGE_USERS);
    renderApp('/admin/jobs');
    expect(await screen.findByText('You do not have access to this page')).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/api/v1/jobs'))).toBe(false);
  });
});

describe('account', () => {
  it('edits the profile and changes the password (local account)', async () => {
    const user = userEvent.setup();
    const { calls } = signedIn(
      {
        'PATCH /api/v1/auth/me': (c) => ({
          json: { ...meReply(0).json, user: makeUser({ ...(c.body as object) }) },
        }),
        'POST /api/v1/auth/password': { status: 204 },
      },
      Permission.REQUEST,
    );
    renderApp('/account');
    const name = await screen.findByLabelText('Display name');
    await user.clear(name);
    await user.type(name, 'Alice B');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      displayName: 'Alice B',
      email: 'alice@example.test',
    });

    await user.type(screen.getByLabelText('Current password'), 'old password');
    await user.type(screen.getByLabelText('New password'), 'new password 1');
    await user.type(screen.getByLabelText('Confirm new password'), 'different');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Confirm new password'));
    await user.type(screen.getByLabelText('Confirm new password'), 'new password 1');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/Password changed/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/v1/auth/password')?.body).toEqual({
      currentPassword: 'old password',
      newPassword: 'new password 1',
    });
  });

  it('shows the API key token once, with copy, and deletes keys with confirmation', async () => {
    const user = userEvent.setup();
    const keys = [
      {
        id: 'k1',
        name: 'Script',
        prefix: 'hrr_abcd',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: null,
      },
    ];
    const { calls } = signedIn(
      {
        'GET /api/v1/auth/api-keys': () => ({ json: { items: keys } }),
        'POST /api/v1/auth/api-keys': {
          status: 201,
          json: { key: { ...keys[0], id: 'k2', name: 'New one' }, secret: 'hrr_SECRETVALUE' },
        },
        'DELETE /api/v1/auth/api-keys/k1': { status: 204 },
      },
      Permission.REQUEST,
    );
    renderApp('/account/api-keys');
    expect(await screen.findByText('Script')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Create key/ }));
    let dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(await within(dialog).findByText(/Give the key a name/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), 'New one');
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(await within(dialog).findByTestId('api-key-secret')).toHaveTextContent(
      'hrr_SECRETVALUE',
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'New one' });

    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    // The token is gone for good: nothing on the page shows it any more.
    expect(screen.queryByText('hrr_SECRETVALUE')).toBeNull();
    expect(document.body.textContent).not.toContain('hrr_SECRETVALUE');

    await user.click(screen.getByRole('button', { name: 'Delete key Script' }));
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete key' }));
    expect(await screen.findByText('API key deleted.')).toBeInTheDocument();
  });

  it('saves my notification preferences', async () => {
    const user = userEvent.setup();
    const { calls } = signedIn(
      {
        'GET /api/v1/auth/me/notifications': {
          json: {
            prefs: {},
            email: { available: true, address: 'alice@example.test', reason: null },
            ntfy: { available: true, server: 'https://ntfy.sh' },
            events: EVENTS,
          },
        },
        'PUT /api/v1/auth/me/notifications': (c) => ({
          json: {
            prefs: c.body,
            email: { available: true, address: 'alice@example.test', reason: null },
            ntfy: { available: true, server: 'https://ntfy.sh' },
            events: EVENTS,
          },
        }),
      },
      Permission.REQUEST,
    );
    renderApp('/account/notifications');
    await user.click(await screen.findByRole('switch', { name: /Email me/ }));
    await user.click(screen.getByRole('checkbox', { name: /Request available/ }));
    await user.type(screen.getByLabelText('Your topic'), 'alice-secret-topic');
    await user.click(
      screen.getAllByRole('checkbox', { name: /New request/ }).at(-1) ?? document.body,
    );
    await user.click(screen.getByRole('button', { name: 'Save notification settings' }));
    expect(await screen.findByText('Notification settings saved.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      email: { enabled: true, events: ['request.available'] },
      ntfy: { topic: 'alice-secret-topic', events: ['request.created'] },
    });
  });
});
