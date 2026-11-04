import { Permission, REDACTED_SECRET, type UserDto, type UserListResponse } from '@hearer/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PASSWORD,
  ROLES,
  addUser,
  call,
  completeSetup,
  createHarness,
  login,
  type Credentials,
  type Harness,
} from './helpers/auth.ts';

let h: Harness;
let admin: Credentials;
beforeEach(async () => {
  h = await createHarness();
  admin = await completeSetup(h);
});
afterEach(async () => {
  await h.cleanup();
});

const code = (res: { json: () => unknown }) =>
  (res.json() as { error: { code: string } }).error.code;
const idOf = (username: string) => h.app.hearer.users.getByUsername(username)?.id ?? 'missing';
const MANAGER_USERS = Permission.MANAGE_USERS | Permission.REQUEST | Permission.UPLOAD;

describe('role matrix: users and settings routes', () => {
  const roles = {
    anonymous: undefined,
    user: ROLES.user,
    usersOnly: Permission.MANAGE_USERS,
    settingsOnly: Permission.MANAGE_SETTINGS,
    manager: ROLES.manager,
    admin: ROLES.admin,
  } as const;
  type Role = keyof typeof roles;
  const usersAllowed: Role[] = ['usersOnly', 'manager', 'admin'];
  const settingsAllowed: Role[] = ['settingsOnly', 'manager', 'admin'];

  async function credsFor(role: Role): Promise<Credentials | undefined> {
    const permissions = roles[role];
    if (permissions === undefined) return undefined;
    await addUser(h.app, `role_${role}`, permissions);
    return login(h.app, `role_${role}`);
  }

  for (const role of Object.keys(roles) as Role[]) {
    it(`enforces permissions for ${role}`, async () => {
      const creds = await credsFor(role);
      const victim = await addUser(h.app, 'victim', ROLES.user);
      const userRoutes: [string, string, unknown][] = [
        ['GET', '/api/v1/users', undefined],
        ['GET', `/api/v1/users/${victim}`, undefined],
        ['POST', '/api/v1/users', { username: `new_${role}`, password: PASSWORD }],
        ['PATCH', `/api/v1/users/${victim}`, { displayName: 'V' }],
        ['POST', `/api/v1/users/${victim}/password`, { newPassword: 'another good one' }],
        ['DELETE', `/api/v1/users/${victim}`, undefined],
      ];
      for (const [method, url, body] of userRoutes) {
        const res = await call(h.app, creds, method as 'GET', url, body);
        const expected = creds === undefined ? 401 : usersAllowed.includes(role) ? null : 403;
        if (expected === null) {
          expect(res.statusCode, `${role} ${method} ${url}`).toBeLessThan(300);
        } else {
          expect(res.statusCode, `${role} ${method} ${url}`).toBe(expected);
          expect(code(res)).toBe(expected === 401 ? 'unauthorized' : 'forbidden');
        }
      }
      const settingsRoutes: [string, string, unknown][] = [
        ['GET', '/api/v1/settings', undefined],
        ['GET', '/api/v1/settings/library', undefined],
        ['PUT', '/api/v1/settings/library', { namingTemplate: '{title}.{ext}' }],
      ];
      for (const [method, url, body] of settingsRoutes) {
        const res = await call(h.app, creds, method as 'GET', url, body);
        const expected = creds === undefined ? 401 : settingsAllowed.includes(role) ? 200 : 403;
        expect(res.statusCode, `${role} ${method} ${url}`).toBe(expected);
      }
    });
  }
});

describe('users CRUD', () => {
  it('creates a local user with the configured default permissions', async () => {
    h.app.hearer.settings.set('general', {
      ...h.app.hearer.settings.get('general'),
      defaultPermissions: Permission.REQUEST,
    });
    const res = await call(h.app, admin, 'POST', '/api/v1/users', {
      username: 'Newbie',
      password: PASSWORD,
      email: 'n@example.com',
      displayName: 'New Bie',
    });
    expect(res.statusCode).toBe(201);
    const user = res.json<UserDto>();
    expect(user).toMatchObject({
      username: 'Newbie',
      email: 'n@example.com',
      displayName: 'New Bie',
      authType: 'local',
      permissions: Permission.REQUEST,
    });
    expect(res.body).not.toMatch(/argon2|passwordHash|password_hash/);
    expect((await login(h.app, 'newbie')).csrf).toBeTruthy();
  });

  it('rejects duplicate usernames case-insensitively and bad input', async () => {
    await addUser(h.app, 'taken', ROLES.user);
    const dup = await call(h.app, admin, 'POST', '/api/v1/users', {
      username: 'TAKEN',
      password: PASSWORD,
    });
    expect(dup.statusCode).toBe(409);
    expect(code(dup)).toBe('username_taken');
    for (const body of [
      { username: 'x', password: PASSWORD },
      { username: 'okname', password: 'short' },
      { username: 'okname', password: PASSWORD, permissions: 1 << 20 },
      { username: 'okname', password: PASSWORD, email: 'nope' },
    ]) {
      expect((await call(h.app, admin, 'POST', '/api/v1/users', body)).statusCode).toBe(400);
    }
  });

  it('lists with pagination and search, and never leaks hashes', async () => {
    for (const name of ['anna', 'bob', 'carla', 'dave', 'erin'])
      await addUser(h.app, name, ROLES.user);
    h.app.hearer.users.update(idOf('bob'), {
      email: 'robert@example.org',
      displayName: 'Robert B',
    });
    const page1 = (
      await call(h.app, admin, 'GET', '/api/v1/users?pageSize=2&page=1')
    ).json<UserListResponse>();
    expect(page1).toMatchObject({ total: 6, page: 1, pageSize: 2 });
    expect(page1.items.map((u) => u.username)).toEqual(['admin', 'anna']);
    const page3 = (
      await call(h.app, admin, 'GET', '/api/v1/users?pageSize=2&page=3')
    ).json<UserListResponse>();
    expect(page3.items.map((u) => u.username)).toEqual(['dave', 'erin']);
    const beyond = (
      await call(h.app, admin, 'GET', '/api/v1/users?pageSize=2&page=9')
    ).json<UserListResponse>();
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(6);

    const search = async (q: string) =>
      (
        await call(h.app, admin, 'GET', `/api/v1/users?q=${encodeURIComponent(q)}`)
      ).json<UserListResponse>();
    expect((await search('ROBERT')).items.map((u) => u.username)).toEqual(['bob']);
    expect((await search('example.org')).items.map((u) => u.username)).toEqual(['bob']);
    expect((await search('AR')).items.map((u) => u.username)).toEqual(['carla']);
    expect((await search('%')).total).toBe(0);
    expect((await search('_')).total).toBe(0);
    const all = await call(h.app, admin, 'GET', '/api/v1/users');
    expect(all.body).not.toMatch(/argon2|passwordHash|password_hash/);
    expect((await call(h.app, admin, 'GET', '/api/v1/users?pageSize=101')).statusCode).toBe(400);
    expect((await call(h.app, admin, 'GET', '/api/v1/users?page=0')).statusCode).toBe(400);
  });

  it('gets one user and 404s on unknown ids', async () => {
    const id = await addUser(h.app, 'anna', ROLES.user);
    expect((await call(h.app, admin, 'GET', `/api/v1/users/${id}`)).json<UserDto>().username).toBe(
      'anna',
    );
    const missing = await call(h.app, admin, 'GET', '/api/v1/users/nope');
    expect(missing.statusCode).toBe(404);
    expect(code(missing)).toBe('not_found');
  });

  it('updates profile, permissions and quotas, and clears quotas with null', async () => {
    const id = await addUser(h.app, 'anna', ROLES.user);
    const res = await call(h.app, admin, 'PATCH', `/api/v1/users/${id}`, {
      displayName: 'Anna A',
      email: 'anna@example.com',
      permissions: ROLES.user | Permission.REQUEST_ARTIST,
      requestQuotaLimit: 5,
      requestQuotaDays: 7,
      uploadQuotaMb: 500,
      uploadQuotaDays: 30,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<UserDto>()).toMatchObject({
      displayName: 'Anna A',
      email: 'anna@example.com',
      permissions: ROLES.user | Permission.REQUEST_ARTIST,
      requestQuotaLimit: 5,
      uploadQuotaMb: 500,
    });
    const cleared = await call(h.app, admin, 'PATCH', `/api/v1/users/${id}`, {
      requestQuotaLimit: null,
      email: null,
    });
    expect(cleared.json<UserDto>()).toMatchObject({
      requestQuotaLimit: null,
      email: null,
      uploadQuotaMb: 500,
    });
    for (const body of [
      {},
      { permissions: -1 },
      { requestQuotaDays: 0 },
      { email: 'bad' },
      { unknown: 1 },
    ]) {
      expect(
        (await call(h.app, admin, 'PATCH', `/api/v1/users/${id}`, body)).statusCode,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect(
      (await call(h.app, admin, 'PATCH', '/api/v1/users/nope', { displayName: 'x' })).statusCode,
    ).toBe(404);
  });

  it('deletes users but not yourself', async () => {
    const id = await addUser(h.app, 'anna', ROLES.user);
    expect((await call(h.app, admin, 'DELETE', `/api/v1/users/${id}`)).statusCode).toBe(204);
    expect((await call(h.app, admin, 'GET', `/api/v1/users/${id}`)).statusCode).toBe(404);
    expect((await call(h.app, admin, 'DELETE', `/api/v1/users/${id}`)).statusCode).toBe(404);
    const self = await call(h.app, admin, 'DELETE', `/api/v1/users/${idOf('admin')}`);
    expect(self.statusCode).toBe(409);
    expect(code(self)).toBe('cannot_delete_self');
  });

  it('resets a local password and signs the user out everywhere', async () => {
    const id = await addUser(h.app, 'anna', ROLES.user);
    const anna = await login(h.app, 'anna');
    const res = await call(h.app, admin, 'POST', `/api/v1/users/${id}/password`, {
      newPassword: 'brand new password',
    });
    expect(res.statusCode).toBe(204);
    expect((await call(h.app, anna, 'GET', '/api/v1/auth/me')).statusCode).toBe(401);
    const old = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'anna', password: PASSWORD },
    });
    expect(old.statusCode).toBe(401);
    expect((await login(h.app, 'anna', 'brand new password')).csrf).toBeTruthy();
    expect(
      (await call(h.app, admin, 'POST', `/api/v1/users/${id}/password`, { newPassword: 'short' }))
        .statusCode,
    ).toBe(400);
  });

  it('refuses password resets for external and for your own account', async () => {
    const { user } = h.app.hearer.users.findOrCreateExternalUser('jellyfin', 'jf', {
      username: 'jelly',
    });
    const ext = await call(h.app, admin, 'POST', `/api/v1/users/${user.id}/password`, {
      newPassword: 'brand new password',
    });
    expect(ext.statusCode).toBe(400);
    expect(code(ext)).toBe('password_not_supported');
    const self = await call(h.app, admin, 'POST', `/api/v1/users/${idOf('admin')}/password`, {
      newPassword: 'brand new password',
    });
    expect(code(self)).toBe('use_password_change');
  });
});

describe('privilege escalation', () => {
  let manager: Credentials;
  beforeEach(async () => {
    await addUser(h.app, 'mgr', MANAGER_USERS);
    manager = await login(h.app, 'mgr');
  });

  it('forbids granting ADMIN or bits the grantor lacks (create)', async () => {
    for (const permissions of [
      Permission.ADMIN,
      Permission.MANAGE_REQUESTS,
      MANAGER_USERS | Permission.MANAGE_SETTINGS,
    ]) {
      const res = await call(h.app, manager, 'POST', '/api/v1/users', {
        username: `esc${String(permissions)}`,
        password: PASSWORD,
        permissions,
      });
      expect(res.statusCode, String(permissions)).toBe(403);
      expect(code(res)).toBe('privilege_escalation');
    }
    expect(h.app.hearer.users.getByUsername(`esc${String(Permission.ADMIN)}`)).toBeUndefined();
    const ok = await call(h.app, manager, 'POST', '/api/v1/users', {
      username: 'fine',
      password: PASSWORD,
      permissions: Permission.REQUEST | Permission.UPLOAD,
    });
    expect(ok.statusCode).toBe(201);
  });

  it('forbids promoting yourself or others (update)', async () => {
    const victim = await addUser(h.app, 'victim', ROLES.user);
    for (const [id, permissions] of [
      [idOf('mgr'), MANAGER_USERS | Permission.ADMIN],
      [idOf('mgr'), MANAGER_USERS | Permission.MANAGE_SETTINGS],
      [victim, ROLES.user | Permission.MANAGE_USERS | Permission.MANAGE_REQUESTS],
      [victim, Permission.ADMIN],
    ] as const) {
      const res = await call(h.app, manager, 'PATCH', `/api/v1/users/${id}`, { permissions });
      expect(res.statusCode).toBe(403);
      expect(code(res)).toBe('privilege_escalation');
    }
    expect(h.app.hearer.users.get(victim)?.permissions).toBe(ROLES.user);
    // Granting a bit the manager does hold is fine, and so is leaving other bits untouched.
    const ok = await call(h.app, manager, 'PATCH', `/api/v1/users/${victim}`, {
      permissions: ROLES.user | Permission.MANAGE_USERS,
    });
    expect(ok.statusCode).toBe(200);
  });

  it('forbids touching users that outrank you', async () => {
    const adminId = idOf('admin');
    const attempts = [
      call(h.app, manager, 'PATCH', `/api/v1/users/${adminId}`, { displayName: 'pwned' }),
      call(h.app, manager, 'POST', `/api/v1/users/${adminId}/password`, {
        newPassword: 'taken over now',
      }),
      call(h.app, manager, 'DELETE', `/api/v1/users/${adminId}`),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode).toBe(403);
      expect(code(res)).toBe('privilege_escalation');
    }
    // A user holding bits the manager lacks is also off limits.
    const other = await addUser(h.app, 'other', Permission.MANAGE_REQUESTS);
    expect((await call(h.app, manager, 'DELETE', `/api/v1/users/${other}`)).statusCode).toBe(403);
    expect(h.app.hearer.users.get(adminId)?.displayName).toBeNull();
    // The admin can still sign in with the old password.
    expect((await login(h.app, 'admin')).csrf).toBeTruthy();
  });

  it('lets an administrator grant anything', async () => {
    const id = await addUser(h.app, 'anna', ROLES.user);
    const res = await call(h.app, admin, 'PATCH', `/api/v1/users/${id}`, {
      permissions: Permission.ADMIN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<UserDto>().permissions).toBe(Permission.ADMIN);
  });
});

describe('last administrator', () => {
  it('cannot be demoted or deleted', async () => {
    const adminId = idOf('admin');
    const demote = await call(h.app, admin, 'PATCH', `/api/v1/users/${adminId}`, {
      permissions: ROLES.user,
    });
    expect(demote.statusCode).toBe(409);
    expect(code(demote)).toBe('last_admin');
    expect(() => h.app.hearer.users.delete(adminId)).toThrow(/at least one administrator/);
    // Editing other fields of the last admin is fine, and keeping ADMIN is fine.
    const ok = await call(h.app, admin, 'PATCH', `/api/v1/users/${adminId}`, {
      displayName: 'Boss',
      permissions: Permission.ADMIN | Permission.REQUEST,
    });
    expect(ok.statusCode).toBe(200);
  });

  it('allows demoting or deleting an admin while another remains', async () => {
    const second = await addUser(h.app, 'admin2', ROLES.admin);
    const demote = await call(h.app, admin, 'PATCH', `/api/v1/users/${second}`, {
      permissions: ROLES.user,
    });
    expect(demote.statusCode).toBe(200);
    // Back to a single admin: now the original is protected again.
    expect(
      (await call(h.app, admin, 'PATCH', `/api/v1/users/${idOf('admin')}`, { permissions: 0 }))
        .statusCode,
    ).toBe(409);
    const third = await addUser(h.app, 'admin3', ROLES.admin);
    expect((await call(h.app, admin, 'DELETE', `/api/v1/users/${third}`)).statusCode).toBe(204);
  });

  it('a second admin cannot remove the first once alone', async () => {
    const second = await addUser(h.app, 'admin2', ROLES.admin);
    const other = await login(h.app, 'admin2');
    expect((await call(h.app, other, 'DELETE', `/api/v1/users/${idOf('admin')}`)).statusCode).toBe(
      204,
    );
    expect((await call(h.app, other, 'DELETE', `/api/v1/users/${second}`)).statusCode).toBe(409);
  });
});

describe('findOrCreateExternalUser', () => {
  it('creates once with default permissions, then refreshes the profile', () => {
    const { users } = h.app.hearer;
    const first = users.findOrCreateExternalUser('jellyfin', 'jf-1', {
      username: 'jelly',
      email: 'j@example.com',
      displayName: 'Jelly',
    });
    expect(first.created).toBe(true);
    expect(first.user).toMatchObject({
      authType: 'jellyfin',
      externalId: 'jf-1',
      passwordHash: null,
      permissions: h.app.hearer.settings.get('general').defaultPermissions,
    });
    const second = users.findOrCreateExternalUser('jellyfin', 'jf-1', {
      username: 'renamed',
      displayName: 'New Name',
    });
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.user).toMatchObject({
      username: 'jelly',
      displayName: 'New Name',
      email: 'j@example.com',
    });
  });

  it('keeps identities per provider and de-duplicates usernames', () => {
    const { users } = h.app.hearer;
    const a = users.findOrCreateExternalUser('jellyfin', 'same-id', { username: 'sam' });
    const b = users.findOrCreateExternalUser('oidc', 'same-id', { username: 'sam' });
    const c = users.findOrCreateExternalUser('oidc', 'other', { username: 'SAM' });
    expect(new Set([a.user.id, b.user.id, c.user.id]).size).toBe(3);
    expect([a.user.username, b.user.username, c.user.username]).toEqual(['sam', 'sam-2', 'SAM-3']);
    const local = users.getByUsername('admin');
    expect(local?.authType).toBe('local');
  });
});

describe('settings API', () => {
  it('masks secrets everywhere and never returns plaintext', async () => {
    h.app.hearer.settings.set('mediaServer', {
      ...h.app.hearer.settings.get('mediaServer'),
      url: 'http://jf:8096',
      apiKey: 'jf-secret-key-123',
    });
    h.app.hearer.settings.set('auth', {
      ...h.app.hearer.settings.get('auth'),
      oidc: { ...h.app.hearer.settings.get('auth').oidc, clientSecret: 'oidc-secret-xyz' },
    });
    const all = await call(h.app, admin, 'GET', '/api/v1/settings');
    expect(all.statusCode).toBe(200);
    expect(all.body).not.toContain('jf-secret-key-123');
    expect(all.body).not.toContain('oidc-secret-xyz');
    const body = all.json<{
      mediaServer: { apiKey: string; url: string };
      auth: { oidc: { clientSecret: string } };
      metadata: { acoustIdApiKey: string };
    }>();
    expect(body.mediaServer).toMatchObject({ apiKey: REDACTED_SECRET, url: 'http://jf:8096' });
    expect(body.auth.oidc.clientSecret).toBe(REDACTED_SECRET);
    expect(body.metadata.acoustIdApiKey).toBe('');
    const one = await call(h.app, admin, 'GET', '/api/v1/settings/mediaServer');
    expect(one.json<{ apiKey: string }>().apiKey).toBe(REDACTED_SECRET);
  });

  it('keeps a secret when the masked value is sent back, and replaces it otherwise', async () => {
    h.app.hearer.settings.set('mediaServer', {
      ...h.app.hearer.settings.get('mediaServer'),
      apiKey: 'original-key',
    });
    const keep = await call(h.app, admin, 'PUT', '/api/v1/settings/mediaServer', {
      url: 'http://jf:8096',
      apiKey: REDACTED_SECRET,
    });
    expect(keep.statusCode).toBe(200);
    expect(keep.json<{ apiKey: string; url: string }>()).toMatchObject({
      apiKey: REDACTED_SECRET,
      url: 'http://jf:8096',
    });
    expect(h.app.hearer.settings.get('mediaServer').apiKey).toBe('original-key');
    const replace = await call(h.app, admin, 'PUT', '/api/v1/settings/mediaServer', {
      url: 'http://jf:8096',
      apiKey: 'rotated-key',
    });
    expect(replace.body).not.toContain('rotated-key');
    expect(h.app.hearer.settings.get('mediaServer').apiKey).toBe('rotated-key');
    const stored = h.app.hearer.database.sqlite
      .prepare("select value_json as v from settings where key = 'mediaServer'")
      .get() as { v: string };
    expect(stored.v).not.toContain('rotated-key');
  });

  it('validates against the shared catalog and 404s unknown sections', async () => {
    const bad = await call(h.app, admin, 'PUT', '/api/v1/settings/uploads', {
      maxFileSizeMb: -5,
      coverMaxPx: 'big',
    });
    expect(bad.statusCode).toBe(400);
    expect(code(bad)).toBe('validation_error');
    expect(
      bad.json<{ error: { details: unknown[] } }>().error.details.length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      (await call(h.app, admin, 'PUT', '/api/v1/settings/general', { defaultPermissions: 1 << 25 }))
        .statusCode,
    ).toBe(400);
    expect((await call(h.app, admin, 'GET', '/api/v1/settings/nope')).statusCode).toBe(404);
    expect((await call(h.app, admin, 'PUT', '/api/v1/settings/nope', {})).statusCode).toBe(404);
    expect((await call(h.app, admin, 'PUT', '/api/v1/settings/uploads', [1])).statusCode).toBe(400);
  });

  it('never lets general clear setupComplete', async () => {
    const res = await call(h.app, admin, 'PUT', '/api/v1/settings/general', {
      appTitle: 'Renamed',
    });
    expect(res.json()).toMatchObject({ appTitle: 'Renamed', setupComplete: true });
    expect((await call(h.app, admin, 'GET', '/api/v1/users')).statusCode).toBe(200);
  });

  it('refuses to disable every sign-in method', async () => {
    const lockout = await call(h.app, admin, 'PUT', '/api/v1/settings/auth', {
      localEnabled: false,
    });
    expect(lockout.statusCode).toBe(400);
    expect(code(lockout)).toBe('would_lock_out');
    expect(h.app.hearer.settings.get('auth').localEnabled).toBe(true);
    const ok = await call(h.app, admin, 'PUT', '/api/v1/settings/auth', {
      localEnabled: false,
      jellyfinEnabled: true,
    });
    expect(ok.statusCode).toBe(200);
  });
});
