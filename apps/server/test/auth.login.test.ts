import type { MeResponse, SessionResponse } from '@hearer/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/sessions.ts';
import {
  PASSWORD,
  ROLES,
  addUser,
  call,
  completeSetup,
  cookieHeader,
  createHarness,
  login,
  type Credentials,
  type Harness,
} from './helpers/auth.ts';

let h: Harness;
afterEach(async () => {
  await h.cleanup();
});

const DAY = 24 * 60 * 60 * 1000;
const loginRequest = (username: string, password: string, headers: Record<string, string> = {}) =>
  h.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
    headers,
  });

async function setup(options: Parameters<typeof createHarness>[0] = {}): Promise<Credentials> {
  h = await createHarness(options);
  return completeSetup(h);
}

describe('POST /auth/login', () => {
  it('signs in, returns the user without secrets, and sets a hardened cookie', async () => {
    await setup();
    await addUser(h.app, 'Alice', ROLES.user);
    const res = await loginRequest('alice', PASSWORD, { 'user-agent': 'vitest/1' });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionResponse>();
    expect(body.user).toMatchObject({
      username: 'Alice',
      authType: 'local',
      permissions: ROLES.user,
    });
    expect(body.permissions).toEqual(['REQUEST', 'REQUEST_ALBUM', 'UPLOAD']);
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body).not.toMatch(/passwordHash|password_hash|argon2/);

    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(cookie?.secure).toBeFalsy();
    expect(cookie?.expires?.getTime()).toBeGreaterThan(h.clock.t + 29 * DAY);
    expect(cookie?.expires?.getTime()).toBeLessThanOrEqual(h.clock.t + 30 * DAY);

    const row = h.app.hearer.database.sqlite
      .prepare('select ip, user_agent from sessions where user_id = ?')
      .get(h.app.hearer.users.getByUsername('alice')?.id) as { ip: string; user_agent: string };
    expect(row).toEqual({ ip: '127.0.0.1', user_agent: 'vitest/1' });
    expect(h.app.hearer.users.getByUsername('alice')?.lastLoginAt).toBeInstanceOf(Date);
  });

  it('rejects bad credentials with one indistinguishable error', async () => {
    await setup();
    await addUser(h.app, 'alice', ROLES.user);
    const wrongPassword = await loginRequest('alice', 'nope-nope-nope');
    const unknownUser = await loginRequest('ghost', 'nope-nope-nope');
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownUser.json());
    expect(wrongPassword.json()).toEqual({
      error: { code: 'invalid_credentials', message: 'Invalid username or password' },
    });
    expect(wrongPassword.cookies).toHaveLength(0);
  });

  it('does not let external accounts sign in with a password', async () => {
    await setup();
    h.app.hearer.users.findOrCreateExternalUser('jellyfin', 'jf-1', { username: 'jelly' });
    expect((await loginRequest('jelly', PASSWORD)).statusCode).toBe(401);
  });

  it('validates the body', async () => {
    await setup();
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_error');
  });

  it('refuses when local sign-in is disabled', async () => {
    await setup();
    await addUser(h.app, 'alice', ROLES.user);
    const auth = h.app.hearer.settings.get('auth');
    h.app.hearer.settings.set('auth', { ...auth, localEnabled: false, jellyfinEnabled: true });
    const res = await loginRequest('alice', PASSWORD);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('local_auth_disabled');
  });

  it('rate limits attempts per client address, with the error envelope', async () => {
    await setup({ auth: { rateLimitMax: 3 } });
    for (let i = 0; i < 3; i++) {
      expect((await loginRequest('ghost', 'whatever-pass')).statusCode).toBe(401);
    }
    const blocked = await loginRequest('ghost', 'whatever-pass');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe('rate_limited');
    expect(blocked.headers['retry-after']).toBeDefined();
    // Even correct credentials are refused while limited.
    await addUser(h.app, 'alice', ROLES.user);
    expect((await loginRequest('alice', PASSWORD)).statusCode).toBe(429);
  });

  it('marks the cookie Secure behind an https proxy', async () => {
    await setup({ env: { TRUST_PROXY: 'true' } });
    await addUser(h.app, 'alice', ROLES.user);
    const res = await loginRequest('alice', PASSWORD, { 'x-forwarded-proto': 'https' });
    expect(res.cookies[0]?.secure).toBe(true);
  });

  it('marks the cookie Secure when the public URL is https', async () => {
    const creds = await setup();
    await addUser(h.app, 'alice', ROLES.user);
    const general = await call(h.app, creds, 'PUT', '/api/v1/settings/general', {
      applicationUrl: 'https://hearer.example.com',
    });
    expect(general.statusCode).toBe(200);
    const res = await loginRequest('alice', PASSWORD);
    expect(res.cookies[0]?.secure).toBe(true);
  });

  it('replaces an existing session instead of reusing it', async () => {
    await setup();
    await addUser(h.app, 'alice', ROLES.user);
    const first = await login(h.app, 'alice');
    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'alice', password: PASSWORD },
      headers: { cookie: first.cookie },
    });
    expect(second.statusCode).toBe(200);
    expect(cookieHeader(second)).not.toBe(first.cookie);
    expect((await call(h.app, first, 'GET', '/api/v1/auth/me')).statusCode).toBe(401);
  });
});

describe('sessions over time', () => {
  it('logout deletes the session and clears the cookie', async () => {
    await setup();
    await addUser(h.app, 'alice', ROLES.user);
    const alice = await login(h.app, 'alice');
    const out = await call(h.app, alice, 'POST', '/api/v1/auth/logout');
    expect(out.statusCode).toBe(204);
    expect(out.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
    expect((await call(h.app, alice, 'GET', '/api/v1/auth/me')).statusCode).toBe(401);
    expect(
      h.app.hearer.database.sqlite
        .prepare('select count(*) as n from sessions where user_id = ?')
        .get(h.app.hearer.users.getByUsername('alice')?.id),
    ).toEqual({ n: 0 });
  });

  it('logout without a session is a harmless 204', async () => {
    await setup();
    expect((await call(h.app, undefined, 'POST', '/api/v1/auth/logout')).statusCode).toBe(204);
  });

  it('logout-all ends every session of the user only', async () => {
    await setup();
    await addUser(h.app, 'alice', ROLES.user);
    await addUser(h.app, 'bob', ROLES.user);
    const a1 = await login(h.app, 'alice');
    const a2 = await login(h.app, 'alice');
    const b1 = await login(h.app, 'bob');
    expect((await call(h.app, a1, 'POST', '/api/v1/auth/logout-all')).statusCode).toBe(204);
    expect((await call(h.app, a1, 'GET', '/api/v1/auth/me')).statusCode).toBe(401);
    expect((await call(h.app, a2, 'GET', '/api/v1/auth/me')).statusCode).toBe(401);
    expect((await call(h.app, b1, 'GET', '/api/v1/auth/me')).statusCode).toBe(200);
  });

  it('expires after 30 days and clears the stale cookie', async () => {
    await setup();
    await addUser(h.app, 'alice', ROLES.user);
    const alice = await login(h.app, 'alice');
    h.clock.t += 29 * DAY;
    // Not refreshed yet on this call? It is (older than a day), so it slides to 30 more days.
    expect((await call(h.app, alice, 'GET', '/api/v1/auth/me')).statusCode).toBe(200);
    h.clock.t += 31 * DAY;
    const expired = await call(h.app, alice, 'GET', '/api/v1/auth/me');
    expect(expired.statusCode).toBe(401);
    expect(expired.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
  });

  it('slides the expiry (and re-issues the cookie) at most once a day', async () => {
    await setup();
    await addUser(h.app, 'alice', ROLES.user);
    const alice = await login(h.app, 'alice');
    h.clock.t += DAY / 2;
    const early = await call(h.app, alice, 'GET', '/api/v1/auth/me');
    expect(early.statusCode).toBe(200);
    expect(early.cookies).toHaveLength(0);
    h.clock.t += DAY;
    const later = await call(h.app, alice, 'GET', '/api/v1/auth/me');
    expect(later.statusCode).toBe(200);
    const cookie = later.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie?.value).toBe(alice.cookie.split('=')[1]);
    // Cookie dates have one-second resolution.
    expect(cookie?.expires?.getTime()).toBe(Math.floor((h.clock.t + 30 * DAY) / 1000) * 1000);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
  });

  it('ignores garbage and stale cookies', async () => {
    await setup();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=${'z'.repeat(43)}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('kills sessions when the user is deleted', async () => {
    const admin = await setup();
    const id = await addUser(h.app, 'alice', ROLES.user);
    const alice = await login(h.app, 'alice');
    expect((await call(h.app, admin, 'DELETE', `/api/v1/users/${id}`)).statusCode).toBe(204);
    expect((await call(h.app, alice, 'GET', '/api/v1/auth/me')).statusCode).toBe(401);
  });
});

describe('GET /auth/me', () => {
  it('returns the user, permission names and the CSRF token', async () => {
    const admin = await setup();
    const res = await call(h.app, admin, 'GET', '/api/v1/auth/me');
    expect(res.statusCode).toBe(200);
    const body = res.json<MeResponse>();
    expect(body).toMatchObject({
      user: { username: 'admin' },
      permissions: ['ADMIN'],
      csrfToken: admin.csrf,
      authMethod: 'session',
    });
  });

  it('answers anonymous callers with the 401 envelope', async () => {
    await setup();
    const res = await call(h.app, undefined, 'GET', '/api/v1/auth/me');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'unauthorized', message: 'Authentication required' },
    });
  });
});

describe('CSRF', () => {
  it('requires the token on every mutating method for cookie sessions', async () => {
    const admin = await setup();
    const withoutToken = { cookie: admin.cookie };
    for (const [method, url] of [
      ['POST', '/api/v1/users'],
      ['PATCH', '/api/v1/users/x'],
      ['PUT', '/api/v1/settings/general'],
      ['DELETE', '/api/v1/users/x'],
    ] as const) {
      const res = await h.app.inject({ method, url, headers: withoutToken, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('csrf_invalid');
    }
  });

  it("rejects a wrong token, another session's token, and a near-miss", async () => {
    const admin = await setup();
    await addUser(h.app, 'alice', ROLES.user);
    const alice = await login(h.app, 'alice');
    const attempt = (token: string) =>
      h.app.inject({
        method: 'PUT',
        url: '/api/v1/settings/general',
        headers: { cookie: admin.cookie, 'x-csrf-token': token },
        payload: {},
      });
    expect((await attempt('wrong')).statusCode).toBe(403);
    expect((await attempt(alice.csrf)).statusCode).toBe(403);
    expect((await attempt(admin.csrf + 'x')).statusCode).toBe(403);
    expect((await attempt(admin.csrf.slice(1))).statusCode).toBe(403);
    expect((await attempt(admin.csrf)).statusCode).toBe(200);
  });

  it('does not require the token for safe methods', async () => {
    const admin = await setup();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('checks CSRF before running the handler (no side effects on failure)', async () => {
    const admin = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { cookie: admin.cookie },
      payload: { username: 'mallory', password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(h.app.hearer.users.getByUsername('mallory')).toBeUndefined();
  });

  it('exempts login so a stale session cookie cannot block signing in', async () => {
    await setup();
    await addUser(h.app, 'alice', ROLES.user);
    const alice = await login(h.app, 'alice');
    const res = await loginRequest('alice', PASSWORD, { cookie: alice.cookie });
    expect(res.statusCode).toBe(200);
  });
});

describe('API keys', () => {
  async function newKey(creds: Credentials, name = 'ci') {
    const res = await call(h.app, creds, 'POST', '/api/v1/auth/api-keys', { name });
    expect(res.statusCode).toBe(201);
    return res.json<{ key: { id: string; prefix: string }; secret: string }>();
  }

  it('creates, lists (never revealing the secret) and deletes keys', async () => {
    const admin = await setup();
    const { key, secret } = await newKey(admin);
    expect(secret).toMatch(/^hrr_[A-Za-z0-9_-]{43}$/);
    expect(key.prefix).toBe(secret.slice(0, 8));
    const list = await call(h.app, admin, 'GET', '/api/v1/auth/api-keys');
    expect(list.body).not.toContain(secret);
    expect(list.body).not.toMatch(/hash/);
    expect(list.json<{ items: { id: string; lastUsedAt: null }[] }>().items).toEqual([
      expect.objectContaining({ id: key.id, name: 'ci', lastUsedAt: null }),
    ]);
    expect((await call(h.app, admin, 'DELETE', `/api/v1/auth/api-keys/${key.id}`)).statusCode).toBe(
      204,
    );
    expect((await call(h.app, admin, 'DELETE', `/api/v1/auth/api-keys/${key.id}`)).statusCode).toBe(
      404,
    );
  });

  it('authenticates with X-Api-Key or a Bearer token, acting as the owner', async () => {
    const admin = await setup();
    const { secret } = await newKey(admin);
    for (const headers of [{ 'x-api-key': secret }, { authorization: `Bearer ${secret}` }]) {
      const res = await call(h.app, undefined, 'GET', '/api/v1/auth/me', undefined, headers);
      expect(res.statusCode).toBe(200);
      expect(res.json<MeResponse>()).toMatchObject({
        user: { username: 'admin' },
        csrfToken: null,
        authMethod: 'apiKey',
      });
    }
    const usedAt = h.app.hearer.database.sqlite
      .prepare('select last_used_at as t from api_keys')
      .get();
    expect(usedAt).toEqual({ t: h.clock.t });
  });

  it('is exempt from CSRF on mutating requests', async () => {
    const admin = await setup();
    const { secret } = await newKey(admin);
    const res = await call(
      h.app,
      undefined,
      'POST',
      '/api/v1/users',
      { username: 'viaapikey', password: PASSWORD },
      { 'x-api-key': secret },
    );
    expect(res.statusCode).toBe(201);
  });

  it("applies the owner's permissions, not more", async () => {
    const admin = await setup();
    await addUser(h.app, 'alice', ROLES.user);
    const alice = await login(h.app, 'alice');
    const { secret } = await newKey(alice);
    const asKey = (url: string) =>
      call(h.app, undefined, 'GET', url, undefined, { 'x-api-key': secret });
    expect((await asKey('/api/v1/auth/me')).statusCode).toBe(200);
    expect((await asKey('/api/v1/users')).statusCode).toBe(403);
    // Raising the owner's permissions takes effect immediately.
    const id = h.app.hearer.users.getByUsername('alice')?.id ?? '';
    await call(h.app, admin, 'PATCH', `/api/v1/users/${id}`, { permissions: ROLES.manager });
    expect((await asKey('/api/v1/users')).statusCode).toBe(200);
  });

  it('rejects a deleted key, a bad key, and a bad key next to a valid cookie', async () => {
    const admin = await setup();
    const { key, secret } = await newKey(admin);
    await call(h.app, admin, 'DELETE', `/api/v1/auth/api-keys/${key.id}`);
    const gone = await call(h.app, undefined, 'GET', '/api/v1/auth/me', undefined, {
      'x-api-key': secret,
    });
    expect(gone.statusCode).toBe(401);
    // A presented-but-invalid key never falls back to the cookie.
    const mixed = await call(h.app, admin, 'GET', '/api/v1/auth/me', undefined, {
      'x-api-key': 'hrr_bogus',
    });
    expect(mixed.statusCode).toBe(401);
  });

  it('cannot be used to mint keys or change the password', async () => {
    const admin = await setup();
    const { secret } = await newKey(admin);
    const headers = { 'x-api-key': secret };
    for (const [method, url, payload] of [
      ['POST', '/api/v1/auth/api-keys', { name: 'more' }],
      ['GET', '/api/v1/auth/api-keys', undefined],
      [
        'POST',
        '/api/v1/auth/password',
        { currentPassword: PASSWORD, newPassword: 'another-pass-1' },
      ],
    ] as const) {
      const res = await call(h.app, undefined, method, url, payload, headers);
      expect(res.statusCode, url).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('session_required');
    }
  });

  it("keeps one user from deleting another user's key", async () => {
    const admin = await setup();
    await addUser(h.app, 'alice', ROLES.user);
    const alice = await login(h.app, 'alice');
    const { key } = await newKey(admin);
    expect((await call(h.app, alice, 'DELETE', `/api/v1/auth/api-keys/${key.id}`)).statusCode).toBe(
      404,
    );
  });

  it('caps the number of keys per user', async () => {
    const admin = await setup();
    for (let i = 0; i < 25; i++) await newKey(admin, `k${String(i)}`);
    const res = await call(h.app, admin, 'POST', '/api/v1/auth/api-keys', { name: 'extra' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('too_many_api_keys');
  });
});

describe('POST /auth/password', () => {
  const change = (creds: Credentials, currentPassword: string, newPassword: string) =>
    call(h.app, creds, 'POST', '/api/v1/auth/password', { currentPassword, newPassword });

  it('changes the password, keeps this session and revokes the others', async () => {
    await setup();
    await addUser(h.app, 'alice', ROLES.user);
    const laptop = await login(h.app, 'alice');
    const phone = await login(h.app, 'alice');
    const res = await change(laptop, PASSWORD, 'a brand new passphrase');
    expect(res.statusCode).toBe(204);
    expect((await call(h.app, laptop, 'GET', '/api/v1/auth/me')).statusCode).toBe(200);
    expect((await call(h.app, phone, 'GET', '/api/v1/auth/me')).statusCode).toBe(401);
    expect((await loginRequest('alice', PASSWORD)).statusCode).toBe(401);
    expect((await loginRequest('alice', 'a brand new passphrase')).statusCode).toBe(200);
  });

  it('requires the correct current password and a valid new one', async () => {
    await setup();
    await addUser(h.app, 'alice', ROLES.user);
    const alice = await login(h.app, 'alice');
    const wrong = await change(alice, 'not my password', 'a brand new passphrase');
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ error: { code: string } }>().error.code).toBe('invalid_current_password');
    expect((await change(alice, PASSWORD, 'short')).statusCode).toBe(400);
    expect((await change(alice, PASSWORD, 'x'.repeat(129))).statusCode).toBe(400);
    expect((await loginRequest('alice', PASSWORD)).statusCode).toBe(200);
  });

  it('is unavailable to external accounts', async () => {
    await setup();
    const { user } = h.app.hearer.users.findOrCreateExternalUser('oidc', 'sub-1', {
      username: 'sso',
    });
    const { id } = h.app.hearer.sessions.create(user.id);
    const csrf = h.app.hearer.sessions.validate(id)?.csrfToken ?? '';
    const res = await change(
      { cookie: `${SESSION_COOKIE}=${id}`, csrf },
      PASSWORD,
      'a brand new passphrase',
    );
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('password_not_supported');
  });
});
