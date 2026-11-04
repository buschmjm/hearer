import { writeFileSync } from 'node:fs';
import type { MeResponse, SessionResponse, SetupStatus } from '@hearer/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PASSWORD,
  ROLES,
  addUser,
  call,
  completeSetup,
  cookieHeader,
  createHarness,
  login,
  type Harness,
} from './helpers/auth.ts';

let h: Harness;
afterEach(async () => {
  await h.cleanup();
});

const createAdmin = (body: object = { username: 'admin', password: PASSWORD }) =>
  h.app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: body });
const errorCode = (res: { json: () => unknown }) =>
  (res.json() as { error: { code: string } }).error.code;

describe('GET /setup/status', () => {
  it('is public and reports a fresh install', async () => {
    h = await createHarness();
    const res = await call(h.app, undefined, 'GET', '/api/v1/setup/status');
    expect(res.statusCode).toBe(200);
    expect(res.json<SetupStatus>()).toEqual({
      setupComplete: false,
      hasAdmin: false,
      steps: { admin: false, directories: true },
      directories: {
        library: { path: h.musicDir, exists: true, writable: true },
        staging: { path: h.stagingDir, exists: true, writable: true },
      },
    });
  });

  it('reports missing and non-directory paths', async () => {
    h = await createHarness({ noDirs: true });
    const missing = (
      await call(h.app, undefined, 'GET', '/api/v1/setup/status')
    ).json<SetupStatus>();
    expect(missing.steps.directories).toBe(false);
    expect(missing.directories?.library).toEqual({
      path: h.musicDir,
      exists: false,
      writable: false,
      error: 'Does not exist',
    });
    writeFileSync(h.musicDir, 'a file');
    const file = (await call(h.app, undefined, 'GET', '/api/v1/setup/status')).json<SetupStatus>();
    expect(file.directories?.library).toMatchObject({
      exists: true,
      writable: false,
      error: 'Not a directory',
    });
  });

  it('hides paths once setup is complete', async () => {
    h = await createHarness();
    await completeSetup(h);
    const status = (
      await call(h.app, undefined, 'GET', '/api/v1/setup/status')
    ).json<SetupStatus>();
    expect(status).toEqual({
      setupComplete: true,
      hasAdmin: true,
      steps: { admin: true, directories: true },
    });
  });
});

describe('POST /setup/admin', () => {
  it('creates the first admin and signs them in', async () => {
    h = await createHarness();
    const res = await createAdmin({
      username: 'root',
      password: PASSWORD,
      email: 'root@example.com',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<SessionResponse>();
    expect(body.user).toMatchObject({
      username: 'root',
      email: 'root@example.com',
      authType: 'local',
      permissions: 1,
    });
    expect(body.permissions).toEqual(['ADMIN']);
    expect(res.body).not.toMatch(/argon2|passwordHash/);
    expect(res.cookies[0]).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });

    const me = await call(
      h.app,
      { cookie: cookieHeader(res), csrf: body.csrfToken },
      'GET',
      '/api/v1/auth/me',
    );
    expect(me.json<MeResponse>().user.username).toBe('root');
    const status = (
      await call(h.app, undefined, 'GET', '/api/v1/setup/status')
    ).json<SetupStatus>();
    expect(status).toMatchObject({ hasAdmin: true, steps: { admin: true }, setupComplete: false });
  });

  it('refuses a second admin with 409', async () => {
    h = await createHarness();
    expect((await createAdmin()).statusCode).toBe(201);
    const again = await createAdmin({ username: 'second', password: PASSWORD });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('setup_admin_exists');
    expect(again.cookies).toHaveLength(0);
    expect(h.app.hearer.users.getByUsername('second')).toBeUndefined();
  });

  it('refuses once any user exists, even a non-admin one', async () => {
    h = await createHarness();
    await addUser(h.app, 'someone', ROLES.user);
    expect((await createAdmin()).statusCode).toBe(409);
  });

  it('lets exactly one of many parallel calls win', async () => {
    h = await createHarness();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        createAdmin({ username: `racer${String(i)}`, password: PASSWORD }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    const rows = h.app.hearer.database.sqlite.prepare('select permissions from users').all();
    expect(rows).toEqual([{ permissions: 1 }]);
    const sessions = h.app.hearer.database.sqlite
      .prepare('select count(*) as n from sessions')
      .get();
    expect(sessions).toEqual({ n: 1 });
  });

  it('validates username and password', async () => {
    h = await createHarness();
    for (const body of [
      { username: 'ab', password: PASSWORD },
      { username: 'has space', password: PASSWORD },
      { username: 'admin', password: 'short' },
      { username: 'admin', password: PASSWORD, email: 'not-an-email' },
      { password: PASSWORD },
    ]) {
      const res = await createAdmin(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(h.app.hearer.users.hasAnyUser()).toBe(false);
  });

  it('is rate limited', async () => {
    h = await createHarness({ auth: { rateLimitMax: 2 } });
    expect((await createAdmin({ username: 'a' })).statusCode).toBe(400);
    expect((await createAdmin({ username: 'b' })).statusCode).toBe(400);
    const limited = await createAdmin();
    expect(limited.statusCode).toBe(429);
    expect(errorCode(limited)).toBe('rate_limited');
  });
});

describe('setup gating', () => {
  it('answers 503 setup_required on other API routes until setup completes', async () => {
    h = await createHarness();
    const anon = await call(h.app, undefined, 'GET', '/api/v1/users');
    expect(anon.statusCode).toBe(503);
    expect(anon.json()).toEqual({
      error: { code: 'setup_required', message: 'Setup is not complete' },
    });

    const admin = (await createAdmin()).json<SessionResponse>();
    const creds = { cookie: cookieHeader(await createLogin()), csrf: admin.csrfToken };
    // Even a signed-in admin is gated off the normal API until the wizard is finished.
    expect((await call(h.app, creds, 'GET', '/api/v1/users')).statusCode).toBe(503);
    expect((await call(h.app, creds, 'GET', '/api/v1/settings')).statusCode).toBe(503);
  });

  async function createLogin() {
    return h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: PASSWORD },
    });
  }

  it('keeps health, auth, setup, openapi and 404s reachable', async () => {
    h = await createHarness();
    expect((await call(h.app, undefined, 'GET', '/api/v1/health')).statusCode).toBe(200);
    expect((await call(h.app, undefined, 'GET', '/api/v1/openapi.json')).statusCode).toBe(200);
    expect((await call(h.app, undefined, 'GET', '/api/v1/setup/status')).statusCode).toBe(200);
    expect((await call(h.app, undefined, 'GET', '/api/v1/auth/me')).statusCode).toBe(401);
    expect((await call(h.app, undefined, 'GET', '/api/v1/no-such-route')).statusCode).toBe(404);
  });

  it('lifts once the wizard completes', async () => {
    h = await createHarness();
    const admin = await completeSetup(h);
    expect((await call(h.app, admin, 'GET', '/api/v1/users')).statusCode).toBe(200);
    expect((await call(h.app, undefined, 'GET', '/api/v1/users')).statusCode).toBe(401);
  });
});

describe('wizard sections and completion', () => {
  async function adminOnly() {
    const res = await createAdmin();
    return { cookie: cookieHeader(res), csrf: res.json<SessionResponse>().csrfToken };
  }

  it('requires an administrator', async () => {
    h = await createHarness();
    await addUser(h.app, 'plain', ROLES.manager); // manager is not an admin
    const manager = await login(h.app, 'plain');
    for (const [method, url] of [
      ['GET', '/api/v1/setup/general'],
      ['PUT', '/api/v1/setup/general'],
      ['POST', '/api/v1/setup/complete'],
    ] as const) {
      expect((await call(h.app, undefined, method, url, {})).statusCode, `anon ${url}`).toBe(401);
      expect((await call(h.app, manager, method, url, {})).statusCode, `manager ${url}`).toBe(403);
    }
  });

  it('saves general, library and uploads, validating each', async () => {
    h = await createHarness();
    const admin = await adminOnly();
    const general = await call(h.app, admin, 'PUT', '/api/v1/setup/general', {
      appTitle: 'Our Music',
    });
    expect(general.statusCode).toBe(200);
    expect(general.json()).toMatchObject({ appTitle: 'Our Music', setupComplete: false });
    const library = await call(h.app, admin, 'PUT', '/api/v1/setup/library', {
      namingTemplate: '{artist}/{title}.{ext}',
    });
    expect(library.json()).toMatchObject({ namingTemplate: '{artist}/{title}.{ext}' });
    const uploads = await call(h.app, admin, 'PUT', '/api/v1/setup/uploads', {
      maxFileSizeMb: 500,
    });
    expect(uploads.json()).toMatchObject({ maxFileSizeMb: 500 });
    expect(h.app.hearer.settings.get('uploads').maxFileSizeMb).toBe(500);
    expect((await call(h.app, admin, 'GET', '/api/v1/setup/general')).json()).toMatchObject({
      appTitle: 'Our Music',
    });

    const bad = await call(h.app, admin, 'PUT', '/api/v1/setup/uploads', { maxFileSizeMb: 0 });
    expect(bad.statusCode).toBe(400);
    expect(errorCode(bad)).toBe('validation_error');
    expect(bad.json<{ error: { details: unknown[] } }>().error.details.length).toBeGreaterThan(0);
    expect(h.app.hearer.settings.get('uploads').maxFileSizeMb).toBe(500);
  });

  it('only accepts the wizard sections', async () => {
    h = await createHarness();
    const admin = await adminOnly();
    for (const section of ['mediaServer', 'auth', 'nope']) {
      expect((await call(h.app, admin, 'PUT', `/api/v1/setup/${section}`, {})).statusCode).toBe(
        400,
      );
    }
  });

  it('cannot mark setup complete through the general section', async () => {
    h = await createHarness();
    const admin = await adminOnly();
    const res = await call(h.app, admin, 'PUT', '/api/v1/setup/general', { setupComplete: true });
    expect(res.statusCode).toBe(200);
    expect(h.app.hearer.settings.get('general').setupComplete).toBe(false);
  });

  it('refuses to complete while the directories are unusable', async () => {
    h = await createHarness({ noDirs: true });
    const admin = await adminOnly();
    const res = await call(h.app, admin, 'POST', '/api/v1/setup/complete');
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('directories_not_ready');
    expect(h.app.hearer.settings.get('general').setupComplete).toBe(false);
  });

  it('completes, then closes the wizard', async () => {
    h = await createHarness();
    const admin = await adminOnly();
    const done = await call(h.app, admin, 'POST', '/api/v1/setup/complete');
    expect(done.statusCode).toBe(200);
    expect(done.json<SetupStatus>()).toMatchObject({ setupComplete: true, hasAdmin: true });
    expect(h.app.hearer.settings.get('general').setupComplete).toBe(true);
    const again = await call(h.app, admin, 'POST', '/api/v1/setup/complete');
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('setup_already_complete');
    expect((await call(h.app, admin, 'PUT', '/api/v1/setup/general', {})).statusCode).toBe(409);
  });

  it('survives a restart of the settings cache', async () => {
    h = await createHarness();
    await completeSetup(h);
    h.app.hearer.settings.invalidate();
    expect(
      (await call(h.app, undefined, 'GET', '/api/v1/setup/status')).json<SetupStatus>()
        .setupComplete,
    ).toBe(true);
  });
});
