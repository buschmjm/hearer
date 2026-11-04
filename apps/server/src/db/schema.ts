import { randomUUID } from 'node:crypto';
import {
  AUTH_TYPES,
  DEFAULT_USER_PERMISSIONS,
  JOB_STATUSES,
  LIBRARY_ITEM_KINDS,
  NOTIFICATION_AGENTS,
  REQUEST_STATUSES,
  REQUEST_TYPES,
  UPLOAD_STATUSES,
  type NotificationEvent,
} from '@hearer/shared';
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

/** Epoch milliseconds, defaulting to "now" in SQL so raw inserts work too. */
const nowMs = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

const createdAt = () => integer('created_at', { mode: 'timestamp_ms' }).notNull().default(nowMs);
const updatedAt = () =>
  integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(nowMs)
    .$onUpdate(() => new Date());
const uuid = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID());

/** Per-user opt-in to notifications (null column = use the app defaults). */
export interface UserNotifyPrefs {
  events: NotificationEvent[];
  email?: string;
}

/** Validated media facts recorded by the `upload.probe` job. */
export interface UploadProbe {
  /** ffprobe `format_name`, e.g. `flac` or `mov,mp4,m4a,3gp,3g2,mj2`. */
  container: string;
  codec: string;
  channels: number | null;
  bitsPerSample: number | null;
}

export const users = sqliteTable(
  'users',
  {
    id: uuid(),
    username: text('username').notNull(),
    email: text('email'),
    displayName: text('display_name'),
    avatar: text('avatar'),
    authType: text('auth_type', { enum: AUTH_TYPES }).notNull(),
    /** Jellyfin user id or OIDC subject; null for local accounts. */
    externalId: text('external_id'),
    /** argon2id hash, local accounts only. */
    passwordHash: text('password_hash'),
    permissions: integer('permissions').notNull().default(DEFAULT_USER_PERMISSIONS),
    /** Per-user quota overrides; null means "use the general default". */
    requestQuotaLimit: integer('request_quota_limit'),
    requestQuotaDays: integer('request_quota_days'),
    uploadQuotaMb: integer('upload_quota_mb'),
    uploadQuotaDays: integer('upload_quota_days'),
    notifyPrefs: text('notify_prefs', { mode: 'json' }).$type<UserNotifyPrefs>(),
    lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Usernames are unique regardless of case.
    uniqueIndex('users_username_unique').on(sql`lower(${t.username})`),
    // SQLite treats NULLs as distinct, so local accounts (no external id) never collide.
    uniqueIndex('users_auth_external_unique').on(t.authType, t.externalId),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    /** 32 random bytes, encoded by the auth layer. */
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    index('sessions_expires_at_idx').on(t.expiresAt),
    index('sessions_user_idx').on(t.userId),
  ],
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: uuid(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Hash of the key; the key itself is shown once at creation. */
    hash: text('hash').notNull(),
    /** First characters of the key, so users can tell keys apart. */
    prefix: text('prefix').notNull(),
    createdAt: createdAt(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  },
  (t) => [uniqueIndex('api_keys_hash_unique').on(t.hash), index('api_keys_user_idx').on(t.userId)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  /** JSON validated by the zod schema for the key; secret fields are encrypted. */
  valueJson: text('value_json').notNull(),
  updatedAt: updatedAt(),
});

export const mbCache = sqliteTable(
  'mb_cache',
  {
    urlKey: text('url_key').primaryKey(),
    bodyJson: text('body_json').notNull(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull().default(nowMs),
    ttlSeconds: integer('ttl_seconds').notNull(),
  },
  (t) => [index('mb_cache_fetched_at_idx').on(t.fetchedAt)],
);

export const requests = sqliteTable(
  'requests',
  {
    id: uuid(),
    type: text('type', { enum: REQUEST_TYPES }).notNull(),
    mbid: text('mbid').notNull(),
    /** For track requests: the parent release group, so album-level providers can act. */
    parentMbid: text('parent_mbid'),
    title: text('title').notNull(),
    artistName: text('artist_name'),
    coverUrl: text('cover_url'),
    status: text('status', { enum: REQUEST_STATUSES }).notNull().default('PENDING'),
    requestedBy: text('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
    declineReason: text('decline_reason'),
    providerId: text('provider_id'),
    providerRef: text('provider_ref'),
    fulfilledByUploadId: text('fulfilled_by_upload_id').references(
      (): AnySQLiteColumn => uploads.id,
      { onDelete: 'set null' },
    ),
    /** When the request was made (same instant as the row was created). */
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('requests_mbid_type_idx').on(t.mbid, t.type),
    index('requests_requested_by_idx').on(t.requestedBy),
    index('requests_status_idx').on(t.status),
  ],
);

export const requestEvents = sqliteTable(
  'request_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    requestId: text('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    at: integer('at', { mode: 'timestamp_ms' }).notNull().default(nowMs),
    /** User who caused the change; null for the system (jobs, availability sync). */
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    fromStatus: text('from_status', { enum: REQUEST_STATUSES }),
    toStatus: text('to_status', { enum: REQUEST_STATUSES }).notNull(),
    note: text('note'),
  },
  (t) => [index('request_events_request_idx').on(t.requestId, t.at)],
);

export const uploads = sqliteTable(
  'uploads',
  {
    id: uuid(),
    /** Files uploaded together (an album) share a batch id. */
    batchId: text('batch_id'),
    /** tus upload id while the file is being received. */
    tusId: text('tus_id'),
    uploaderId: text('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    originalName: text('original_name').notNull(),
    stagingPath: text('staging_path'),
    size: integer('size').notNull().default(0),
    sha256: text('sha256'),
    format: text('format'),
    durationMs: integer('duration_ms'),
    bitrate: integer('bitrate'),
    sampleRate: integer('sample_rate'),
    /** Everything ffprobe reported that the pipeline keeps: codec, channels, container, tags. */
    probeJson: text('probe_json', { mode: 'json' }).$type<UploadProbe>(),
    fingerprint: text('fingerprint'),
    status: text('status', { enum: UPLOAD_STATUSES }).notNull().default('RECEIVING'),
    /** Candidate matches from AcoustID / MusicBrainz. */
    matchJson: text('match_json', { mode: 'json' }).$type<unknown>(),
    /** The final tags chosen at review. */
    chosenJson: text('chosen_json', { mode: 'json' }).$type<unknown>(),
    libraryPath: text('library_path'),
    targetRequestId: text('target_request_id').references((): AnySQLiteColumn => requests.id, {
      onDelete: 'set null',
    }),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('uploads_sha256_idx').on(t.sha256),
    index('uploads_status_idx').on(t.status),
    index('uploads_uploader_idx').on(t.uploaderId),
    index('uploads_batch_idx').on(t.batchId),
    uniqueIndex('uploads_tus_id_unique').on(t.tusId),
  ],
);

export const libraryItems = sqliteTable(
  'library_items',
  {
    serverItemId: text('server_item_id').primaryKey(),
    kind: text('kind', { enum: LIBRARY_ITEM_KINDS }).notNull(),
    name: text('name').notNull(),
    artistName: text('artist_name'),
    albumName: text('album_name'),
    durationMs: integer('duration_ms'),
    mbRecordingId: text('mb_recording_id'),
    mbReleaseGroupId: text('mb_release_group_id'),
    mbArtistId: text('mb_artist_id'),
    /** Normalized "artist|title" key for fuzzy duplicate and availability matching. */
    normKey: text('norm_key'),
    path: text('path'),
    syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull().default(nowMs),
  },
  (t) => [
    index('library_items_mb_recording_idx').on(t.mbRecordingId),
    index('library_items_mb_release_group_idx').on(t.mbReleaseGroupId),
    index('library_items_mb_artist_idx').on(t.mbArtistId),
    index('library_items_norm_key_idx').on(t.normKey),
    index('library_items_kind_idx').on(t.kind),
  ],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    payloadJson: text('payload_json', { mode: 'json' }).$type<unknown>(),
    status: text('status', { enum: JOB_STATUSES }).notNull().default('queued'),
    /** Higher runs first among jobs that are due. */
    priority: integer('priority').notNull().default(0),
    /** While queued or running, at most one job per unique key (de-dupes recurring jobs). */
    uniqueKey: text('unique_key'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    runAfter: integer('run_after', { mode: 'timestamp_ms' }).notNull().default(nowMs),
    lockedBy: text('locked_by'),
    lockedAt: integer('locked_at', { mode: 'timestamp_ms' }),
    lastError: text('last_error'),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('jobs_status_run_after_idx').on(t.status, t.runAfter),
    index('jobs_type_status_idx').on(t.type, t.status),
    uniqueIndex('jobs_unique_key_active_unique')
      .on(t.uniqueKey)
      .where(sql`${t.uniqueKey} is not null and ${t.status} in ('queued', 'running')`),
  ],
);

export const notificationTargets = sqliteTable('notification_targets', {
  id: uuid(),
  name: text('name').notNull(),
  agent: text('agent', { enum: NOTIFICATION_AGENTS }).notNull(),
  /** Agent config as JSON; secret fields are encrypted by the service. */
  configJson: text('config_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  /** Bitmask over NOTIFICATION_EVENTS (see notificationEventBit). */
  events: integer('events').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type SettingRow = typeof settings.$inferSelect;
export type NewSettingRow = typeof settings.$inferInsert;
export type MbCacheRow = typeof mbCache.$inferSelect;
export type NewMbCacheRow = typeof mbCache.$inferInsert;
export type RequestRow = typeof requests.$inferSelect;
export type NewRequestRow = typeof requests.$inferInsert;
export type RequestEvent = typeof requestEvents.$inferSelect;
export type NewRequestEvent = typeof requestEvents.$inferInsert;
export type UploadRow = typeof uploads.$inferSelect;
export type NewUploadRow = typeof uploads.$inferInsert;
export type LibraryItem = typeof libraryItems.$inferSelect;
export type NewLibraryItem = typeof libraryItems.$inferInsert;
export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type NotificationTarget = typeof notificationTargets.$inferSelect;
export type NewNotificationTarget = typeof notificationTargets.$inferInsert;
