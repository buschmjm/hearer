import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeReturnTo } from '../src/auth/oidc.ts';
import {
  addUser,
  call,
  completeSetup,
  createHarness,
  login,
  type Harness,
} from './helpers/auth.ts';
import {
  configureOidc,
  startLogin,
  startMockIdp,
  authorizeAt,
  callback,
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

async function boot(env: Record<string, string> = {}) {
  idp = await startMockIdp();
  h = await createHarness({ env });
  const admin = await completeSetup(h);
  return { h, idp, admin };
}

describe('sanitizeReturnTo', () => {
  it.each([
    ['/', '/'],
    ['/requests', '/requests'],
    ['/search?q=a&b=c#frag', '/search?q=a&b=c#frag'],
    ['/a/b%2Fc', '/a/b%2Fc'],
  ])('keeps the same-origin path %s', (input, expected) => {
    expect(sanitizeReturnTo(input)).toBe(expected);
  });

  it.each([
    '//evil.example',
    '//evil.example/path',
    '/\\evil.example',
    '\\\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r\n\r\nSet-Cookie: x=1',
    'https://evil.example',
    'http://evil.example/',
    'javascript:alert(1)',
    'evil.example',
    '',
    '/ok\u0000',
    `/${'a'.repeat(3000)}`,
  ])('rejects %j', (input) => {
    expect(sanitizeReturnTo(input)).toBe('/');
  });

  it('rejects non-strings', () => {
    expect(sanitizeReturnTo(undefined)).toBe('/');
    expect(sanitizeReturnTo(['/a'])).toBe('/');
    expect(sanitizeReturnTo(42)).toBe('/');
  });
});

describe('returnTo through the whole flow', () => {
  it.each(['//evil.example', 'https://evil.example/x', '/\\evil.example'])(
    'lands on / for the open-redirect attempt %s',
    async (attempt) => {
      const b = await boot();
      await configureOidc(b.h, b.admin, b.idp);
      const started = await startLogin(b.h.app, attempt);
      expect(started.res.statusCode).toBe(302);
      const res = await callback(b.h.app, await authorizeAt(started.location), started.tx);
      expect(res.headers.location).toBe('/');
    },
  );
});

describe('availability', () => {
  it('reports the button state publicly', async () => {
    const b = await boot();
    const off = await call(b.h.app, undefined, 'GET', '/api/v1/auth/oidc/config');
    expect(off.json()).toEqual({ enabled: false, buttonLabel: 'Sign in with SSO' });
    await configureOidc(b.h, b.admin, b.idp, { buttonLabel: 'Sign in with Acme' });
    const on = await call(b.h.app, undefined, 'GET', '/api/v1/auth/oidc/config');
    expect(on.json()).toEqual({ enabled: true, buttonLabel: 'Sign in with Acme' });
  });

  it('is not enabled until an issuer and client id are configured', async () => {
    const b = await boot();
    await configureOidc(b.h, b.admin, b.idp, { issuerUrl: '' });
    const res = await call(b.h.app, undefined, 'GET', '/api/v1/auth/oidc/config');
    expect(res.json<{ enabled: boolean }>().enabled).toBe(false);
  });

  it('answers 404 on login and an error redirect on callback when disabled', async () => {
    const b = await boot();
    const login404 = await call(b.h.app, undefined, 'GET', '/api/v1/auth/oidc/login');
    expect(login404.statusCode).toBe(404);
    expect(login404.json<{ error: { code: string } }>().error.code).toBe('oidc_disabled');
    const cb = await call(b.h.app, undefined, 'GET', '/api/v1/auth/oidc/callback?code=x&state=y');
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/login?error=oidc_disabled');
  });

  it('answers 503 setup_required for every OIDC route before setup completes', async () => {
    idp = await startMockIdp();
    h = await createHarness();
    for (const url of [
      '/api/v1/auth/oidc/config',
      '/api/v1/auth/oidc/login',
      '/api/v1/auth/oidc/callback',
    ]) {
      const res = await call(h.app, undefined, 'GET', url);
      expect(res.statusCode, url).toBe(503);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('setup_required');
    }
  });

  it('marks the transaction cookie Secure when the public URL is https', async () => {
    const b = await boot();
    await call(b.h.app, b.admin, 'PUT', '/api/v1/settings/general', {
      applicationUrl: 'https://hearer.example.org',
    });
    await configureOidc(b.h, b.admin, b.idp);
    const started = await startLogin(b.h.app);
    expect(started.res.cookies.find((c) => c.name === 'hearer_oidc_tx')?.secure).toBe(true);
    const redirect = new URL(started.location).searchParams.get('redirect_uri');
    expect(redirect).toBe('https://hearer.example.org/api/v1/auth/oidc/callback');
  });
});

describe('POST /settings/auth/oidc/test and redirect URI', () => {
  it('returns the discovered endpoints', async () => {
    const b = await boot();
    const res = await call(b.h.app, b.admin, 'POST', '/api/v1/settings/auth/oidc/test', {
      issuerUrl: b.idp.issuer,
      allowInsecureHttp: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      issuer: b.idp.issuer,
      authorizationEndpoint: `${b.idp.issuer}/authorize`,
      tokenEndpoint: `${b.idp.issuer}/token`,
      jwksUri: `${b.idp.issuer}/jwks`,
      pkceS256: true,
      idTokenAlgs: ['RS256'],
    });
  });

  it('reports an error for an unreachable or non-OIDC issuer', async () => {
    const b = await boot();
    const dead = await call(b.h.app, b.admin, 'POST', '/api/v1/settings/auth/oidc/test', {
      issuerUrl: 'http://127.0.0.1:1',
      allowInsecureHttp: true,
    });
    expect(dead.statusCode).toBe(200);
    expect(dead.json<{ ok: boolean; error: string }>()).toMatchObject({ ok: false });
    expect(dead.json<{ error: string }>().error).not.toBe('');
    const notOidc = await call(b.h.app, b.admin, 'POST', '/api/v1/settings/auth/oidc/test', {
      issuerUrl: `${b.idp.issuer}/nothing-here`,
      allowInsecureHttp: true,
    });
    expect(notOidc.json<{ ok: boolean }>().ok).toBe(false);
  });

  it('refuses a cleartext issuer unless explicitly allowed', async () => {
    const b = await boot();
    const res = await call(b.h.app, b.admin, 'POST', '/api/v1/settings/auth/oidc/test', {
      issuerUrl: b.idp.issuer,
    });
    expect(res.json<{ ok: boolean }>().ok).toBe(false);
    expect(b.idp.hits.discovery).toBe(0);
  });

  it('validates the body', async () => {
    const b = await boot();
    const res = await call(b.h.app, b.admin, 'POST', '/api/v1/settings/auth/oidc/test', {
      issuerUrl: 'not a url',
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires MANAGE_SETTINGS', async () => {
    const b = await boot();
    await addUser(b.h.app, 'plain', 0);
    const user = await login(b.h.app, 'plain');
    const body = { issuerUrl: b.idp.issuer, allowInsecureHttp: true };
    for (const [creds, status] of [
      [undefined, 401],
      [user, 403],
    ] as const) {
      const test = await call(b.h.app, creds, 'POST', '/api/v1/settings/auth/oidc/test', body);
      expect(test.statusCode).toBe(status);
      const uri = await call(b.h.app, creds, 'GET', '/api/v1/settings/auth/oidc/redirect-uri');
      expect(uri.statusCode).toBe(status);
    }
  });

  it('shows the redirect URI from the public URL, else the request', async () => {
    const b = await boot();
    const fromRequest = await call(
      b.h.app,
      b.admin,
      'GET',
      '/api/v1/settings/auth/oidc/redirect-uri',
    );
    expect(fromRequest.json()).toEqual({
      redirectUri: 'http://localhost/api/v1/auth/oidc/callback',
    });
    await call(b.h.app, b.admin, 'PUT', '/api/v1/settings/general', {
      applicationUrl: 'https://music.example.org/',
    });
    const fromSetting = await call(
      b.h.app,
      b.admin,
      'GET',
      '/api/v1/settings/auth/oidc/redirect-uri',
    );
    expect(fromSetting.json()).toEqual({
      redirectUri: 'https://music.example.org/api/v1/auth/oidc/callback',
    });
  });

  it('masks the client secret in the settings API', async () => {
    const b = await boot();
    await configureOidc(b.h, b.admin, b.idp);
    const res = await call(b.h.app, b.admin, 'GET', '/api/v1/settings/auth');
    expect(res.body).not.toContain(b.idp.clientSecret);
  });
});
