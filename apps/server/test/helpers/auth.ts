import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Permission, type SessionResponse } from '@hearer/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp, type AppDeps } from '../../src/app.ts';
import { loadConfig, type Config } from '../../src/config.ts';
import { hashPassword } from '../../src/auth/password.ts';

export const PASSWORD = 'correct horse battery';

export interface Clock {
  t: number;
  now: () => number;
}

export interface Harness {
  app: FastifyInstance;
  config: Config;
  clock: Clock;
  musicDir: string;
  stagingDir: string;
  cleanup: () => Promise<void>;
}

export interface HarnessOptions {
  env?: Record<string, string>;
  auth?: AppDeps['auth'];
  /** Skip creating the music/staging directories (to test the "missing" report). */
  noDirs?: boolean;
  deps?: Omit<AppDeps, 'auth'>;
}

/** An app on an in-memory database with temp library/staging dirs and a controllable clock. */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'hearer-auth-'));
  const musicDir = join(root, 'music');
  const stagingDir = join(root, 'staging');
  if (!options.noDirs) {
    mkdirSync(musicDir);
    mkdirSync(stagingDir);
  }
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MUSIC_DIR: musicDir,
    STAGING_DIR: stagingDir,
    DATA_DIR: join(root, 'data'),
    ...options.env,
  });
  const clock: Clock = { t: Date.now(), now: () => clock.t };
  const app = await buildApp(config, {
    ...options.deps,
    auth: { now: clock.now, rateLimitMax: 1000, ...options.auth },
  });
  await app.ready();
  return {
    app,
    config,
    clock,
    musicDir,
    stagingDir,
    cleanup: async () => {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface Credentials {
  cookie: string;
  csrf: string;
}

/** `name=value` for every cookie a response set, ready for a Cookie request header. */
export function cookieHeader(res: LightMyRequestResponse): string {
  return res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Insert a local user straight through the service and return its id. */
export async function addUser(
  app: FastifyInstance,
  username: string,
  permissions: number,
  password = PASSWORD,
): Promise<string> {
  return app.hearer.users.createLocal({
    username,
    passwordHash: await hashPassword(password),
    permissions,
  }).id;
}

export async function login(
  app: FastifyInstance,
  username: string,
  password = PASSWORD,
): Promise<Credentials> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return { cookie: cookieHeader(res), csrf: res.json<SessionResponse>().csrfToken };
}

/** Run the minimum wizard: first admin, then complete. Returns the admin's credentials. */
export async function completeSetup(h: Harness, username = 'admin'): Promise<Credentials> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/setup/admin',
    payload: { username, password: PASSWORD },
  });
  if (res.statusCode !== 201) throw new Error(`setup/admin failed: ${res.statusCode} ${res.body}`);
  const creds = { cookie: cookieHeader(res), csrf: res.json<SessionResponse>().csrfToken };
  const done = await call(h.app, creds, 'POST', '/api/v1/setup/complete');
  if (done.statusCode !== 200) throw new Error(`setup/complete failed: ${done.body}`);
  return creds;
}

/** An authenticated request (cookie + CSRF header on writes). Pass `creds` undefined for anonymous. */
export function call(
  app: FastifyInstance,
  creds: Credentials | undefined,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const merged: Record<string, string> = { ...headers };
  if (creds) {
    merged.cookie = creds.cookie;
    if (method !== 'GET') merged['x-csrf-token'] = creds.csrf;
  }
  return app.inject({
    method,
    url,
    headers: merged,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

export const ROLES = {
  user: Permission.REQUEST | Permission.REQUEST_ALBUM | Permission.UPLOAD,
  manager: Permission.MANAGE_USERS | Permission.MANAGE_SETTINGS | Permission.REQUEST,
  admin: Permission.ADMIN,
} as const;
