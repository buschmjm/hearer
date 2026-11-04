import {
  NOTIFICATION_EVENTS,
  REDACTED_SECRET,
  SUBSCRIBABLE_NOTIFICATION_EVENTS,
  notificationEventBit,
  notificationEventsFromMask,
  notificationEventsToMask,
  userAgent,
  userNotifyPrefsSchema,
  type NotificationAgent as AgentId,
  type NotificationAgentInfo,
  type NotificationEvent,
  type NotificationEventInfo,
  type NotificationMessage,
  type NotificationTargetDto,
  type NotificationTargetInput,
  type NotificationTestResult,
  type UserNotificationsResponse,
  type UserNotifyPrefs,
  notificationMessageSchema,
} from '@hearer/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DEFAULT_NTFY_SERVER } from '../adapters/notify/ntfy.ts';
import { getAgent, listAgents } from '../adapters/notify/registry.ts';
import type { AgentContext, ErasedAgent } from '../adapters/notify/types.ts';
import type { Db } from '../db/client.ts';
import {
  notificationTargets,
  requests,
  uploads,
  users,
  type NotificationTarget,
} from '../db/schema.ts';
import type { JobRunner } from '../jobs/runner.ts';
import { PermanentJobError } from '../jobs/registry.ts';
import { HttpError, notFound } from '../lib/http-error.ts';
import { type EventBus, type HearerEventName, type HearerEvents } from '../lib/events.ts';
import { SecretError, type SecretBox } from '../lib/secrets.ts';
import type { SettingsService } from './settings.ts';

export const NOTIFY_JOB = 'notify.send';
export const NOTIFY_MAX_ATTEMPTS = 5;
export const DEFAULT_NOTIFY_TIMEOUT_MS = 10_000;

/** The `notify.send` payload. The rendered message is snapshotted so retries are stable. */
export const notifySendPayload = z.object({
  event: z.enum(NOTIFICATION_EVENTS),
  message: notificationMessageSchema,
  /** The target to deliver through; null for a personal ntfy topic on the default server. */
  targetId: z.string().nullable().default(null),
  /** Personal delivery: replaces the target's recipient / topic. */
  recipient: z
    .object({ email: z.string().optional(), ntfyTopic: z.string().optional() })
    .optional(),
});
export type NotifySendPayload = z.infer<typeof notifySendPayload>;

/** Bus events that become notifications. `request.cancelled` is deliberately not notified. */
const BUS_TO_NOTIFICATION: Partial<Record<HearerEventName, NotificationEvent>> = {
  'request.created': 'request.created',
  'request.approved': 'request.approved',
  'request.declined': 'request.declined',
  'request.available': 'request.available',
  'request.partially_available': 'request.partially_available',
  'request.failed': 'request.failed',
  'upload.needs_review': 'upload.needs_review',
  'upload.duplicate': 'upload.duplicate',
  'upload.imported': 'upload.imported',
  'upload.failed': 'upload.failed',
};

/**
 * English strings, in one place so a translation catalog can replace them later. Templates use
 * `{name}` placeholders (see `format`).
 */
export const EN = {
  events: {
    'request.created': {
      label: 'New request (awaiting approval)',
      description: 'Someone requested music that needs an approver.',
    },
    'request.approved': { label: 'Request approved', description: 'A request was approved.' },
    'request.declined': { label: 'Request declined', description: 'A request was declined.' },
    'request.available': {
      label: 'Request available',
      description: 'The requested music is in the library.',
    },
    'request.partially_available': {
      label: 'Request partly available',
      description: 'Some of the requested album or artist is in the library.',
    },
    'request.failed': { label: 'Request failed', description: 'A request could not be fulfilled.' },
    'upload.needs_review': {
      label: 'Upload needs review',
      description: 'An upload is waiting for a metadata review.',
    },
    'upload.duplicate': {
      label: 'Upload is a duplicate',
      description: 'An upload matches something already in the library.',
    },
    'upload.imported': {
      label: 'Upload imported',
      description: 'An upload was filed into the library.',
    },
    'upload.failed': { label: 'Upload failed', description: 'An upload could not be processed.' },
    test: { label: 'Test', description: 'Sent by the "send test" button.' },
  },
  templates: {
    'request.created': {
      title: 'New request awaiting approval',
      body: '{requester} requested the {type} "{title}"{by}.',
    },
    'request.approved': {
      title: 'Request approved',
      body: 'The {type} "{title}"{by} was approved.',
    },
    'request.declined': {
      title: 'Request declined',
      body: 'The {type} "{title}"{by} was declined.',
    },
    'request.available': {
      title: 'Now available',
      body: 'The {type} "{title}"{by} is now in the library.',
    },
    'request.partially_available': {
      title: 'Partly available',
      body: 'Part of the {type} "{title}"{by} is now in the library.',
    },
    'request.failed': {
      title: 'Request failed',
      body: 'The {type} "{title}"{by} could not be fulfilled.',
    },
    'upload.needs_review': {
      title: 'Upload needs review',
      body: '{uploader} uploaded "{name}", which is waiting for review.',
    },
    'upload.duplicate': {
      title: 'Duplicate upload',
      body: '{uploader} uploaded "{name}", which is already in the library.',
    },
    'upload.imported': {
      title: 'Upload imported',
      body: '"{name}" from {uploader} was added to the library.',
    },
    'upload.failed': {
      title: 'Upload failed',
      body: '"{name}" from {uploader} could not be processed.',
    },
  },
  fields: {
    type: 'Type',
    artist: 'Artist',
    requestedBy: 'Requested by',
    uploadedBy: 'Uploaded by',
    file: 'File',
    reason: 'Reason',
    details: 'Details',
    confidence: 'Match confidence',
    status: 'Status',
    agent: 'Agent',
  },
  test: {
    title: 'Test notification',
    body: 'This is a test from {app}. If you can read it, this destination works.',
  },
  unknownUser: 'Someone',
} as const;

/** Replace `{name}` placeholders; unknown names become empty. */
export function format(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => vars[name] ?? '');
}

type Json = Record<string, unknown>;

export interface NotificationServiceOptions {
  db: Db;
  secrets: SecretBox;
  settings: SettingsService;
  jobs: Pick<JobRunner, 'enqueue'>;
  events: EventBus;
  log: {
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
  version: string;
  /** Tests: fetch and the per-request timeout. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const toIso = (date: Date): string => date.toISOString();
const isEncryptedString = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('enc:v1:');

export class NotificationService {
  readonly #db: Db;
  readonly #box: SecretBox;
  readonly #settings: SettingsService;
  readonly #jobs: Pick<JobRunner, 'enqueue'>;
  readonly #events: EventBus;
  readonly #log: NotificationServiceOptions['log'];
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #userAgent: string;
  #unsubscribe: (() => void) | null = null;

  constructor(options: NotificationServiceOptions) {
    this.#db = options.db;
    this.#box = options.secrets;
    this.#settings = options.settings;
    this.#jobs = options.jobs;
    this.#events = options.events;
    this.#log = options.log;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS;
    this.#userAgent = userAgent(options.version);
  }

  // ---- catalog ------------------------------------------------------------------------------

  agents(): NotificationAgentInfo[] {
    return listAgents().map((agent) => ({
      id: agent.id,
      label: agent.label,
      description: agent.description,
      configSchema: agent.jsonSchema(),
      defaultConfig: agent.defaults(),
    }));
  }

  eventInfo(): NotificationEventInfo[] {
    return NOTIFICATION_EVENTS.map((id) => ({
      id,
      label: EN.events[id].label,
      description: EN.events[id].description,
      subscribable: id !== 'test',
    }));
  }

  // ---- bus subscription ---------------------------------------------------------------------

  /** Subscribe to the event bus. Idempotent. */
  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#events.onAny(
      Object.keys(BUS_TO_NOTIFICATION) as HearerEventName[],
      (name, payload) => {
        this.handleEvent(name, payload);
      },
    );
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /**
   * Turn a bus event into queued `notify.send` jobs: one per enabled target subscribed to it, plus
   * the personal email / ntfy of the user it concerns. Never throws and never waits on a
   * destination, so the flow that emitted the event is unaffected.
   */
  handleEvent<K extends HearerEventName>(name: K, payload: HearerEvents[K]): void {
    try {
      const event = BUS_TO_NOTIFICATION[name];
      if (!event) return;
      const built = this.#build(event, payload as unknown as Json);
      if (!built) return;
      this.#fanOut(built.message, built.userId);
    } catch (err) {
      this.#log.error({ err, event: name }, 'could not queue notifications');
    }
  }

  #enqueue(payload: NotifySendPayload): void {
    try {
      this.#jobs.enqueue(NOTIFY_JOB, payload);
    } catch (err) {
      this.#log.error(
        { err, event: payload.event, targetId: payload.targetId },
        'could not queue notify.send',
      );
    }
  }

  #fanOut(message: NotificationMessage, userId: string | null): void {
    const bit = notificationEventBit(message.event);
    const rows = this.#db
      .select()
      .from(notificationTargets)
      .where(eq(notificationTargets.enabled, true))
      .all();
    for (const row of rows) {
      if ((row.events & bit) === 0) continue;
      this.#enqueue({ event: message.event, message, targetId: row.id });
    }
    if (!userId) return;
    const user = this.#db.select().from(users).where(eq(users.id, userId)).get();
    const parsed = userNotifyPrefsSchema.safeParse(user?.notifyPrefs ?? {});
    if (!user || !parsed.success) return;
    const prefs = parsed.data;
    const subscribed = (events: readonly NotificationEvent[]): boolean =>
      events.includes(message.event);
    if (prefs.email?.enabled && subscribed(prefs.email.events) && user.email) {
      const smtp = this.#designated('smtp', 'userEmail');
      if (smtp) {
        this.#enqueue({
          event: message.event,
          message,
          targetId: smtp.id,
          recipient: { email: user.email },
        });
      }
    }
    if (prefs.ntfy && subscribed(prefs.ntfy.events)) {
      this.#enqueue({
        event: message.event,
        message,
        targetId: this.#designated('ntfy', 'userTopics')?.id ?? null,
        recipient: { ntfyTopic: prefs.ntfy.topic },
      });
    }
  }

  /** The enabled target of an agent whose config flag designates it for personal notifications. */
  #designated(agent: AgentId, flag: string): NotificationTarget | undefined {
    return this.#db
      .select()
      .from(notificationTargets)
      .where(and(eq(notificationTargets.agent, agent), eq(notificationTargets.enabled, true)))
      .all()
      .find((row) => row.configJson[flag] === true);
  }

  // ---- messages -----------------------------------------------------------------------------

  #base(): { appTitle: string; baseUrl: string } {
    const general = this.#settings.get('general');
    return { appTitle: general.appTitle, baseUrl: general.applicationUrl.replace(/\/+$/, '') };
  }

  #userName(id: string | null): string | null {
    if (!id) return null;
    const row = this.#db.select().from(users).where(eq(users.id, id)).get();
    if (!row) return null;
    const display = row.displayName?.trim();
    // An empty display name falls back to the username (hence not `??`).
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    return display ? display : row.username;
  }

  /** Render the message for a bus event; null means "do not notify" (stale or filtered out). */
  #build(
    event: NotificationEvent,
    payload: Json,
  ): { message: NotificationMessage; userId: string | null } | null {
    const { appTitle, baseUrl } = this.#base();
    const link = (path: string): string | null => (baseUrl ? `${baseUrl}${path}` : null);
    const template = EN.templates[event as keyof typeof EN.templates];
    const F = EN.fields;
    const fields: { name: string; value: string }[] = [];
    const add = (name: string, value: string | null | undefined): void => {
      if (value?.trim()) fields.push({ name, value: value.trim() });
    };
    const timestamp = new Date().toISOString();

    if (event.startsWith('request.')) {
      const id = typeof payload.requestId === 'string' ? payload.requestId : '';
      const row = this.#db.select().from(requests).where(eq(requests.id, id)).get();
      if (!row) return null;
      // An auto-approved request is announced by its approval, not as awaiting approval.
      if (event === 'request.created' && row.status !== 'PENDING') return null;
      const requester = this.#userName(row.requestedBy) ?? EN.unknownUser;
      const actorId = typeof payload.actorId === 'string' ? payload.actorId : null;
      const actor = this.#userName(actorId);
      const by = row.artistName && row.type !== 'artist' ? ` by ${row.artistName}` : '';
      const reason = typeof payload.declineReason === 'string' ? payload.declineReason : null;
      const note = typeof payload.note === 'string' ? payload.note : null;
      add(F.type, row.type);
      if (row.type !== 'artist') add(F.artist, row.artistName);
      add(F.requestedBy, requester);
      if (event === 'request.declined') add(F.reason, reason);
      if (event === 'request.failed') add(F.details, note);
      add(F.status, row.status);
      return {
        userId: row.requestedBy,
        message: {
          event,
          title: template.title,
          body: format(template.body, { requester, type: row.type, title: row.title, by }),
          url: link(`/requests/${row.id}`),
          imageUrl: row.coverUrl,
          fields,
          actor: event === 'request.created' ? requester : actor,
          subject: {
            kind: 'request',
            id: row.id,
            title: row.title,
            artist: row.artistName,
            type: row.type,
            status: row.status,
          },
          appTitle,
          timestamp,
          data: {
            requestId: row.id,
            type: row.type,
            mbid: row.mbid,
            title: row.title,
            artistName: row.artistName,
            status: row.status,
            from: payload.from ?? null,
            to: payload.to ?? row.status,
            requestedBy: row.requestedBy,
            actorId,
            declineReason: reason,
            note,
          },
        },
      };
    }

    // upload.*
    const uploadId = typeof payload.uploadId === 'string' ? payload.uploadId : '';
    const uploaderId = typeof payload.uploaderId === 'string' ? payload.uploaderId : null;
    const row = this.#db.select().from(uploads).where(eq(uploads.id, uploadId)).get();
    const uploader = this.#userName(uploaderId) ?? EN.unknownUser;
    const str = (key: string): string | null =>
      typeof payload[key] === 'string' && payload[key] !== '' ? payload[key] : null;
    const name = str('originalName') ?? row?.originalName ?? uploadId;
    const title = str('title');
    const artist = str('artist');
    const detail = str('detail') ?? str('reason') ?? str('error');
    const score = typeof payload.score === 'number' ? payload.score : null;
    add(F.file, name);
    add(F.uploadedBy, uploader);
    add(F.artist, artist);
    if (title && title !== name) add('Title', title);
    if (score !== null) add(F.confidence, `${String(Math.round(score * 100))}%`);
    add(F.details, detail);
    return {
      userId: uploaderId,
      message: {
        event,
        title: template.title,
        body: format(template.body, { uploader, name }),
        url: link(`/uploads/${uploadId}`),
        imageUrl: str('coverUrl'),
        fields,
        actor: uploader,
        subject: {
          kind: 'upload',
          id: uploadId,
          title: title ?? name,
          artist,
          type: null,
          status: row?.status ?? null,
        },
        appTitle,
        timestamp,
        data: {
          uploadId,
          uploaderId,
          originalName: name,
          title,
          artist,
          status: row?.status ?? null,
          score,
          detail,
        },
      },
    };
  }

  testMessage(agent: ErasedAgent): NotificationMessage {
    const { appTitle, baseUrl } = this.#base();
    return {
      event: 'test',
      title: EN.test.title,
      body: format(EN.test.body, { app: appTitle }),
      url: baseUrl || null,
      imageUrl: null,
      fields: [{ name: EN.fields.agent, value: agent.label }],
      actor: null,
      subject: { kind: 'test', id: 'test', title: 'Test', artist: null, type: null, status: null },
      appTitle,
      timestamp: new Date().toISOString(),
      data: { test: true },
    };
  }

  // ---- delivery -----------------------------------------------------------------------------

  agentContext(signal?: AbortSignal): AgentContext {
    return {
      fetch: this.#fetch,
      timeoutMs: this.#timeoutMs,
      userAgent: this.#userAgent,
      ...(signal ? { signal } : {}),
    };
  }

  /** The `notify.send` handler. Throws to retry; throws PermanentJobError to give up. */
  async deliver(payload: NotifySendPayload, signal?: AbortSignal): Promise<void> {
    let agent: ErasedAgent;
    let config: Json;
    if (payload.targetId) {
      const row = this.#row(payload.targetId);
      if (!row) {
        this.#log.warn({ targetId: payload.targetId }, 'notification target no longer exists');
        return;
      }
      // A target disabled after the job was queued is skipped (tests ignore the switch).
      if (!row.enabled && payload.event !== 'test') return;
      agent = getAgent(row.agent);
      config = this.#decrypt(row);
    } else if (payload.recipient?.ntfyTopic) {
      agent = getAgent('ntfy');
      config = { serverUrl: DEFAULT_NTFY_SERVER };
    } else {
      throw new PermanentJobError('notification has no target or recipient');
    }
    if (payload.recipient?.email) config = { ...config, to: payload.recipient.email };
    if (payload.recipient?.ntfyTopic) config = { ...config, topic: payload.recipient.ntfyTopic };
    await agent.send(payload.message, config, this.agentContext(signal));
  }

  /** Send a test message with an (unsaved) candidate config. Never throws on delivery errors. */
  async testCandidate(
    agentId: AgentId,
    rawConfig: Json,
    targetId?: string,
  ): Promise<NotificationTestResult> {
    const agent = getAgent(agentId);
    const stored = targetId ? this.#row(targetId) : undefined;
    if (targetId && stored?.agent !== agentId) throw notFound('Notification target not found');
    const config = this.#resolveSecrets(agent, rawConfig, stored ? this.#decrypt(stored) : {});
    this.#validate(agent, config);
    try {
      await agent.test(this.testMessage(agent), config, this.agentContext());
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async testTarget(id: string): Promise<NotificationTestResult> {
    const row = this.#row(id);
    if (!row) throw notFound('Notification target not found');
    const agent = getAgent(row.agent);
    try {
      await agent.test(this.testMessage(agent), this.#decrypt(row), this.agentContext());
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---- targets ------------------------------------------------------------------------------

  #row(id: string): NotificationTarget | undefined {
    return this.#db.select().from(notificationTargets).where(eq(notificationTargets.id, id)).get();
  }

  /** Stored config with secrets decrypted; an undecryptable secret is blanked with a warning. */
  #decrypt(row: NotificationTarget): Json {
    const agent = getAgent(row.agent);
    const config: Json = { ...row.configJson };
    for (const name of agent.secrets) {
      const value = config[name];
      if (!isEncryptedString(value)) continue;
      try {
        config[name] = this.#box.decrypt(value);
      } catch (err) {
        if (!(err instanceof SecretError)) throw err;
        this.#log.warn(
          { targetId: row.id, field: name },
          'could not decrypt a notification secret',
        );
        config[name] = '';
      }
    }
    return config;
  }

  /** A masked secret from the UI means "keep the stored one". */
  #resolveSecrets(agent: ErasedAgent, incoming: Json, stored: Json): Json {
    const config: Json = { ...incoming };
    for (const name of agent.secrets) {
      if (config[name] === REDACTED_SECRET) {
        const previous = stored[name];
        config[name] = typeof previous === 'string' ? previous : '';
      }
    }
    return config;
  }

  #validate(agent: ErasedAgent, config: Json): Json {
    const result = agent.configSchema.safeParse(config);
    if (!result.success) {
      throw new HttpError(
        400,
        'validation_error',
        `Invalid ${agent.label} configuration`,
        result.error.issues,
      );
    }
    return result.data as Json;
  }

  #encrypt(agent: ErasedAgent, config: Json): Json {
    const out: Json = { ...config };
    for (const name of agent.secrets) {
      const value = out[name];
      if (typeof value === 'string' && value !== '') out[name] = this.#box.encrypt(value);
    }
    return out;
  }

  #mask(agent: ErasedAgent, config: Json): Json {
    const out: Json = { ...config };
    for (const name of agent.secrets) {
      const value = out[name];
      out[name] = typeof value === 'string' && value !== '' ? REDACTED_SECRET : '';
    }
    return out;
  }

  #toDto(row: NotificationTarget): NotificationTargetDto {
    const agent = getAgent(row.agent);
    return {
      id: row.id,
      name: row.name,
      agent: row.agent,
      config: this.#mask(agent, this.#decrypt(row)),
      events: notificationEventsFromMask(row.events).filter(
        (e): e is Exclude<NotificationEvent, 'test'> => e !== 'test',
      ),
      enabled: row.enabled,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  listTargets(): NotificationTargetDto[] {
    return this.#db
      .select()
      .from(notificationTargets)
      .orderBy(notificationTargets.createdAt, notificationTargets.name)
      .all()
      .map((row) => this.#toDto(row));
  }

  getTarget(id: string): NotificationTargetDto {
    const row = this.#row(id);
    if (!row) throw notFound('Notification target not found');
    return this.#toDto(row);
  }

  createTarget(input: NotificationTargetInput): NotificationTargetDto {
    const agent = getAgent(input.agent);
    const config = this.#validate(agent, this.#resolveSecrets(agent, input.config, {}));
    const row = this.#db
      .insert(notificationTargets)
      .values({
        name: input.name.trim(),
        agent: input.agent,
        configJson: this.#encrypt(agent, config),
        events: notificationEventsToMask(input.events),
        enabled: input.enabled ?? true,
      })
      .returning()
      .get();
    return this.#toDto(row);
  }

  updateTarget(id: string, input: NotificationTargetInput): NotificationTargetDto {
    const existing = this.#row(id);
    if (!existing) throw notFound('Notification target not found');
    if (existing.agent !== input.agent) {
      throw new HttpError(
        400,
        'agent_immutable',
        'A target cannot change its agent; create a new one',
      );
    }
    const agent = getAgent(existing.agent);
    const config = this.#validate(
      agent,
      this.#resolveSecrets(agent, input.config, this.#decrypt(existing)),
    );
    const row = this.#db
      .update(notificationTargets)
      .set({
        name: input.name.trim(),
        configJson: this.#encrypt(agent, config),
        events: notificationEventsToMask(input.events),
        enabled: input.enabled ?? true,
      })
      .where(eq(notificationTargets.id, id))
      .returning()
      .get();
    return this.#toDto(row);
  }

  deleteTarget(id: string): void {
    const result = this.#db.delete(notificationTargets).where(eq(notificationTargets.id, id)).run();
    if (result.changes === 0) throw notFound('Notification target not found');
  }

  // ---- per-user ----------------------------------------------------------------------------

  userNotifications(userId: string): UserNotificationsResponse {
    const user = this.#db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw notFound('User not found');
    const parsed = userNotifyPrefsSchema.safeParse(user.notifyPrefs ?? {});
    const prefs: UserNotifyPrefs = parsed.success ? parsed.data : {};
    const smtp = this.#designated('smtp', 'userEmail');
    const ntfy = this.#designated('ntfy', 'userTopics');
    const server =
      typeof ntfy?.configJson.serverUrl === 'string'
        ? ntfy.configJson.serverUrl
        : DEFAULT_NTFY_SERVER;
    let reason: string | null = null;
    if (!smtp)
      reason = 'The administrator has not set up an email server for personal notifications.';
    else if (!user.email) reason = 'Your account has no email address.';
    return {
      prefs,
      email: { available: reason === null, address: user.email, reason },
      ntfy: { available: true, server },
      events: this.eventInfo().filter((e) => e.subscribable),
    };
  }

  setUserPrefs(userId: string, prefs: UserNotifyPrefs): UserNotificationsResponse {
    const result = this.#db
      .update(users)
      .set({ notifyPrefs: prefs })
      .where(eq(users.id, userId))
      .run();
    if (result.changes === 0) throw notFound('User not found');
    return this.userNotifications(userId);
  }
}

export { SUBSCRIBABLE_NOTIFICATION_EVENTS };
