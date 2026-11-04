import {
  apiKeyDtoSchema,
  changePasswordRequestSchema,
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
  loginRequestSchema,
  meResponseSchema,
  permissionNames,
  sessionResponseSchema,
  updateProfileRequestSchema,
  type ApiKeyDto,
} from '@hearer/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { TooManyKeysError, type ApiKeyRow } from '../auth/apikeys.ts';
import { requireAuth, requireSession } from '../auth/guard.ts';
import { hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from '../auth/password.ts';
import { HttpError, notFound, unauthorized } from '../lib/http-error.ts';
import { toUserDto } from '../services/users.ts';

const invalidCredentials = () =>
  new HttpError(401, 'invalid_credentials', 'Invalid username or password');

export const toApiKeyDto = (row: ApiKeyRow): ApiKeyDto => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
});

/** Routes under /api/v1/auth. */
export const authRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  const { users, sessions, apiKeys, settings, auth } = app.hearer;
  const rateLimit = auth.rateLimit;

  app.post(
    '/auth/login',
    {
      // Creates a session; it does not depend on an existing one.
      config: { csrfExempt: true, rateLimit },
      schema: {
        tags: ['auth'],
        summary: 'Sign in with a local account',
        body: loginRequestSchema,
        response: { 200: sessionResponseSchema },
      },
    },
    async (request, reply) => {
      if (!settings.get('auth').localEnabled) {
        throw new HttpError(403, 'local_auth_disabled', 'Local sign-in is disabled');
      }
      const { username, password } = request.body;
      const row = users.getByUsername(username);
      if (row?.authType !== 'local' || !row.passwordHash) {
        // Burn the same time as a real check so unknown accounts are not detectable by timing.
        await verifyAgainstDummy(password);
        throw invalidCredentials();
      }
      if (!(await verifyPassword(row.passwordHash, password))) throw invalidCredentials();
      if (needsRehash(row.passwordHash)) {
        users.setPasswordHash(row.id, await hashPassword(password));
      }
      users.touchLogin(row.id);
      const session = auth.startSession(request, reply, row.id);
      const fresh = users.get(row.id) ?? row;
      return {
        user: toUserDto(fresh),
        permissions: permissionNames(fresh.permissions),
        csrfToken: session.csrfToken,
      };
    },
  );

  app.post(
    '/auth/logout',
    {
      // Public on purpose: signing out with an expired session must still clear the cookie.
      schema: { tags: ['auth'], summary: 'End the current session' },
    },
    async (request, reply) => {
      if (request.auth?.method === 'session') sessions.destroy(request.auth.sessionId);
      auth.clearSessionCookie(reply);
      return reply.code(204).send();
    },
  );

  app.post(
    '/auth/logout-all',
    {
      onRequest: [requireAuth()],
      schema: { tags: ['auth'], summary: 'End every session of the current user' },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) throw unauthorized();
      sessions.destroyAllForUser(user.id);
      auth.clearSessionCookie(reply);
      return reply.code(204).send();
    },
  );

  app.get(
    '/auth/me',
    {
      onRequest: [requireAuth()],
      schema: {
        tags: ['auth'],
        summary: 'The current user, permissions and CSRF token',
        response: { 200: meResponseSchema },
      },
    },
    (request) => {
      const current = request.user;
      const method = request.auth;
      if (!current || !method) throw unauthorized();
      const row = users.get(current.id);
      if (!row) throw unauthorized();
      return {
        user: toUserDto(row),
        permissions: permissionNames(row.permissions),
        csrfToken: method.method === 'session' ? method.csrfToken : null,
        authMethod: method.method,
      };
    },
  );

  app.patch(
    '/auth/me',
    {
      onRequest: [requireSession()],
      schema: {
        tags: ['auth'],
        summary: 'Edit your own display name or email (local accounts)',
        body: updateProfileRequestSchema,
        response: { 200: meResponseSchema },
      },
    },
    (request) => {
      const current = request.user;
      const method = request.auth;
      if (!current || method?.method !== 'session') throw unauthorized();
      const row = users.get(current.id);
      if (!row) throw unauthorized();
      if (row.authType !== 'local') {
        throw new HttpError(
          400,
          'profile_not_editable',
          'This account takes its profile from the sign-in provider',
        );
      }
      const updated = users.update(row.id, request.body);
      if (!updated) throw unauthorized();
      return {
        user: toUserDto(updated),
        permissions: permissionNames(updated.permissions),
        csrfToken: method.csrfToken,
        authMethod: method.method,
      };
    },
  );

  app.post(
    '/auth/password',
    {
      onRequest: [requireSession()],
      config: { rateLimit },
      schema: {
        tags: ['auth'],
        summary: 'Change your own password (signs out your other sessions)',
        body: changePasswordRequestSchema,
      },
    },
    async (request, reply) => {
      const current = request.user;
      const method = request.auth;
      if (!current || method?.method !== 'session') throw unauthorized();
      const row = users.get(current.id);
      if (row?.authType !== 'local' || !row.passwordHash) {
        throw new HttpError(
          400,
          'password_not_supported',
          'This account signs in through an external provider',
        );
      }
      const { currentPassword, newPassword } = request.body;
      if (!(await verifyPassword(row.passwordHash, currentPassword))) {
        throw new HttpError(400, 'invalid_current_password', 'The current password is incorrect');
      }
      users.setPasswordHash(row.id, await hashPassword(newPassword));
      sessions.destroyAllForUser(row.id, method.sessionId);
      return reply.code(204).send();
    },
  );

  app.get(
    '/auth/api-keys',
    {
      onRequest: [requireSession()],
      schema: {
        tags: ['auth'],
        summary: 'List your API keys',
        response: { 200: z.object({ items: z.array(apiKeyDtoSchema) }) },
      },
    },
    (request) => {
      if (!request.user) throw unauthorized();
      return { items: apiKeys.list(request.user.id).map(toApiKeyDto) };
    },
  );

  app.post(
    '/auth/api-keys',
    {
      onRequest: [requireSession()],
      schema: {
        tags: ['auth'],
        summary: 'Create an API key (the secret is shown once)',
        body: createApiKeyRequestSchema,
        response: { 201: createApiKeyResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.user) throw unauthorized();
      try {
        const { row, secret } = apiKeys.create(request.user.id, request.body.name);
        return await reply.code(201).send({ key: toApiKeyDto(row), secret });
      } catch (err) {
        if (err instanceof TooManyKeysError) {
          throw new HttpError(409, 'too_many_api_keys', err.message);
        }
        throw err;
      }
    },
  );

  app.delete(
    '/auth/api-keys/:id',
    {
      onRequest: [requireSession()],
      schema: {
        tags: ['auth'],
        summary: 'Delete one of your API keys',
        params: z.object({ id: z.string().min(1).max(64) }),
      },
    },
    async (request, reply) => {
      if (!request.user) throw unauthorized();
      if (!apiKeys.delete(request.user.id, request.params.id)) throw notFound('API key not found');
      return reply.code(204).send();
    },
  );
  done();
};
