import {
  Permission,
  notificationAgentsResponseSchema,
  notificationCandidateTestSchema,
  notificationTargetDtoSchema,
  notificationTargetInputSchema,
  notificationTargetsResponseSchema,
  notificationTestResultSchema,
  userNotificationsResponseSchema,
  userNotifyPrefsSchema,
} from '@hearer/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../auth/guard.ts';
import { unauthorized } from '../lib/http-error.ts';

const idParams = z.object({ id: z.string().min(1) });

/**
 * Notification targets (MANAGE_SETTINGS) and the signed-in user's own notification preferences.
 * Secrets are masked in every response; sending back the masked value keeps the stored secret.
 */
export const notificationRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  const { notifications } = app.hearer;
  const admin = [requirePermission(Permission.MANAGE_SETTINGS)];
  const tags = ['notifications'];

  app.get(
    '/notifications/agents',
    {
      onRequest: admin,
      schema: {
        tags,
        summary: 'Notification agents with their config JSON Schema, and the events',
        description:
          'Secret properties carry `x-secret: true` in `configSchema`. `defaultConfig` seeds a new target form.',
        response: { 200: notificationAgentsResponseSchema },
      },
    },
    () => ({ agents: notifications.agents(), events: notifications.eventInfo() }),
  );

  app.get(
    '/notifications/targets',
    {
      onRequest: admin,
      schema: {
        tags,
        summary: 'List notification targets (secrets masked)',
        response: { 200: notificationTargetsResponseSchema },
      },
    },
    () => ({ targets: notifications.listTargets() }),
  );

  app.post(
    '/notifications/targets',
    {
      onRequest: admin,
      schema: {
        tags,
        summary: 'Create a notification target',
        body: notificationTargetInputSchema,
        response: { 201: notificationTargetDtoSchema },
      },
    },
    async (request, reply) => {
      const created = notifications.createTarget(request.body);
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/notifications/targets/:id',
    {
      onRequest: admin,
      schema: {
        tags,
        summary: 'One notification target (secrets masked)',
        params: idParams,
        response: { 200: notificationTargetDtoSchema },
      },
    },
    (request) => notifications.getTarget(request.params.id),
  );

  app.put(
    '/notifications/targets/:id',
    {
      onRequest: admin,
      schema: {
        tags,
        summary: 'Replace a notification target',
        description:
          'A masked secret (`********`) keeps the stored value; an empty string clears it. The agent cannot change.',
        params: idParams,
        body: notificationTargetInputSchema,
        response: { 200: notificationTargetDtoSchema },
      },
    },
    (request) => notifications.updateTarget(request.params.id, request.body),
  );

  app.delete(
    '/notifications/targets/:id',
    {
      onRequest: admin,
      schema: {
        tags,
        summary: 'Delete a notification target',
        params: idParams,
      },
    },
    async (request, reply) => {
      notifications.deleteTarget(request.params.id);
      return reply.code(204).send();
    },
  );

  app.post(
    '/notifications/targets/:id/test',
    {
      onRequest: admin,
      schema: {
        tags,
        summary: 'Send a test notification to a saved target',
        description: 'Always answers 200; `ok` tells whether the destination accepted it.',
        params: idParams,
        response: { 200: notificationTestResultSchema },
      },
    },
    (request) => notifications.testTarget(request.params.id),
  );

  app.post(
    '/notifications/test',
    {
      onRequest: admin,
      schema: {
        tags,
        summary: 'Send a test notification with an unsaved config',
        description:
          'Always answers 200 for a valid config; `ok` tells whether the destination accepted it. Masked secrets resolve against `targetId` when given.',
        body: notificationCandidateTestSchema,
        response: { 200: notificationTestResultSchema },
      },
    },
    (request) =>
      notifications.testCandidate(request.body.agent, request.body.config, request.body.targetId),
  );

  const own = [requireAuth()];

  app.get(
    '/auth/me/notifications',
    {
      onRequest: own,
      schema: {
        tags,
        summary: 'Your own notification preferences and what is available to you',
        response: { 200: userNotificationsResponseSchema },
      },
    },
    (request) => {
      if (!request.user) throw unauthorized();
      return notifications.userNotifications(request.user.id);
    },
  );

  app.put(
    '/auth/me/notifications',
    {
      onRequest: own,
      schema: {
        tags,
        summary: 'Replace your own notification preferences',
        body: userNotifyPrefsSchema,
        response: { 200: userNotificationsResponseSchema },
      },
    },
    (request) => {
      if (!request.user) throw unauthorized();
      return notifications.setUserPrefs(request.user.id, request.body);
    },
  );

  done();
};
