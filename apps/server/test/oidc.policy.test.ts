import { Permission } from '@hearer/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  call,
  completeSetup,
  createHarness,
  type Credentials,
  type Harness,
} from './helpers/auth.ts';
import {
  DEFAULT_USER,
  configureOidc,
  sessionCookie,
  ssoLogin,
  startMockIdp,
  type IdpClaims,
  type MockIdp,
} from './helpers/mock-idp.ts';

let h: Harness | undefined;
let idp: MockIdp | undefined;
afterEach(async () => {
  await h?.cleanup();
  await idp?.close();
  h = undefined;
  idp = undefined;
});

interface Booted {
  h: Harness;
  idp: MockIdp;
  admin: Credentials;
}
async function boot(
  oidc: Record<string, unknown> = {},
  user: IdpClaims = DEFAULT_USER,
): Promise<Booted> {
  idp = await startMockIdp();
  idp.user = { ...user };
  h = await createHarness();
  const admin = await completeSetup(h);
  await configureOidc(h, admin, idp, oidc);
  return { h, idp, admin };
}

const errorOf = (location: unknown): string | null =>
  new URL(String(location), 'http://x').searchParams.get('error');

const meOf = async (app: Harness['app'], cookie: string) =>
  (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).json<{
    user: { id: string; username: string; authType: string; permissions: number };
  }>().user;

const addLocal = (b: Booted, username: string, email: string | null, permissions: number) =>
  b.h.app.hearer.users.createLocal({ username, passwordHash: 'unused', email, permissions });

describe('autoCreateUsers', () => {
  it('denies an unknown user when auto-creation is off, creating nothing', async () => {
    const b = await boot({ autoCreateUsers: false });
    const { res } = await ssoLogin(b.h.app);
    expect(errorOf(res.headers.location)).toBe('signup_disabled');
    expect(sessionCookie(res)).toBe('');
    expect(b.h.app.hearer.users.getExternal('oidc', 'idp-user-1')).toBeUndefined();
  });

  it('still lets an existing OIDC user in after auto-creation is switched off', async () => {
    const b = await boot();
    expect((await ssoLogin(b.h.app)).res.headers.location).toBe('/');
    await configureOidc(b.h, b.admin, b.idp, { autoCreateUsers: false });
    const second = await ssoLogin(b.h.app);
    expect(second.res.headers.location).toBe('/');
    expect(sessionCookie(second.res)).not.toBe('');
  });

  it('gives a new user the default permissions and a unique, valid username', async () => {
    const b = await boot({}, { ...DEFAULT_USER, preferred_username: 'admin' });
    const { res } = await ssoLogin(b.h.app);
    const me = await meOf(b.h.app, sessionCookie(res));
    expect(me.username).toBe('admin-2'); // "admin" belongs to the local admin
    expect(me.permissions).toBe(b.h.app.hearer.settings.get('general').defaultPermissions);
    expect(me.permissions & Permission.ADMIN).toBe(0);
  });

  it('sanitizes odd usernames and falls back to the email, then the subject', async () => {
    const b = await boot(
      {},
      { sub: 'sub-9', preferred_username: 'Zoë Müller!', email: 'zm@example.com' },
    );
    const me = await meOf(b.h.app, sessionCookie((await ssoLogin(b.h.app)).res));
    expect(me.username).toMatch(/^[A-Za-z0-9][A-Za-z0-9._@+-]{2,63}$/);
  });

  it('falls back to the subject when there is no username or email', async () => {
    const c = await boot({}, { sub: 'sub-10' });
    expect((await meOf(c.h.app, sessionCookie((await ssoLogin(c.h.app)).res))).username).toBe(
      'sub-10',
    );
  });

  it('honors usernameClaim and emailClaim', async () => {
    const b = await boot(
      { usernameClaim: 'nickname', emailClaim: 'mail' },
      { sub: 's1', nickname: 'ally', mail: 'ally@example.com', email_verified: true },
    );
    const me = await meOf(b.h.app, sessionCookie((await ssoLogin(b.h.app)).res));
    expect(me.username).toBe('ally');
    expect(b.h.app.hearer.users.getByUsername('ally')?.email).toBe('ally@example.com');
  });

  it('does not store an unverified email', async () => {
    const b = await boot({}, { ...DEFAULT_USER, email_verified: false });
    await ssoLogin(b.h.app);
    expect(b.h.app.hearer.users.getExternal('oidc', 'idp-user-1')?.email).toBeNull();
  });
});

describe('allowedGroups', () => {
  const settings = { groupsClaim: 'groups', allowedGroups: ['hearer-users'] };

  it('lets members of an allowed group in', async () => {
    const b = await boot(settings, { ...DEFAULT_USER, groups: ['other', 'hearer-users'] });
    expect((await ssoLogin(b.h.app)).res.headers.location).toBe('/');
  });

  it('denies a user outside every allowed group, and one without the claim', async () => {
    const b = await boot(settings, { ...DEFAULT_USER, groups: ['other'] });
    const denied = await ssoLogin(b.h.app);
    expect(errorOf(denied.res.headers.location)).toBe('not_allowed');
    expect(sessionCookie(denied.res)).toBe('');
    expect(b.h.app.hearer.users.getExternal('oidc', 'idp-user-1')).toBeUndefined();
    b.idp.user = { sub: 'idp-user-2', preferred_username: 'nogroups' };
    expect(errorOf((await ssoLogin(b.h.app)).res.headers.location)).toBe('not_allowed');
  });

  it('applies to existing users too (removal from the group locks them out)', async () => {
    const b = await boot(settings, { ...DEFAULT_USER, groups: ['hearer-users'] });
    await ssoLogin(b.h.app);
    b.idp.user = { ...DEFAULT_USER, groups: [] };
    expect(errorOf((await ssoLogin(b.h.app)).res.headers.location)).toBe('not_allowed');
  });

  it('accepts a single-string claim and Keycloak-style /path group names', async () => {
    const b = await boot(settings, { ...DEFAULT_USER, groups: '/hearer-users' });
    expect((await ssoLogin(b.h.app)).res.headers.location).toBe('/');
  });
});

describe('adminGroup', () => {
  const settings = { groupsClaim: 'groups', adminGroup: 'hearer-admins' };

  it('grants ADMIN to members, and only to them', async () => {
    const b = await boot(settings, { ...DEFAULT_USER, groups: ['hearer-admins'] });
    const me = await meOf(b.h.app, sessionCookie((await ssoLogin(b.h.app)).res));
    expect(me.permissions & Permission.ADMIN).toBe(Permission.ADMIN);

    b.idp.user = { sub: 'idp-user-2', preferred_username: 'bob', groups: ['staff'] };
    const bob = await meOf(b.h.app, sessionCookie((await ssoLogin(b.h.app)).res));
    expect(bob.permissions & Permission.ADMIN).toBe(0);
  });

  it('promotes an existing user who joins the group later, but never demotes', async () => {
    const b = await boot(settings, { ...DEFAULT_USER, groups: [] });
    const first = await meOf(b.h.app, sessionCookie((await ssoLogin(b.h.app)).res));
    expect(first.permissions & Permission.ADMIN).toBe(0);
    b.idp.user = { ...DEFAULT_USER, groups: ['hearer-admins'] };
    await ssoLogin(b.h.app);
    expect(b.h.app.hearer.users.get(first.id)?.permissions ?? 0).toSatisfy(
      (p: number) => (p & Permission.ADMIN) !== 0,
    );
    b.idp.user = { ...DEFAULT_USER, groups: [] };
    await ssoLogin(b.h.app);
    expect((b.h.app.hearer.users.get(first.id)?.permissions ?? 0) & Permission.ADMIN).toBe(
      Permission.ADMIN,
    );
  });

  it('is rejected at save time without a groupsClaim', async () => {
    const b = await boot();
    const res = await call(b.h.app, b.admin, 'PUT', '/api/v1/settings/auth', {
      oidc: { enabled: true, adminGroup: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('linkExistingByEmail', () => {
  it('is off by default: the same email gets a separate account and the local one is untouched', async () => {
    const b = await boot();
    const local = addLocal(b, 'alice-local', 'alice@example.com', Permission.REQUEST);
    const { res } = await ssoLogin(b.h.app);
    const me = await meOf(b.h.app, sessionCookie(res));
    expect(me.id).not.toBe(local.id);
    expect(me.authType).toBe('oidc');
    expect(b.h.app.hearer.users.get(local.id)?.authType).toBe('local');
  });

  it('links to a matching local account when on and the email is verified', async () => {
    const b = await boot({ linkExistingByEmail: true });
    const local = addLocal(b, 'alice-local', 'Alice@Example.com', Permission.REQUEST);
    const { res } = await ssoLogin(b.h.app);
    const me = await meOf(b.h.app, sessionCookie(res));
    expect(me.id).toBe(local.id);
    expect(me.authType).toBe('local'); // the account itself is not rewritten
  });

  it('does not link when the IdP says the email is unverified (or does not say)', async () => {
    const b = await boot({ linkExistingByEmail: true }, { ...DEFAULT_USER, email_verified: false });
    const local = addLocal(b, 'alice-local', 'alice@example.com', Permission.REQUEST);
    const me = await meOf(b.h.app, sessionCookie((await ssoLogin(b.h.app)).res));
    expect(me.id).not.toBe(local.id);
    const { email_verified: _omit, ...noFlag } = DEFAULT_USER;
    b.idp.user = { ...noFlag, sub: 'idp-user-3', preferred_username: 'carol' };
    const carol = await meOf(b.h.app, sessionCookie((await ssoLogin(b.h.app)).res));
    expect(carol.id).not.toBe(local.id);
  });

  it('never links an administrator unless linkAdminAccounts is also on', async () => {
    const b = await boot({ linkExistingByEmail: true });
    const adminRow = addLocal(b, 'boss', 'alice@example.com', Permission.ADMIN);
    const denied = await ssoLogin(b.h.app);
    expect(errorOf(denied.res.headers.location)).toBe('link_denied');
    expect(sessionCookie(denied.res)).toBe('');
    await configureOidc(b.h, b.admin, b.idp, {
      linkExistingByEmail: true,
      linkAdminAccounts: true,
    });
    const allowed = await meOf(b.h.app, sessionCookie((await ssoLogin(b.h.app)).res));
    expect(allowed.id).toBe(adminRow.id);
  });

  it('refuses an ambiguous match', async () => {
    const b = await boot({ linkExistingByEmail: true });
    addLocal(b, 'one', 'alice@example.com', Permission.REQUEST);
    addLocal(b, 'two', 'alice@example.com', Permission.REQUEST);
    expect(errorOf((await ssoLogin(b.h.app)).res.headers.location)).toBe('link_denied');
  });

  it('prefers an existing OIDC identity over email matching', async () => {
    const b = await boot();
    const first = await meOf(b.h.app, sessionCookie((await ssoLogin(b.h.app)).res));
    await configureOidc(b.h, b.admin, b.idp, { linkExistingByEmail: true });
    addLocal(b, 'late-local', 'alice@example.com', Permission.REQUEST);
    const again = await meOf(b.h.app, sessionCookie((await ssoLogin(b.h.app)).res));
    expect(again.id).toBe(first.id);
  });
});
