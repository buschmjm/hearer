import type { RouteOptions } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { requirePermission } from '../src/auth/guard.ts';
import { Permission } from '../src/auth/permissions.ts';
import {
  addUser,
  call,
  completeSetup,
  createHarness,
  login,
  type Credentials,
  type Harness,
} from './helpers/auth.ts';

/**
 * PLAN acceptance #2: permissions are enforced on every route. The suite enumerates the real
 * route table (via the app's onRoute hook) and fails when a route is neither explicitly public
 * nor guarded. Adding a route without a guard breaks this test; the fix is to add the guard, or
 * (deliberately, in review) to extend one of the allowlists below.
 */

/** Routes anyone may call without credentials. Keep this list short and justified. */
const PUBLIC = new Set([
  'GET /api/v1/health', // liveness probe
  'GET /api/v1/openapi.json', // API description
  'GET /api/v1/setup/status', // the wizard needs it before anyone can sign in
  'POST /api/v1/setup/admin', // first admin; 409s once any user exists
  'POST /api/v1/auth/login', // credentials in the body
  'POST /api/v1/auth/jellyfin', // Jellyfin credentials in the body (rate limited)
  'POST /api/v1/auth/logout', // clears whatever cookie it was sent
  'GET /api/v1/auth/oidc/config', // the login page needs the button label
  'GET /api/v1/auth/oidc/login', // starts the browser redirect to the IdP
  'GET /api/v1/auth/oidc/callback', // the IdP redirects here; validated by the signed transaction
]);

/** Routes any signed-in user may call (no specific permission bit needed). */
const AUTHENTICATED_ONLY = new Set([
  'GET /api/v1/auth/me',
  'POST /api/v1/auth/logout-all',
  'POST /api/v1/auth/password',
  'GET /api/v1/auth/api-keys',
  'POST /api/v1/auth/api-keys',
  'DELETE /api/v1/auth/api-keys/:id',
  // Catalog search and browse (H-09): any signed-in user.
  'GET /api/v1/search',
  'GET /api/v1/artists/:mbid',
  'GET /api/v1/artists/:mbid/albums',
  'GET /api/v1/albums/:mbid',
  'GET /api/v1/tracks/:mbid',
]);

/** Prefixes that stay reachable before setup completes. */
const OPEN_BEFORE_SETUP = [
  '/api/v1/health',
  '/api/v1/openapi.json',
  '/api/v1/auth',
  '/api/v1/setup',
];
/** Single sign-on cannot bootstrap the app, so it stays gated inside the open `auth` prefix. */
const GATED_BEFORE_SETUP = '/api/v1/auth/oidc';

interface RouteKey {
  method: string;
  url: string;
}
const keyOf = (r: RouteKey) => `${r.method} ${r.url}`;
/** Fastify derives HEAD routes from GET ones; they share the GET route's classification. */
const canonical = (r: RouteKey) => `${r.method === 'HEAD' ? 'GET' : r.method} ${r.url}`;
const isPublic = (r: RouteKey) => PUBLIC.has(canonical(r));
const isAuthOnly = (r: RouteKey) => AUTHENTICATED_ONLY.has(canonical(r));

const fill = (url: string) =>
  url.replace(/:(\w+)/g, (_m, name: string) =>
    name === 'key' || name === 'section' ? 'general' : 'x',
  );

let h: Harness;
afterEach(async () => {
  await h.cleanup();
});

/** Build an app that records every route; `extra` plugins are registered after the built-ins. */
async function harnessWithRoutes(extra: FastifyPluginCallbackZod[] = []) {
  const routes: RouteKey[] = [];
  h = await createHarness({
    deps: {
      routes: extra,
      onRoute: (route: RouteOptions) => {
        for (const method of [route.method].flat()) {
          if (route.url.startsWith('/api/v1/')) routes.push({ method, url: route.url });
        }
      },
    },
  });
  return routes;
}

describe('route-level permission matrix', () => {
  it('discovers the route table', async () => {
    const routes = await harnessWithRoutes();
    const keys = routes.map((r) => keyOf(r));
    expect(routes.length).toBeGreaterThanOrEqual(25);
    for (const expected of [
      'GET /api/v1/users',
      'DELETE /api/v1/users/:id',
      'PUT /api/v1/settings/:key',
      'POST /api/v1/setup/complete',
      'POST /api/v1/auth/login',
    ]) {
      expect(keys).toContain(expected);
    }
    // Every allowlist entry must still exist, so stale entries cannot mask a missing guard.
    for (const entry of [...PUBLIC, ...AUTHENTICATED_ONLY]) expect(keys).toContain(entry);
  });

  it('answers 401 for every non-public route when anonymous', async () => {
    const routes = await harnessWithRoutes();
    await completeSetup(h);
    const failures: string[] = [];
    for (const route of routes.filter((r) => !isPublic(r))) {
      const res = await call(h.app, undefined, route.method as 'GET', fill(route.url), {});
      if (res.statusCode !== 401) failures.push(`${keyOf(route)} -> ${String(res.statusCode)}`);
    }
    expect(failures).toEqual([]);
  });

  it('never returns a server error from a public route', async () => {
    const routes = await harnessWithRoutes();
    await completeSetup(h);
    for (const route of routes.filter((r) => isPublic(r))) {
      const res = await call(h.app, undefined, route.method as 'GET', fill(route.url), {});
      expect(res.statusCode, keyOf(route)).toBeLessThan(500);
    }
  });

  it('answers 403 to a signed-in user with no permissions, except authenticated-only routes', async () => {
    const routes = await harnessWithRoutes();
    await completeSetup(h);
    await addUser(h.app, 'nobody', 0);
    const failures: string[] = [];
    for (const route of routes.filter((r) => !isPublic(r))) {
      // A fresh session per route: some routes (logout-all, password) end sessions.
      const creds: Credentials = await login(h.app, 'nobody');
      const res = await call(h.app, creds, route.method as 'GET', fill(route.url), {});
      if (isAuthOnly(route)) {
        if (res.statusCode === 401 || res.statusCode === 403) {
          failures.push(`${keyOf(route)} (authenticated-only) -> ${String(res.statusCode)}`);
        }
      } else if (res.statusCode !== 403) {
        failures.push(`${keyOf(route)} -> ${String(res.statusCode)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('answers 403 to an API key whose owner has no permissions', async () => {
    const routes = await harnessWithRoutes();
    await completeSetup(h);
    const id = await addUser(h.app, 'nobody', 0);
    const { secret } = h.app.hearer.apiKeys.create(id, 'k');
    const failures: string[] = [];
    for (const route of routes.filter((r) => !isPublic(r) && !isAuthOnly(r))) {
      const res = await call(
        h.app,
        undefined,
        route.method as 'GET',
        fill(route.url),
        {},
        { 'x-api-key': secret },
      );
      if (res.statusCode !== 403) failures.push(`${keyOf(route)} -> ${String(res.statusCode)}`);
    }
    expect(failures).toEqual([]);
  });

  it('gates every route outside the open prefixes with 503 until setup completes', async () => {
    const routes = await harnessWithRoutes();
    const gated = routes.filter(
      (r) =>
        r.url.startsWith(GATED_BEFORE_SETUP) ||
        !OPEN_BEFORE_SETUP.some((p) => r.url === p || r.url.startsWith(`${p}/`)),
    );
    expect(gated.length).toBeGreaterThan(5);
    for (const route of gated) {
      const res = await call(h.app, undefined, route.method as 'GET', fill(route.url), {});
      expect(res.statusCode, keyOf(route)).toBe(503);
      if (route.method !== 'HEAD') {
        expect(res.json<{ error: { code: string } }>().error.code).toBe('setup_required');
      }
    }
  });

  it('detects a route that forgot its guard (the matrix would fail)', async () => {
    const oops: FastifyPluginCallbackZod = (app, _o, done) => {
      app.get('/oops', () => ({ leaked: true }));
      app.get('/careful', { onRequest: [requirePermission(Permission.MANAGE_REQUESTS)] }, () => ({
        ok: true,
      }));
      done();
    };
    const routes = await harnessWithRoutes([oops]);
    await completeSetup(h);
    const unguarded: string[] = [];
    for (const route of routes.filter((r) => !isPublic(r))) {
      const res = await call(h.app, undefined, route.method as 'GET', fill(route.url), {});
      if (res.statusCode !== 401) unguarded.push(keyOf(route));
    }
    expect(unguarded).toEqual(['GET /api/v1/oops', 'HEAD /api/v1/oops']);
  });
});
