import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import {
  permissionNames,
  sessionResponseSchema,
  setupAdminRequestSchema,
  setupStatusSchema,
  type DirCheck,
  type SetupStatus,
} from '@hearer/shared';
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requirePermission } from '../auth/guard.ts';
import { hashPassword } from '../auth/password.ts';
import { Permission } from '../auth/permissions.ts';
import type { Config } from '../config.ts';
import { API_PREFIX } from '../lib/constants.ts';
import { HttpError, conflict } from '../lib/http-error.ts';
import { toUserDto } from '../services/users.ts';
import { parseSettingsKey, saveSettingsSection } from './settings.ts';

/** Sections the wizard may save. Media server, OIDC and notifications get their own routes. */
export const SETUP_SECTIONS = ['general', 'library', 'uploads'] as const;

/** Routes that stay reachable before setup is complete. */
const OPEN_BEFORE_SETUP = ['health', 'auth', 'setup', 'openapi.json'].map(
  (name) => `${API_PREFIX}/${name}`,
);

/** Gated until setup completes even though it lives under the open `auth` prefix. */
const OIDC_PREFIX = `${API_PREFIX}/auth/oidc`;

/**
 * Until the wizard finishes, every API route outside health, auth, setup and the OpenAPI
 * document answers 503 `setup_required`. Unknown routes still 404, and non-API paths (the web
 * app) are untouched.
 */
export function registerSetupGate(app: FastifyInstance): void {
  app.addHook('onRequest', (request) => {
    if (request.is404) return Promise.resolve();
    const url = request.routeOptions.url ?? '';
    if (!url.startsWith(`${API_PREFIX}/`)) return Promise.resolve();
    // Single sign-on can never bootstrap Hearer: the local admin from the wizard configures it.
    if (url === OIDC_PREFIX || url.startsWith(`${OIDC_PREFIX}/`)) {
      if (!app.hearer.settings.get('general').setupComplete) {
        throw new HttpError(503, 'setup_required', 'Setup is not complete');
      }
      return Promise.resolve();
    }
    if (OPEN_BEFORE_SETUP.some((open) => url === open || url.startsWith(`${open}/`))) {
      return Promise.resolve();
    }
    if (!app.hearer.settings.get('general').setupComplete) {
      throw new HttpError(503, 'setup_required', 'Setup is not complete');
    }
    return Promise.resolve();
  });
}

/** Whether a directory exists and the server can read, write and enter it. */
export async function checkDirectory(path: string): Promise<DirCheck> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      return { path, exists: true, writable: false, error: 'Not a directory' };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      path,
      exists: false,
      writable: false,
      error: code === 'ENOENT' ? 'Does not exist' : `Cannot access (${code ?? 'error'})`,
    };
  }
  try {
    await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
    return { path, exists: true, writable: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { path, exists: true, writable: false, error: `Not writable (${code ?? 'error'})` };
  }
}

export async function buildSetupStatus(
  app: FastifyInstance,
  config: Pick<Config, 'musicDir' | 'stagingDir'>,
): Promise<SetupStatus> {
  const setupComplete = app.hearer.settings.get('general').setupComplete;
  const hasAdmin = app.hearer.users.hasAdmin();
  const [library, staging] = await Promise.all([
    checkDirectory(config.musicDir),
    checkDirectory(config.stagingDir),
  ]);
  const directories = library.writable && staging.writable;
  return {
    setupComplete,
    hasAdmin,
    steps: { admin: hasAdmin, directories },
    // Paths are only useful (and only shown) to someone running the wizard.
    ...(setupComplete ? {} : { directories: { library, staging } }),
  };
}

const sectionParams = z.object({ section: z.enum(SETUP_SECTIONS) });
const sectionBody = z.record(z.string(), z.unknown());

export function setupRoutes(
  config: Pick<Config, 'musicDir' | 'stagingDir'>,
): FastifyPluginCallbackZod {
  return (app, _options, done) => {
    const { users, settings, auth } = app.hearer;
    const adminOnly = [requirePermission(Permission.ADMIN)];

    const assertSetupOpen = () => {
      if (settings.get('general').setupComplete) {
        throw conflict('setup_already_complete', 'Setup is already complete; use /settings');
      }
    };

    app.get(
      '/setup/status',
      {
        schema: {
          tags: ['setup'],
          summary: 'Setup wizard progress (public)',
          response: { 200: setupStatusSchema },
        },
      },
      () => buildSetupStatus(app, config),
    );

    app.post(
      '/setup/admin',
      {
        // Creates the first session; there is none to protect yet.
        config: { csrfExempt: true, rateLimit: auth.rateLimit },
        schema: {
          tags: ['setup'],
          summary: 'Create the first administrator (only while no users exist)',
          body: setupAdminRequestSchema,
          response: { 201: sessionResponseSchema },
        },
      },
      async (request, reply) => {
        const taken = () => conflict('setup_admin_exists', 'An administrator already exists');
        // Cheap early exit so strangers cannot make the server hash for nothing.
        if (users.hasAnyUser()) throw taken();
        const { username, password, email, displayName } = request.body;
        const passwordHash = await hashPassword(password);
        // Atomic: check-and-insert in one write transaction, so exactly one caller wins.
        const row = users.createFirstAdmin({ username, passwordHash, email, displayName });
        if (!row) throw taken();
        users.touchLogin(row.id);
        const session = auth.startSession(request, reply, row.id);
        return reply.code(201).send({
          user: toUserDto(users.get(row.id) ?? row),
          permissions: permissionNames(row.permissions),
          csrfToken: session.csrfToken,
        });
      },
    );

    app.get(
      '/setup/:section',
      {
        onRequest: adminOnly,
        schema: {
          tags: ['setup'],
          summary: 'Current value of a wizard section (secrets masked)',
          params: sectionParams,
          response: { 200: z.record(z.string(), z.unknown()) },
        },
      },
      (request) =>
        settings.getPublic()[parseSettingsKey(request.params.section)] as Record<string, unknown>,
    );

    app.put(
      '/setup/:section',
      {
        onRequest: adminOnly,
        schema: {
          tags: ['setup'],
          summary: 'Save a wizard section',
          params: sectionParams,
          body: sectionBody,
          response: { 200: z.record(z.string(), z.unknown()) },
        },
      },
      (request) => {
        assertSetupOpen();
        return saveSettingsSection(
          settings,
          parseSettingsKey(request.params.section),
          request.body,
        );
      },
    );

    app.post(
      '/setup/complete',
      {
        onRequest: adminOnly,
        schema: {
          tags: ['setup'],
          summary: 'Finish the wizard',
          response: { 200: setupStatusSchema },
        },
      },
      async () => {
        assertSetupOpen();
        const status = await buildSetupStatus(app, config);
        if (!status.steps.directories) {
          throw new HttpError(
            400,
            'directories_not_ready',
            'The library and staging directories must exist and be writable',
            status.directories,
          );
        }
        settings.set('general', { ...settings.get('general'), setupComplete: true });
        return buildSetupStatus(app, config);
      },
    );
    done();
  };
}
