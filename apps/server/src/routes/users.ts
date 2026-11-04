import {
  Permission,
  createUserRequestSchema,
  resetPasswordRequestSchema,
  updateUserRequestSchema,
  userDtoSchema,
  userListQuerySchema,
  userListResponseSchema,
} from '@hearer/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requirePermission } from '../auth/guard.ts';
import { hashPassword } from '../auth/password.ts';
import { HttpError, forbidden, notFound, unauthorized } from '../lib/http-error.ts';
import { toUserDto, type AuthUser, type UserRow } from '../services/users.ts';

const idParams = z.object({ id: z.string().min(1).max(64) });
const isAdmin = (permissions: number): boolean => (permissions & Permission.ADMIN) !== 0;

/**
 * Privilege-escalation guard 1: you may only grant bits you hold yourself (administrators may
 * grant anything). `current` is what the target already has, so unchanged bits are fine.
 */
function assertCanGrant(actor: AuthUser, current: number, requested: number): void {
  if (isAdmin(actor.permissions)) return;
  const added = requested & ~current;
  if ((added & ~actor.permissions) !== 0) {
    throw forbidden('You cannot grant permissions you do not hold', 'privilege_escalation');
  }
}

/** Everyday abilities. Everything else (ADMIN, MANAGE_*, AUTO_APPROVE*, ...) is privileged. */
const BASIC_PERMISSIONS =
  Permission.REQUEST | Permission.REQUEST_ALBUM | Permission.REQUEST_ARTIST | Permission.UPLOAD;

/**
 * Guard 2: you may not act on a user who holds a privileged permission you lack. Without this,
 * a delegated user manager could reset an administrator's password and take the account.
 * Ordinary users (only basic request/upload bits) are always manageable.
 */
function assertCanManage(actor: AuthUser, target: UserRow): void {
  if (isAdmin(actor.permissions)) return;
  if ((target.permissions & ~BASIC_PERMISSIONS & ~actor.permissions) !== 0) {
    throw forbidden(
      'You cannot manage a user with privileges you do not hold',
      'privilege_escalation',
    );
  }
}

/** Routes under /api/v1/users (MANAGE_USERS). */
export const userRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  const { users, sessions } = app.hearer;
  const guard = [requirePermission(Permission.MANAGE_USERS)];

  const load = (id: string): UserRow => {
    const row = users.get(id);
    if (!row) throw notFound('User not found');
    return row;
  };

  app.get(
    '/users',
    {
      onRequest: guard,
      schema: {
        tags: ['users'],
        summary: 'List users (paginated, searchable)',
        querystring: userListQuerySchema,
        response: { 200: userListResponseSchema },
      },
    },
    (request) => {
      const { page, pageSize, q } = request.query;
      const { items, total } = users.list({ page, pageSize, q });
      return { items: items.map(toUserDto), total, page, pageSize };
    },
  );

  app.get(
    '/users/:id',
    {
      onRequest: guard,
      schema: {
        tags: ['users'],
        summary: 'Get a user',
        params: idParams,
        response: { 200: userDtoSchema },
      },
    },
    (request) => toUserDto(load(request.params.id)),
  );

  app.post(
    '/users',
    {
      onRequest: guard,
      schema: {
        tags: ['users'],
        summary: 'Create a local user',
        body: createUserRequestSchema,
        response: { 201: userDtoSchema },
      },
    },
    async (request, reply) => {
      const actor = request.user;
      if (!actor) throw unauthorized();
      const { username, password, email, displayName, permissions } = request.body;
      // Only an explicit request is checked; the configured defaults are admin policy.
      if (permissions !== undefined) assertCanGrant(actor, 0, permissions);
      const passwordHash = await hashPassword(password);
      const row = users.createLocal({ username, passwordHash, email, displayName, permissions });
      return reply.code(201).send(toUserDto(row));
    },
  );

  app.patch(
    '/users/:id',
    {
      onRequest: guard,
      schema: {
        tags: ['users'],
        summary: 'Update display name, email, permissions or quotas',
        params: idParams,
        body: updateUserRequestSchema,
        response: { 200: userDtoSchema },
      },
    },
    (request) => {
      const actor = request.user;
      if (!actor) throw unauthorized();
      const target = load(request.params.id);
      assertCanManage(actor, target);
      if (request.body.permissions !== undefined) {
        assertCanGrant(actor, target.permissions, request.body.permissions);
      }
      const updated = users.update(target.id, request.body);
      if (!updated) throw notFound('User not found');
      return toUserDto(updated);
    },
  );

  app.delete(
    '/users/:id',
    {
      onRequest: guard,
      schema: { tags: ['users'], summary: 'Delete a user', params: idParams },
    },
    async (request, reply) => {
      const actor = request.user;
      if (!actor) throw unauthorized();
      const target = load(request.params.id);
      if (target.id === actor.id) {
        throw new HttpError(409, 'cannot_delete_self', 'You cannot delete your own account');
      }
      assertCanManage(actor, target);
      if (!users.delete(target.id)) throw notFound('User not found');
      return reply.code(204).send();
    },
  );

  app.post(
    '/users/:id/password',
    {
      onRequest: guard,
      schema: {
        tags: ['users'],
        summary: "Reset a local user's password (signs them out everywhere)",
        params: idParams,
        body: resetPasswordRequestSchema,
      },
    },
    async (request, reply) => {
      const actor = request.user;
      if (!actor) throw unauthorized();
      const target = load(request.params.id);
      if (target.authType !== 'local') {
        throw new HttpError(
          400,
          'password_not_supported',
          'This account signs in through an external provider',
        );
      }
      if (target.id === actor.id) {
        throw new HttpError(
          400,
          'use_password_change',
          'Change your own password via /auth/password',
        );
      }
      assertCanManage(actor, target);
      users.setPasswordHash(target.id, await hashPassword(request.body.newPassword));
      sessions.destroyAllForUser(target.id);
      return reply.code(204).send();
    },
  );
  done();
};
