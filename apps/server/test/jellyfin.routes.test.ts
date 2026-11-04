import { Permission, REDACTED_SECRET, type SessionResponse, type UserDto } from '@hearer/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MOCK_API_KEY,
  deadUrl,
  startJellyfinMock,
  type JellyfinMock,
} from './helpers/jellyfin-mock.ts';
import {
  PASSWORD,
  addUser,
  call,
  completeSetup,
  createHarness,
  login,
  type Credentials,
  type Harness,
} from './helpers/auth.ts';

let mock: JellyfinMock;
let h: Harness;
let admin: Credentials;

beforeAll(async () => {
  mock = await startJellyfinMock();
});
afterAll(async () => {
  await mock.close();
});

beforeEach(async () => {
  mock.requests.length = 0;
  mock.behavior.version = '10.11.0';
  mock.behavior.delayMs = 0;
  mock.behavior.forceStatus = undefined;
  h = await createHarness({ deps: { mediaServerTimeoutMs: 1000 } });
  admin = await completeSetup(h);
});
afterEach(async () => {
  await h.cleanup();
});

const configure = (url = mock.url, apiKey = MOCK_API_KEY) => {
  h.app.hearer.settings.set('mediaServer', { type: 'jellyfin', url, apiKey });
};
const enableJellyfin = () => {
  h.app.hearer.settings.set('auth', { localEnabled: true, jellyfinEnabled: true });
};
const jfLogin = (username: string, password: string) =>
  call(h.app, undefined, 'POST', '/api/v1/auth/jellyfin', { username, password });

describe('POST /auth/jellyfin', () => {
  it('creates a user on first login without UPLOAD or ADMIN, and starts a session', async () => {
    configure();
    enableJellyfin();
    const res = await jfLogin('alice', 'alice-pass');
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionResponse>();
    expect(body.user).toMatchObject({
      username: 'alice',
      displayName: 'alice',
      authType: 'jellyfin',
    });
    expect(body.permissions).toEqual(['REQUEST', 'REQUEST_ALBUM']);
    expect(body.user.permissions & Permission.UPLOAD).toBe(0);
    expect(res.cookies.map((c) => c.name)).toContain('hearer_session');
    expect(body.csrfToken).toBeTruthy();

    const me = await call(
      h.app,
      { cookie: res.cookies.map((c) => `${c.name}=${c.value}`).join('; '), csrf: body.csrfToken },
      'GET',
      '/api/v1/auth/me',
    );
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: UserDto }>().user.username).toBe('alice');
  });

  it('reuses the same account on the second login', async () => {
    configure();
    enableJellyfin();
    const first = (await jfLogin('alice', 'alice-pass')).json<SessionResponse>();
    const second = (await jfLogin('alice', 'alice-pass')).json<SessionResponse>();
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.lastLoginAt).not.toBeNull();
    // admin + alice only
    expect(h.app.hearer.users.list({ page: 1, pageSize: 10 }).total).toBe(2);
  });

  it('keeps permissions an admin granted afterwards', async () => {
    configure();
    enableJellyfin();
    const first = (await jfLogin('alice', 'alice-pass')).json<SessionResponse>();
    h.app.hearer.users.update(first.user.id, {
      permissions: Permission.REQUEST | Permission.UPLOAD,
    });
    const again = (await jfLogin('alice', 'alice-pass')).json<SessionResponse>();
    expect(again.user.permissions).toBe(Permission.REQUEST | Permission.UPLOAD);
  });

  it('does not make a Jellyfin administrator a Hearer administrator', async () => {
    configure();
    enableJellyfin();
    const body = (await jfLogin('jfadmin', 'admin-pass')).json<SessionResponse>();
    expect(body.user.permissions & Permission.ADMIN).toBe(0);
    expect(body.permissions).not.toContain('ADMIN');
  });

  it('suffixes the username when a local user already has it', async () => {
    configure();
    enableJellyfin();
    await addUser(h.app, 'alice', Permission.REQUEST);
    const body = (await jfLogin('alice', 'alice-pass')).json<SessionResponse>();
    expect(body.user.username).toBe('alice-2');
    expect(body.user.authType).toBe('jellyfin');
  });

  it('is refused when the setting is off', async () => {
    configure();
    const res = await jfLogin('alice', 'alice-pass');
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('jellyfin_auth_disabled');
    expect(mock.requests).toHaveLength(0);
  });

  it('answers 401 for a wrong password or unknown user, creating nothing', async () => {
    configure();
    enableJellyfin();
    for (const [u, p] of [
      ['alice', 'wrong'],
      ['nobody', 'x'],
    ] as const) {
      const res = await jfLogin(u, p);
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_credentials');
      expect(res.cookies).toHaveLength(0);
    }
    expect(h.app.hearer.users.list({ page: 1, pageSize: 10 }).total).toBe(1);
  });

  it('answers 502 without leaking the server URL when Jellyfin is down', async () => {
    configure(await deadUrl());
    enableJellyfin();
    const res = await jfLogin('alice', 'alice-pass');
    expect(res.statusCode).toBe(502);
    const err = res.json<{ error: { code: string; message: string } }>().error;
    expect(err.code).toBe('media_server_unavailable');
    expect(res.body).not.toContain('127.0.0.1');
  });

  it('answers 502 on a Jellyfin 5xx', async () => {
    configure();
    enableJellyfin();
    mock.behavior.forceStatus = 500;
    const res = await jfLogin('alice', 'alice-pass');
    expect(res.statusCode).toBe(502);
  });

  it('answers 503 when no media server is configured', async () => {
    enableJellyfin();
    const res = await jfLogin('alice', 'alice-pass');
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('media_server_not_configured');
  });

  it('needs no CSRF token or session', async () => {
    configure();
    enableJellyfin();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/jellyfin',
      payload: { username: 'alice', password: 'alice-pass' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('is rate limited like local login', async () => {
    await h.cleanup();
    h = await createHarness({ auth: { rateLimitMax: 3 } });
    configure();
    enableJellyfin();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await jfLogin('alice', 'wrong')).statusCode);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });

  it('validates the body', async () => {
    const res = await call(h.app, undefined, 'POST', '/api/v1/auth/jellyfin', { username: '' });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /settings/mediaServer/test', () => {
  const test = (body: unknown, creds: Credentials | null = admin) =>
    call(h.app, creds ?? undefined, 'POST', '/api/v1/settings/mediaServer/test', body);

  it('reports server info without saving the candidate', async () => {
    const res = await test({ url: mock.url, apiKey: MOCK_API_KEY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      server: {
        id: '8f1c5e0a7d2b4c6e9a3b1d4f5e6a7b8c',
        name: 'Test Jellyfin',
        version: '10.11.0',
        versionSupported: true,
      },
    });
    expect(h.app.hearer.settings.get('mediaServer').url).toBe('');
  });

  it('includes the old-version warning', async () => {
    mock.behavior.version = '10.8.13';
    const body = (await test({ url: mock.url, apiKey: MOCK_API_KEY })).json<{
      server: { versionSupported: boolean; warning: string };
    }>();
    expect(body.server.versionSupported).toBe(false);
    expect(body.server.warning).toContain('10.8.13');
  });

  it('treats the masked API key as "use the stored one"', async () => {
    configure();
    const ok = await test({ url: mock.url, apiKey: REDACTED_SECRET });
    expect(ok.json<{ ok: boolean }>().ok).toBe(true);
    const used = mock.requests.at(-1)?.headers.authorization ?? '';
    expect(used).toContain(`Token="${MOCK_API_KEY}"`);
    expect(used).not.toContain(REDACTED_SECRET);
  });

  it('reports ok:false when the masked key is used but none is stored', async () => {
    const res = await test({ url: mock.url, apiKey: REDACTED_SECRET });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean; error: { code: string } }>()).toMatchObject({
      ok: false,
      error: { code: 'media_server_not_configured' },
    });
  });

  it('reports a bad key and an unreachable server as ok:false', async () => {
    const bad = (await test({ url: mock.url, apiKey: 'wrong' })).json<{
      ok: boolean;
      error: { code: string };
    }>();
    expect(bad).toMatchObject({ ok: false, error: { code: 'media_server_auth_failed' } });
    const down = (await test({ url: await deadUrl(), apiKey: 'k' })).json<{
      ok: boolean;
      error: { code: string };
    }>();
    expect(down).toMatchObject({ ok: false, error: { code: 'media_server_unavailable' } });
  });

  it('rejects an invalid candidate with 400', async () => {
    expect((await test({ url: 'not a url', apiKey: 'k' })).statusCode).toBe(400);
  });

  it('requires MANAGE_SETTINGS', async () => {
    expect((await test({}, null)).statusCode).toBe(401);
    await addUser(h.app, 'plain', Permission.REQUEST);
    expect((await test({}, await login(h.app, 'plain'))).statusCode).toBe(403);
    await addUser(h.app, 'cfg', Permission.MANAGE_SETTINGS);
    expect(
      (await test({ url: mock.url, apiKey: MOCK_API_KEY }, await login(h.app, 'cfg'))).statusCode,
    ).toBe(200);
  });
});

describe('Jellyfin user import', () => {
  const list = (creds: Credentials | null = admin) =>
    call(h.app, creds ?? undefined, 'GET', '/api/v1/users/import/jellyfin');
  const importIds = (ids: string[], creds: Credentials | null = admin) =>
    call(h.app, creds ?? undefined, 'POST', '/api/v1/users/import/jellyfin', { ids });

  const ALICE = '2b1ccd0f9d7a4a5a8f0f3c1d9e8b7a60';
  const BOB = '3c2dde1fae8b5b6b9a1a4d2eaf9c8b71';
  const JFADMIN = '9d8c7b6a5f4e4d3c8b2a1f0e9d8c7b6a';
  const MALLORY = '4d3eef20bf9c6c7caba2b5e3b0ad9c82';

  it('lists Jellyfin users and flags the imported ones', async () => {
    configure();
    enableJellyfin();
    const alice = (await jfLogin('alice', 'alice-pass')).json<SessionResponse>().user.id;
    const items = (await list()).json<{
      items: { id: string; name: string; isAdmin: boolean; importedUserId: string | null }[];
    }>().items;
    expect(items.map((i) => [i.name, i.importedUserId !== null])).toEqual([
      ['alice', true],
      ['bob', false],
      ['jfadmin', false],
      ['mallory', false],
    ]);
    expect(items[0]?.importedUserId).toBe(alice);
    expect(items[2]?.isAdmin).toBe(true);
  });

  it('imports users with the Jellyfin default permissions and skips disabled/unknown/duplicates', async () => {
    configure();
    const res = await importIds([BOB, JFADMIN, MALLORY, 'ffff', BOB]);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      imported: UserDto[];
      skipped: { id: string; reason: string }[];
    }>();
    expect(body.imported.map((u) => u.username)).toEqual(['bob', 'jfadmin']);
    for (const u of body.imported) {
      expect(u.authType).toBe('jellyfin');
      expect(u.permissions & Permission.UPLOAD).toBe(0);
      expect(u.permissions & Permission.ADMIN).toBe(0);
    }
    expect(body.skipped).toEqual([
      { id: MALLORY, reason: 'disabled' },
      { id: 'ffff', reason: 'not_found' },
    ]);

    const again = (await importIds([BOB, ALICE])).json<{
      imported: UserDto[];
      skipped: { id: string; reason: string }[];
    }>();
    expect(again.imported.map((u) => u.username)).toEqual(['alice']);
    expect(again.skipped).toEqual([{ id: BOB, reason: 'already_imported' }]);
  });

  it('lets an imported user sign in to the same account', async () => {
    configure();
    enableJellyfin();
    const imported = (await importIds([ALICE])).json<{ imported: UserDto[] }>().imported[0];
    const session = (await jfLogin('alice', 'alice-pass')).json<SessionResponse>();
    expect(session.user.id).toBe(imported?.id);
  });

  it('answers 502 when Jellyfin is down and 503 when unconfigured', async () => {
    expect((await list()).statusCode).toBe(503);
    configure(await deadUrl());
    expect((await list()).statusCode).toBe(502);
    expect((await importIds([ALICE])).statusCode).toBe(502);
  });

  it('validates the ids body', async () => {
    configure();
    expect((await importIds([])).statusCode).toBe(400);
  });

  it('requires MANAGE_USERS', async () => {
    configure();
    await addUser(h.app, 'plain', Permission.REQUEST);
    const plain = await login(h.app, 'plain');
    expect((await list(null)).statusCode).toBe(401);
    expect((await list(plain)).statusCode).toBe(403);
    expect((await importIds([ALICE], plain)).statusCode).toBe(403);
    await addUser(h.app, 'mgr', Permission.MANAGE_USERS);
    expect((await list(await login(h.app, 'mgr'))).statusCode).toBe(200);
  });
});

describe('setup wizard mediaServer section', () => {
  let fresh: Harness;
  let creds: Credentials;
  beforeEach(async () => {
    fresh = await createHarness();
    const res = await fresh.app.inject({
      method: 'POST',
      url: '/api/v1/setup/admin',
      payload: { username: 'root', password: PASSWORD },
    });
    creds = {
      cookie: res.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      csrf: res.json<SessionResponse>().csrfToken,
    };
  });
  afterEach(async () => {
    await fresh.cleanup();
  });
  const put = (body: unknown) => call(fresh.app, creds, 'PUT', '/api/v1/setup/mediaServer', body);

  it('tests the connection, then saves with the server id and a masked key', async () => {
    const res = await put({ type: 'jellyfin', url: `${mock.url}/`, apiKey: MOCK_API_KEY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      url: `${mock.url}/`,
      apiKey: REDACTED_SECRET,
      serverId: '8f1c5e0a7d2b4c6e9a3b1d4f5e6a7b8c',
    });
    expect(fresh.app.hearer.settings.get('mediaServer').apiKey).toBe(MOCK_API_KEY);
    const get = await call(fresh.app, creds, 'GET', '/api/v1/setup/mediaServer');
    expect(get.json<{ apiKey: string }>().apiKey).toBe(REDACTED_SECRET);
  });

  it('refuses to save a config that fails the test', async () => {
    const res = await put({ url: mock.url, apiKey: 'wrong' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string; details: { code: string } } }>().error).toMatchObject({
      code: 'media_server_test_failed',
      details: { code: 'media_server_auth_failed' },
    });
    expect(fresh.app.hearer.settings.get('mediaServer').apiKey).toBe('');
    const down = await put({ url: await deadUrl(), apiKey: 'k' });
    expect(down.statusCode).toBe(400);
    expect(fresh.app.hearer.settings.get('mediaServer').url).toBe('');
  });

  it('keeps a stored key when the masked placeholder is sent back', async () => {
    await put({ url: mock.url, apiKey: MOCK_API_KEY });
    const res = await put({
      url: mock.url,
      apiKey: REDACTED_SECRET,
      externalUrl: 'https://jf.test',
    });
    expect(res.statusCode).toBe(200);
    expect(fresh.app.hearer.settings.get('mediaServer')).toMatchObject({
      apiKey: MOCK_API_KEY,
      externalUrl: 'https://jf.test',
    });
  });
});
