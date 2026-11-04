import { z } from 'zod';
import {
  NOTIFICATION_AGENTS,
  NOTIFICATION_EVENTS,
  SUBSCRIBABLE_NOTIFICATION_EVENTS,
} from '../enums.ts';

export const notificationEventSchema = z.enum(NOTIFICATION_EVENTS);
/** Events a target or user can subscribe to; `test` is only sent by the test actions. */
export const subscribableEventSchema = z.enum(SUBSCRIBABLE_NOTIFICATION_EVENTS);
export const notificationAgentIdSchema = z.enum(NOTIFICATION_AGENTS);

/** What an agent sends: the rendered notification (also snapshotted in the `notify.send` job). */
export const notificationMessageSchema = z.object({
  event: notificationEventSchema,
  title: z.string(),
  body: z.string(),
  /** Deep link into Hearer (needs `general.applicationUrl`); null when that is not set. */
  url: z.string().nullable(),
  /** Cover art. */
  imageUrl: z.string().nullable(),
  fields: z.array(z.object({ name: z.string(), value: z.string() })),
  /** Display name of the person behind the change; null for the system. */
  actor: z.string().nullable(),
  /** Request/upload summary. */
  subject: z
    .object({
      kind: z.enum(['request', 'upload', 'test']),
      id: z.string(),
      title: z.string(),
      artist: z.string().nullable(),
      /** track | album | artist for requests. */
      type: z.string().nullable(),
      status: z.string().nullable(),
    })
    .nullable(),
  /** The application title, for subjects and footers. */
  appTitle: z.string(),
  /** ISO timestamp the notification was created. */
  timestamp: z.string(),
  /** Raw structured event data (ids, statuses, scores) for machine consumers such as webhooks. */
  data: z.record(z.string(), z.unknown()),
});
export type NotificationMessage = z.infer<typeof notificationMessageSchema>;

export const notificationAgentInfoSchema = z.object({
  id: notificationAgentIdSchema,
  label: z.string(),
  description: z.string(),
  /** JSON Schema of the agent's config; secret properties carry `x-secret: true`. */
  configSchema: z.record(z.string(), z.unknown()),
  /** Config values a new target of this agent starts with. */
  defaultConfig: z.record(z.string(), z.unknown()),
});
export type NotificationAgentInfo = z.infer<typeof notificationAgentInfoSchema>;

export const notificationEventInfoSchema = z.object({
  id: notificationEventSchema,
  label: z.string(),
  description: z.string(),
  /** Whether targets and users can subscribe to it. */
  subscribable: z.boolean(),
});
export type NotificationEventInfo = z.infer<typeof notificationEventInfoSchema>;

export const notificationAgentsResponseSchema = z.object({
  agents: z.array(notificationAgentInfoSchema),
  events: z.array(notificationEventInfoSchema),
});
export type NotificationAgentsResponse = z.infer<typeof notificationAgentsResponseSchema>;

export const notificationTargetDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  agent: notificationAgentIdSchema,
  /** The config with secrets masked (`********` when set, empty when not). */
  config: z.record(z.string(), z.unknown()),
  events: z.array(subscribableEventSchema),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type NotificationTargetDto = z.infer<typeof notificationTargetDtoSchema>;

export const notificationTargetsResponseSchema = z.object({
  targets: z.array(notificationTargetDtoSchema),
});
export type NotificationTargetsResponse = z.infer<typeof notificationTargetsResponseSchema>;

/** Create and update (PUT replaces the target; a masked secret keeps the stored one). */
export const notificationTargetInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  agent: notificationAgentIdSchema,
  config: z.record(z.string(), z.unknown()),
  events: z.array(subscribableEventSchema).max(SUBSCRIBABLE_NOTIFICATION_EVENTS.length),
  enabled: z.boolean().default(true),
});
export type NotificationTargetInput = z.input<typeof notificationTargetInputSchema>;

/** Test an unsaved candidate. `targetId` resolves masked secrets against that stored target. */
export const notificationCandidateTestSchema = z.object({
  agent: notificationAgentIdSchema,
  config: z.record(z.string(), z.unknown()),
  targetId: z.string().optional(),
});
export type NotificationCandidateTest = z.infer<typeof notificationCandidateTestSchema>;

export const notificationTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
});
export type NotificationTestResult = z.infer<typeof notificationTestResultSchema>;

// ---- per-user opt-in ----

/** Stored in `users.notify_prefs`. Users only ever hear about their own requests and uploads. */
export const userNotifyPrefsSchema = z.object({
  email: z
    .object({
      enabled: z.boolean().default(false),
      events: z.array(subscribableEventSchema).default([]),
    })
    .optional(),
  ntfy: z
    .object({
      /** The ntfy topic to publish to. Treat it like a password: anyone who knows it can read it. */
      topic: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_-]{1,64}$/, 'letters, digits, _ and - only (max 64)'),
      events: z.array(subscribableEventSchema).default([]),
    })
    .optional(),
});
export type UserNotifyPrefs = z.infer<typeof userNotifyPrefsSchema>;

export const userNotificationsResponseSchema = z.object({
  prefs: userNotifyPrefsSchema,
  /** Whether the channels can work right now, and why not. */
  email: z.object({
    available: z.boolean(),
    address: z.string().nullable(),
    reason: z.string().nullable(),
  }),
  ntfy: z.object({
    available: z.boolean(),
    /** The ntfy server personal topics are published to. */
    server: z.string(),
  }),
  events: z.array(notificationEventInfoSchema),
});
export type UserNotificationsResponse = z.infer<typeof userNotificationsResponseSchema>;
