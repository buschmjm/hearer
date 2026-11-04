import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TRANSACTION_TTL_MS } from '../src/auth/oidc.ts';
import {
  call,
  completeSetup,
  createHarness,
  type Credentials,
  type Harness,
} from './helpers/auth.ts';
import {
  DEFAULT_USER,
  authorizeAt,
  callback,
  configureOidc,
  sessionCookie,
  ssoLogin,
  startLogin,
  startMockIdp,
  type MockIdp,
} from './helpers/mock-idp.ts';

let h: Harness;
let idp: MockIdp;
let admin: Credentials;

async function boot(alg: 'RS256' | 'ES256' = 'RS256', oidc: Record<string, unknown> = {}) {
  idp = await startMockIdp({ alg });
  h = await createHarness();
  admin = await completeSetup(h);
  await configureOidc(h, admin, idp, oidc);
}

beforeEach(() => {
  idp = undefined as unknown as MockIdp;
  h = undefined as unknown as Harness;
});
afterEach(async () => {
  await h.cleanup();
  await idp.close();
});

const errorOf = (location: unknown): string | null =>
  new URL(String(location), 'http://x').searchParams.get('error');

describe('OIDC login flow', () => {
  it('runs the full happy path and signs the user in', async () => {
    await boot();
    const started = await startLogin(h.app, '/requests?tab=mine');
    expect(started.res.statusCode).toBe(302);

    // The redirect to the IdP carries PKCE S256, state and nonce.
    const auth = new URL(started.location);
    expect(auth.origin).toBe(idp.issuer);
    expect(auth.pathname).toBe('/authorize');
    const q = auth.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('hearer-test');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')?.length).toBeGreaterThanOrEqual(16);
    expect(q.get('nonce')?.length).toBeGreaterThanOrEqual(16);
    expect(q.get('scope')).toBe('openid profile email');
    expect(q.get('redirect_uri')).toMatch(/\/api\/v1\/auth\/oidc\/callback$/);

    // The transaction cookie: httpOnly, SameSite=Lax, short-lived, scoped, and it does not
    // expose the verifier or nonce in clear.
    const cookie = started.res.cookies.find((c) => c.name === 'hearer_oidc_tx');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', maxAge: 600 });
    expect(cookie?.path).toBe('/api/v1/auth/oidc');
    expect(decodeURIComponent(cookie?.value ?? '')).not.toContain(q.get('nonce') ?? 'x');

    const callbackUrl = await authorizeAt(started.location);
    const res = await callback(h.app, callbackUrl, started.tx);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/requests?tab=mine');
    // Transaction cookie cleared, session cookie set.
    const cleared = res.cookies.find((c) => c.name === 'hearer_oidc_tx');
    expect(cleared?.value).toBe('');
    const session = res.cookies.find((c) => c.name === 'hearer_session');
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax' });

    const me = await h.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: sessionCookie(res) },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json<{
      user: { username: string; authType: string; email: string; displayName: string };
      authMethod: string;
    }>();
    expect(body.authMethod).toBe('session');
    expect(body.user).toMatchObject({
      username: 'alice',
      authType: 'oidc',
      email: 'alice@example.com',
      displayName: 'Alice Example',
    });
  });

  it('reuses the same user on the second login and refreshes the profile', async () => {
    await boot();
    const first = await ssoLogin(h.app);
    expect(first.res.statusCode).toBe(302);
    idp.user = { ...DEFAULT_USER, name: 'Alice Renamed', preferred_username: 'alice2' };
    const second = await ssoLogin(h.app);
    expect(second.res.headers.location).toBe('/');
    const list = await call(h.app, admin, 'GET', '/api/v1/users');
    const items = list.json<{
      items: { username: string; authType: string; displayName: string }[];
    }>().items;
    const oidcUsers = items.filter((u) => u.authType === 'oidc');
    expect(oidcUsers).toHaveLength(1);
    expect(oidcUsers[0]).toMatchObject({ username: 'alice', displayName: 'Alice Renamed' });
  });

  it('works with an ES256-signed ID token (algorithm taken from discovery)', async () => {
    idp = await startMockIdp({ alg: 'ES256' });
    h = await createHarness();
    admin = await completeSetup(h);
    await configureOidc(h, admin, idp);
    const { res } = await ssoLogin(h.app);
    expect(res.headers.location).toBe('/');
    expect(sessionCookie(res)).not.toBe('');
  });

  it('never exposes an authenticated session on the login redirect itself', async () => {
    await boot();
    const started = await startLogin(h.app);
    expect(started.res.cookies.find((c) => c.name === 'hearer_session')).toBeUndefined();
  });
});

describe('transaction validation', () => {
  it('rejects a state mismatch', async () => {
    await boot();
    const started = await startLogin(h.app);
    const url = new URL(await authorizeAt(started.location));
    url.searchParams.set('state', 'attacker-chosen-state');
    const res = await callback(h.app, url.href, started.tx);
    expect(errorOf(res.headers.location)).toBe('state_mismatch');
    expect(sessionCookie(res)).toBe('');
    expect(idp.hits.token).toBe(0);
  });

  it('rejects a callback without the transaction cookie', async () => {
    await boot();
    const started = await startLogin(h.app);
    const res = await callback(h.app, await authorizeAt(started.location), '');
    expect(errorOf(res.headers.location)).toBe('invalid_transaction');
    expect(sessionCookie(res)).toBe('');
  });

  it('rejects a tampered or foreign transaction cookie', async () => {
    await boot();
    const started = await startLogin(h.app);
    const callbackUrl = await authorizeAt(started.location);
    const tampered = started.tx.slice(0, -2) + (started.tx.endsWith('AA') ? 'BB' : 'AA');
    expect(errorOf((await callback(h.app, callbackUrl, tampered)).headers.location)).toBe(
      'invalid_transaction',
    );
    const forged = 'hearer_oidc_tx=' + Buffer.from('{"state":"x"}').toString('base64url');
    expect(errorOf((await callback(h.app, callbackUrl, forged)).headers.location)).toBe(
      'invalid_transaction',
    );
  });

  it('refuses to redeem the same transaction twice', async () => {
    await boot();
    const started = await startLogin(h.app);
    const callbackUrl = await authorizeAt(started.location);
    const first = await callback(h.app, callbackUrl, started.tx);
    expect(first.headers.location).toBe('/');
    const replay = await callback(h.app, callbackUrl, started.tx);
    expect(errorOf(replay.headers.location)).toBe('transaction_replayed');
    expect(sessionCookie(replay)).toBe('');
    expect(idp.hits.token).toBe(1);
  });

  it('rejects an expired transaction', async () => {
    await boot();
    const started = await startLogin(h.app);
    const callbackUrl = await authorizeAt(started.location);
    h.clock.t += TRANSACTION_TTL_MS + 1000;
    const res = await callback(h.app, callbackUrl, started.tx);
    expect(errorOf(res.headers.location)).toBe('transaction_expired');
    expect(idp.hits.token).toBe(0);
  });

  it('shows access_denied when the user declines at the IdP', async () => {
    await boot();
    const started = await startLogin(h.app);
    const state = new URL(started.location).searchParams.get('state') ?? '';
    const back = new URL(String(new URL(started.location).searchParams.get('redirect_uri')));
    back.searchParams.set('error', 'access_denied');
    back.searchParams.set('state', state);
    const res = await callback(h.app, back.href, started.tx);
    expect(errorOf(res.headers.location)).toBe('access_denied');
  });

  it('does not leak error details in the redirect', async () => {
    await boot();
    idp.overrides = { aud: 'someone-else' };
    const { res } = await ssoLogin(h.app);
    expect(res.headers.location).toBe('/login?error=login_failed');
    expect(res.body).not.toContain('someone-else');
  });
});

describe('ID token validation', () => {
  const cases: [string, () => void][] = [
    ['a wrong nonce', () => (idp.overrides = { nonce: 'not-the-nonce' })],
    ['a missing nonce', () => (idp.overrides = { nonce: null })],
    ['a wrong audience', () => (idp.overrides = { aud: 'another-client' })],
    ['a wrong issuer', () => (idp.overrides = { iss: 'https://evil.example' })],
    ['an expired token', () => (idp.overrides = { exp: Math.floor(Date.now() / 1000) - 3600 })],
    ['a signature from another key', () => (idp.overrides = { wrongKey: true })],
  ];
  it.each(cases)('rejects %s', async (_name, tamper) => {
    await boot();
    tamper();
    const { res } = await ssoLogin(h.app);
    expect(errorOf(res.headers.location)).toBe('login_failed');
    expect(sessionCookie(res)).toBe('');
    const users = await call(h.app, admin, 'GET', '/api/v1/users');
    expect(
      users.json<{ items: { authType: string }[] }>().items.some((u) => u.authType === 'oidc'),
    ).toBe(false);
  });

  it('rejects a client secret the IdP does not accept', async () => {
    await boot();
    await configureOidc(h, admin, idp, { clientSecret: 'wrong' });
    const { res } = await ssoLogin(h.app);
    expect(errorOf(res.headers.location)).toBe('login_failed');
  });
});

describe('discovery cache', () => {
  it('discovers once, then re-discovers when settings change', async () => {
    await boot();
    await ssoLogin(h.app);
    await ssoLogin(h.app);
    expect(idp.hits.discovery).toBe(1);
    await configureOidc(h, admin, idp, { scopes: 'openid email' });
    await ssoLogin(h.app);
    expect(idp.hits.discovery).toBe(1); // scopes are not part of discovery
    await configureOidc(h, admin, idp, { clientSecret: 'wrong' });
    await ssoLogin(h.app);
    expect(idp.hits.discovery).toBe(2);
  });

  it('remembers a failed discovery briefly, then retries', async () => {
    await boot();
    idp.failDiscovery = true;
    const first = await startLogin(h.app);
    expect(errorOf(first.res.headers.location)).toBe('oidc_unavailable');
    await startLogin(h.app);
    expect(idp.hits.discovery).toBe(1);
    idp.failDiscovery = false;
    h.clock.t += 31_000;
    const retry = await startLogin(h.app);
    expect(retry.res.headers.location).toContain('/authorize');
    expect(idp.hits.discovery).toBe(2);
  });

  it('refuses an http issuer unless allowInsecureHttp is on', async () => {
    await boot();
    await configureOidc(h, admin, idp, { allowInsecureHttp: false });
    const started = await startLogin(h.app);
    expect(errorOf(started.res.headers.location)).toBe('oidc_unavailable');
    expect(idp.hits.discovery).toBe(0);
  });
});
