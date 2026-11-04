import {
  Permission,
  createRequestBodySchema,
  declineRequestBodySchema,
  requestCountsQuerySchema,
  requestCountsSchema,
  requestDetailDtoSchema,
  requestDtoSchema,
  requestListQuerySchema,
  requestListResponseSchema,
  requestQuotaSchema,
} from '@hearer/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../auth/guard.ts';
import { unauthorized } from '../lib/http-error.ts';
import type { AuthUser } from '../services/users.ts';

/** Guards run first, so this only narrows the type. */
const currentUser = (request: FastifyRequest): AuthUser => {
  if (!request.user) throw unauthorized();
  return request.user;
};

const idParams = z.object({ id: z.string().min(1).max(64) });
const tags = ['requests'];

/**
 * /api/v1/requests. Visibility and ownership rules live in `RequestsService`; the guards here
 * only decide who may reach the handler:
 *   - create needs at least one of REQUEST / REQUEST_ALBUM / REQUEST_ARTIST (the service checks
 *     the one that matches the type);
 *   - list/get/cancel/quota/counts are open to any signed-in user and scoped to their own
 *     requests unless they hold VIEW_ALL_REQUESTS or MANAGE_REQUESTS (non-owners get 404);
 *   - approve/decline/retry need MANAGE_REQUESTS.
 */
export const requestRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  const { requests } = app.hearer;
  const manage = [requirePermission(Permission.MANAGE_REQUESTS)];
  const authed = [requireAuth()];
  const creators = [
    requirePermission([Permission.REQUEST, Permission.REQUEST_ALBUM, Permission.REQUEST_ARTIST], {
      type: 'or',
    }),
  ];

  app.post(
    '/requests',
    {
      onRequest: creators,
      schema: {
        tags,
        summary: 'Request a track, album or artist',
        description:
          'Resolves the title from MusicBrainz. 409 `already_requested` (details.requestId) for an active duplicate, 409 `already_available` when the library has it, 429 `quota_exceeded` (details: limit, used, resetsAt). Users with AUTO_APPROVE get an APPROVED request.',
        body: createRequestBodySchema,
        response: { 201: requestDtoSchema },
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      const controller = new AbortController();
      // Abort only when the connection drops before the answer is sent (an IncomingMessage also
      // emits `close` once its body is read, which is not a disconnect).
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) controller.abort();
      });
      const created = await requests.create(user, request.body, { signal: controller.signal });
      void reply.status(201);
      return created;
    },
  );

  app.get(
    '/requests',
    {
      onRequest: authed,
      schema: {
        tags,
        summary: "List requests (your own, or everyone's with ?all=1)",
        querystring: requestListQuerySchema,
        response: { 200: requestListResponseSchema },
      },
    },
    (request) => requests.list(request.query, currentUser(request)),
  );

  app.get(
    '/requests/counts',
    {
      onRequest: authed,
      schema: {
        tags,
        summary: 'Request counts per status',
        querystring: requestCountsQuerySchema,
        response: { 200: requestCountsSchema },
      },
    },
    (request) => requests.counts(request.query, currentUser(request)),
  );

  app.get(
    '/requests/quota',
    {
      onRequest: authed,
      schema: {
        tags,
        summary: 'Your request quota and how much of it is used',
        response: { 200: requestQuotaSchema },
      },
    },
    (request) => requests.quota(currentUser(request)),
  );

  app.get(
    '/requests/:id',
    {
      onRequest: authed,
      schema: {
        tags,
        summary: 'One request with its timeline',
        params: idParams,
        response: { 200: requestDetailDtoSchema },
      },
    },
    (request) => requests.getVisible(request.params.id, currentUser(request)),
  );

  app.post(
    '/requests/:id/approve',
    {
      onRequest: manage,
      schema: {
        tags,
        summary: 'Approve a pending request',
        params: idParams,
        response: { 200: requestDtoSchema },
      },
    },
    (request) => requests.approve(request.params.id, currentUser(request)),
  );

  app.post(
    '/requests/:id/decline',
    {
      onRequest: manage,
      schema: {
        tags,
        summary: 'Decline a pending request',
        params: idParams,
        body: declineRequestBodySchema,
        response: { 200: requestDtoSchema },
      },
    },
    (request) => requests.decline(request.params.id, currentUser(request), request.body.reason),
  );

  app.post(
    '/requests/:id/retry',
    {
      onRequest: manage,
      schema: {
        tags,
        summary: 'Retry a failed request',
        params: idParams,
        response: { 200: requestDtoSchema },
      },
    },
    (request) => requests.retry(request.params.id, currentUser(request)),
  );

  app.post(
    '/requests/:id/cancel',
    {
      onRequest: authed,
      schema: {
        tags,
        summary: 'Cancel a request (the requester, or a request manager)',
        params: idParams,
        response: { 200: requestDtoSchema },
      },
    },
    (request) => requests.cancel(request.params.id, currentUser(request)),
  );

  done();
};
