/**
 * Requests: creation (permissions, duplicates, availability, quota, auto-approve), the status
 * state machine with its timeline, listing and counts.
 *
 * Status transitions
 * ------------------
 * Every status change goes through `RequestsService.transition()`, which checks this table,
 * writes the `request_events` row, updates the request and (after the commit) emits the bus
 * event. Anything not listed throws 409 `invalid_transition`.
 *
 *   PENDING              -> APPROVED, DECLINED, CANCELLED
 *   APPROVED             -> PROCESSING, AWAITING_UPLOAD, FAILED, CANCELLED, AVAILABLE,
 *                           PARTIALLY_AVAILABLE
 *   PROCESSING           -> AWAITING_UPLOAD, AVAILABLE, PARTIALLY_AVAILABLE, FAILED, CANCELLED
 *   AWAITING_UPLOAD      -> PROCESSING, AVAILABLE, PARTIALLY_AVAILABLE, FAILED, CANCELLED
 *   PARTIALLY_AVAILABLE  -> AVAILABLE, PROCESSING, AWAITING_UPLOAD, FAILED, CANCELLED
 *   FAILED               -> APPROVED (retry), CANCELLED
 *   AVAILABLE, DECLINED, CANCELLED are final.
 *
 * Events are emitted after the transaction commits, so a listener never sees uncommitted state.
 * `request.approved` fires only for PENDING -> APPROVED (a retry is not a new approval); moving
 * to PROCESSING or AWAITING_UPLOAD emits nothing. Entering APPROVED queues `requests.submit`.
 *
 * Quota: requests per rolling window (`days`), counting every request the user made except
 * DECLINED and CANCELLED ones. ADMIN and MANAGE_REQUESTS are exempt. A per-user override
 * (`request_quota_limit` / `request_quota_days`) replaces the matching `general.defaultRequestQuota`
 * field; limit 0 means unlimited.
 */
import {
  DECLINE_REASON_MAX,
  Permission,
  REQUEST_STATUSES,
  hasPermission,
  type CreateRequestBody,
  type RequestCounts,
  type RequestDetailDto,
  type RequestDto,
  type RequestListQuery,
  type RequestQuota,
  type RequestStatus,
  type RequestType,
  type RequestUser,
  type RequestListResponse,
} from '@hearer/shared';
import { and, asc, count, desc, eq, gt, inArray, lt, notInArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { FastifyBaseLogger } from 'fastify';
import { type FulfillmentRegistry } from '../adapters/fulfillment/registry.ts';
import { MetadataError, type MetadataProvider } from '../adapters/metadata/types.ts';
import type { Db } from '../db/client.ts';
import {
  requestEvents,
  requests,
  users,
  type RequestEvent,
  type RequestRow,
  type User,
} from '../db/schema.ts';
import { HttpError, forbidden, notFound } from '../lib/http-error.ts';
import type { EventBus, HearerEventName, RequestEventPayload } from '../lib/events.ts';
import type { AvailabilityMatcher } from './availability.ts';
import type { SettingsService } from './settings.ts';
import type { AuthUser } from './users.ts';
import type { JobRunner } from '../jobs/runner.ts';

export const SUBMIT_JOB = 'requests.submit';
const DAY_MS = 86_400_000;

export const TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  PENDING: ['APPROVED', 'DECLINED', 'CANCELLED'],
  APPROVED: [
    'PROCESSING',
    'AWAITING_UPLOAD',
    'FAILED',
    'CANCELLED',
    'AVAILABLE',
    'PARTIALLY_AVAILABLE',
  ],
  PROCESSING: ['AWAITING_UPLOAD', 'AVAILABLE', 'PARTIALLY_AVAILABLE', 'FAILED', 'CANCELLED'],
  AWAITING_UPLOAD: ['PROCESSING', 'AVAILABLE', 'PARTIALLY_AVAILABLE', 'FAILED', 'CANCELLED'],
  PARTIALLY_AVAILABLE: ['AVAILABLE', 'PROCESSING', 'AWAITING_UPLOAD', 'FAILED', 'CANCELLED'],
  FAILED: ['APPROVED', 'CANCELLED'],
  AVAILABLE: [],
  DECLINED: [],
  CANCELLED: [],
};

/** Statuses in which a request still occupies its type+mbid slot (blocks a duplicate). */
export const ACTIVE_STATUSES: readonly RequestStatus[] = [
  'PENDING',
  'APPROVED',
  'PROCESSING',
  'AWAITING_UPLOAD',
  'PARTIALLY_AVAILABLE',
];
/** Statuses the availability job watches. */
export const WATCHED_STATUSES: readonly RequestStatus[] = [
  'APPROVED',
  'PROCESSING',
  'AWAITING_UPLOAD',
  'PARTIALLY_AVAILABLE',
];
const QUOTA_EXCLUDED: readonly RequestStatus[] = ['DECLINED', 'CANCELLED'];

const EVENT_FOR_STATUS: Partial<Record<RequestStatus, HearerEventName>> = {
  APPROVED: 'request.approved',
  DECLINED: 'request.declined',
  AVAILABLE: 'request.available',
  PARTIALLY_AVAILABLE: 'request.partially_available',
  FAILED: 'request.failed',
  CANCELLED: 'request.cancelled',
};

const REQUEST_PERMISSION: Record<RequestType, number> = {
  track: Permission.REQUEST,
  album: Permission.REQUEST_ALBUM,
  artist: Permission.REQUEST_ARTIST,
};

export const canManageRequests = (user: Pick<AuthUser, 'permissions'>): boolean =>
  hasPermission(user.permissions, Permission.MANAGE_REQUESTS);
export const canViewAllRequests = (user: Pick<AuthUser, 'permissions'>): boolean =>
  hasPermission(user.permissions, [Permission.VIEW_ALL_REQUESTS, Permission.MANAGE_REQUESTS], {
    type: 'or',
  });

export interface TransitionOptions {
  /** The user behind the change; omit/null for the system. */
  actorId?: string | null | undefined;
  note?: string | null | undefined;
  /** Extra columns to set in the same update. */
  patch?: Partial<
    Pick<
      RequestRow,
      | 'decidedBy'
      | 'decidedAt'
      | 'declineReason'
      | 'providerId'
      | 'providerRef'
      | 'fulfilledByUploadId'
    >
  >;
}

export interface RequestsServiceDeps {
  db: Db;
  settings: SettingsService;
  metadata: MetadataProvider;
  availability: Pick<AvailabilityMatcher, 'evaluateRequest' | 'newRun'>;
  events: EventBus;
  jobs: Pick<JobRunner, 'enqueue'>;
  fulfillment: FulfillmentRegistry;
  logger: Pick<FastifyBaseLogger, 'warn' | 'error'>;
}

interface Committed {
  row: RequestRow;
  from: RequestStatus | null;
  to: RequestStatus;
  actorId: string | null;
  note: string | null;
}

const invalidTransition = (from: RequestStatus, to: RequestStatus): HttpError =>
  new HttpError(409, 'invalid_transition', `A ${from} request cannot become ${to}`, { from, to });

const toRef = (
  u: Pick<User, 'id' | 'username' | 'displayName' | 'avatar'> | null,
): RequestUser | null =>
  u ? { id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar } : null;

export class RequestsService {
  readonly #db: Db;
  readonly #settings: SettingsService;
  readonly #metadata: MetadataProvider;
  readonly #availability: RequestsServiceDeps['availability'];
  readonly #events: EventBus;
  readonly #jobs: RequestsServiceDeps['jobs'];
  readonly #log: RequestsServiceDeps['logger'];
  readonly fulfillment: FulfillmentRegistry;
  readonly #requester = alias(users, 'requester');
  readonly #decider = alias(users, 'decider');

  constructor(deps: RequestsServiceDeps) {
    this.#db = deps.db;
    this.#settings = deps.settings;
    this.#metadata = deps.metadata;
    this.#availability = deps.availability;
    this.#events = deps.events;
    this.#jobs = deps.jobs;
    this.#log = deps.logger;
    this.fulfillment = deps.fulfillment;
  }

  // --- reading ----------------------------------------------------------------------------

  /** The raw row, or undefined. */
  find(id: string): RequestRow | undefined {
    return this.#db.select().from(requests).where(eq(requests.id, id)).get();
  }

  /** The raw row; throws 404. */
  require(id: string): RequestRow {
    const row = this.find(id);
    if (!row) throw notFound('Request not found');
    return row;
  }

  #selectJoined() {
    return this.#db
      .select({ request: requests, requester: this.#requester, decider: this.#decider })
      .from(requests)
      .leftJoin(this.#requester, eq(requests.requestedBy, this.#requester.id))
      .leftJoin(this.#decider, eq(requests.decidedBy, this.#decider.id));
  }

  #toDto(row: RequestRow, requester: User | null, decider: User | null): RequestDto {
    return {
      id: row.id,
      type: row.type,
      mbid: row.mbid,
      parentMbid: row.parentMbid,
      title: row.title,
      artistName: row.artistName,
      coverUrl: row.coverUrl,
      status: row.status,
      requestedBy: toRef(requester),
      decidedBy: toRef(decider),
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      declineReason: row.declineReason,
      providerId: row.providerId,
      fulfilledByUploadId: row.fulfilledByUploadId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** A request with requester info. Throws 404. No visibility check (see `getVisible`). */
  getDto(id: string): RequestDto {
    const hit = this.#selectJoined().where(eq(requests.id, id)).get();
    if (!hit) throw notFound('Request not found');
    return this.#toDto(hit.request, hit.requester, hit.decider);
  }

  /** The request with its timeline, if the viewer may see it; otherwise 404 (no existence leak). */
  getVisible(id: string, viewer: AuthUser): RequestDetailDto {
    const dto = this.getDto(id);
    if (dto.requestedBy?.id !== viewer.id && !canViewAllRequests(viewer)) {
      throw notFound('Request not found');
    }
    return { ...dto, events: this.timeline(id) };
  }

  timeline(requestId: string): RequestDetailDto['events'] {
    const actor = alias(users, 'actor');
    return this.#db
      .select({ event: requestEvents, actor })
      .from(requestEvents)
      .leftJoin(actor, eq(requestEvents.actorId, actor.id))
      .where(eq(requestEvents.requestId, requestId))
      .orderBy(asc(requestEvents.at), asc(requestEvents.id))
      .all()
      .map(({ event, actor: a }: { event: RequestEvent; actor: User | null }) => ({
        id: event.id,
        at: event.at.toISOString(),
        actor: toRef(a),
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        note: event.note,
      }));
  }

  /** Own requests, or everyone's with `all` (needs VIEW_ALL_REQUESTS or MANAGE_REQUESTS). */
  list(query: RequestListQuery, viewer: AuthUser): RequestListResponse {
    const where = this.#scope(query, viewer, true);
    const total = this.#db.select({ n: count() }).from(requests).where(where).get()?.n ?? 0;
    const column = query.sort === 'updatedAt' ? requests.updatedAt : requests.createdAt;
    const items = this.#selectJoined()
      .where(where)
      .orderBy(query.order === 'asc' ? asc(column) : desc(column), desc(requests.id))
      .limit(query.limit)
      .offset(query.offset)
      .all()
      .map((hit) => this.#toDto(hit.request, hit.requester, hit.decider));
    return { items, total, offset: query.offset, limit: query.limit };
  }

  #scope(
    query: Pick<RequestListQuery, 'all'> & Partial<RequestListQuery>,
    viewer: AuthUser,
    filters: boolean,
  ): SQL | undefined {
    const conditions: SQL[] = [];
    if (query.all) {
      if (!canViewAllRequests(viewer)) throw forbidden('You can only list your own requests');
      if (filters && query.requestedBy)
        conditions.push(eq(requests.requestedBy, query.requestedBy));
    } else {
      if (filters && query.requestedBy && query.requestedBy !== viewer.id) {
        throw forbidden('You can only list your own requests');
      }
      conditions.push(eq(requests.requestedBy, viewer.id));
    }
    if (filters) {
      if (query.status) conditions.push(inArray(requests.status, query.status));
      if (query.type) conditions.push(eq(requests.type, query.type));
    }
    return conditions.length > 0 ? and(...conditions) : undefined;
  }

  counts(query: { all: boolean }, viewer: AuthUser): RequestCounts {
    const where = this.#scope(query, viewer, false);
    const rows = this.#db
      .select({ status: requests.status, n: count() })
      .from(requests)
      .where(where)
      .groupBy(requests.status)
      .all();
    const byStatus = Object.fromEntries(REQUEST_STATUSES.map((s) => [s, 0])) as Record<
      RequestStatus,
      number
    >;
    for (const row of rows) byStatus[row.status] = row.n;
    return { total: rows.reduce((sum, r) => sum + r.n, 0), byStatus };
  }

  // --- quota ------------------------------------------------------------------------------

  #quotaFor(user: User): { limit: number; days: number } {
    const defaults = this.#settings.get('general').defaultRequestQuota;
    return {
      limit: user.requestQuotaLimit ?? defaults.limit,
      days: user.requestQuotaDays ?? defaults.days,
    };
  }

  #quotaUsage(
    db: Pick<Db, 'select'>,
    userId: string,
    days: number,
    now: number,
  ): { used: number; resetsAt: Date | null } {
    const where = and(
      eq(requests.requestedBy, userId),
      gt(requests.createdAt, new Date(now - days * DAY_MS)),
      notInArray(requests.status, QUOTA_EXCLUDED as RequestStatus[]),
    );
    const used = db.select({ n: count() }).from(requests).where(where).get()?.n ?? 0;
    if (used === 0) return { used, resetsAt: null };
    // The window frees a slot when its oldest counted request ages out.
    const oldest = db
      .select({ at: sql<number>`min(${requests.createdAt})` })
      .from(requests)
      .where(where)
      .get();
    return { used, resetsAt: oldest?.at ? new Date(oldest.at + days * DAY_MS) : null };
  }

  /** The caller's quota state. Exempt roles report as unlimited. */
  quota(viewer: AuthUser, now = Date.now()): RequestQuota {
    const user = this.#userRow(viewer.id);
    const { limit, days } = this.#quotaFor(user);
    const exempt = canManageRequests(viewer);
    const usage = this.#quotaUsage(this.#db, user.id, days, now);
    const unlimited = exempt || limit === 0;
    return {
      limit: exempt ? 0 : limit,
      days,
      used: usage.used,
      remaining: unlimited ? null : Math.max(0, limit - usage.used),
      unlimited,
      resetsAt: usage.resetsAt ? usage.resetsAt.toISOString() : null,
    };
  }

  #userRow(id: string): User {
    const row = this.#db.select().from(users).where(eq(users.id, id)).get();
    if (!row) throw notFound('User not found');
    return row;
  }

  // --- creating ---------------------------------------------------------------------------

  async create(
    actor: AuthUser,
    body: CreateRequestBody,
    options: { signal?: AbortSignal } = {},
  ): Promise<RequestDto> {
    if (!hasPermission(actor.permissions, REQUEST_PERMISSION[body.type])) {
      throw forbidden(`You are not allowed to request ${body.type}s`);
    }
    // Cheap duplicate check first so a repeat click never costs MusicBrainz calls.
    this.#assertNoActiveDuplicate(body.type, body.mbid);

    const catalog = await this.#resolveCatalog(body, options.signal);
    const evaluation = await this.#evaluate(
      { type: body.type, mbid: body.mbid, title: catalog.title, artistName: catalog.artistName },
      options.signal,
    );
    if (evaluation === 'AVAILABLE') {
      throw new HttpError(409, 'already_available', 'This is already in the library');
    }

    const autoApprove = hasPermission(actor.permissions, Permission.AUTO_APPROVE);
    const committed: Committed[] = this.#db.transaction(
      (tx) => {
        // Re-checked inside the write lock: two simultaneous requests cannot both pass.
        this.#assertNoActiveDuplicate(body.type, body.mbid, tx);
        this.#enforceQuota(actor, tx);
        const row = tx
          .insert(requests)
          .values({
            type: body.type,
            mbid: body.mbid,
            parentMbid: catalog.parentMbid,
            title: catalog.title,
            artistName: catalog.artistName,
            coverUrl: catalog.coverUrl,
            status: 'PENDING',
            requestedBy: actor.id,
          })
          .returning()
          .get();
        tx.insert(requestEvents)
          .values({
            requestId: row.id,
            actorId: actor.id,
            fromStatus: null,
            toStatus: 'PENDING',
            note: 'Requested',
          })
          .run();
        const out: Committed[] = [
          { row, from: null, to: 'PENDING', actorId: actor.id, note: 'Requested' },
        ];
        if (autoApprove) {
          out.push(
            this.#apply(tx, row, 'APPROVED', {
              actorId: actor.id,
              note: 'Auto-approved',
              patch: { decidedBy: actor.id, decidedAt: new Date() },
            }),
          );
        }
        return out;
      },
      { behavior: 'immediate' },
    );
    // `request.created` is emitted for every new request, then the approval if there was one.
    const first = committed[0];
    if (first) this.#events.emit('request.created', this.#payload(first));
    for (const c of committed.slice(1)) this.#afterCommit(c);
    return this.getDto((committed.at(-1) ?? first)?.row.id ?? '');
  }

  #assertNoActiveDuplicate(
    type: RequestType,
    mbid: string,
    db: Pick<Db, 'select'> = this.#db,
  ): void {
    const existing = db
      .select({ id: requests.id, status: requests.status })
      .from(requests)
      .where(
        and(
          eq(requests.type, type),
          eq(requests.mbid, mbid),
          inArray(requests.status, ACTIVE_STATUSES as RequestStatus[]),
        ),
      )
      .get();
    if (existing) {
      throw new HttpError(409, 'already_requested', 'This has already been requested', {
        requestId: existing.id,
        status: existing.status,
      });
    }
  }

  #enforceQuota(actor: AuthUser, tx: Pick<Db, 'select'>): void {
    if (canManageRequests(actor)) return;
    const row = tx.select().from(users).where(eq(users.id, actor.id)).get();
    if (!row) throw notFound('User not found');
    const { limit, days } = this.#quotaFor(row);
    if (limit === 0) return;
    const { used, resetsAt } = this.#quotaUsage(tx, actor.id, days, Date.now());
    if (used < limit) return;
    throw new HttpError(
      429,
      'quota_exceeded',
      `Request limit reached (${String(limit)} per ${String(days)} days)`,
      { limit, used, resetsAt: resetsAt ? resetsAt.toISOString() : null },
    );
  }

  async #resolveCatalog(
    body: CreateRequestBody,
    signal: AbortSignal | undefined,
  ): Promise<{
    title: string;
    artistName: string | null;
    coverUrl: string | null;
    parentMbid: string | null;
  }> {
    try {
      const options = signal ? { signal } : {};
      switch (body.type) {
        case 'artist': {
          const artist = await this.#metadata.getArtist(body.mbid, options);
          return { title: artist.name, artistName: artist.name, coverUrl: null, parentMbid: null };
        }
        case 'album': {
          const group = await this.#metadata.getReleaseGroup(body.mbid, options);
          return {
            title: group.title,
            artistName: group.artistName || null,
            coverUrl: group.coverUrl || null,
            parentMbid: null,
          };
        }
        case 'track': {
          const rec = await this.#metadata.getRecording(body.mbid, options);
          const parent = rec.releaseGroup ?? rec.releaseGroups[0] ?? null;
          return {
            title: rec.title,
            artistName: rec.artistName || null,
            coverUrl: rec.coverUrl ?? parent?.coverUrl ?? null,
            parentMbid: parent?.mbid ?? null,
          };
        }
      }
    } catch (err) {
      throw this.#metadataHttpError(err);
    }
  }

  async #evaluate(
    request: { type: RequestType; mbid: string; title: string; artistName: string | null },
    signal: AbortSignal | undefined,
  ): Promise<'AVAILABLE' | 'OTHER'> {
    try {
      const result = await this.#availability.evaluateRequest(
        request,
        this.#availability.newRun(signal),
      );
      return result.status === 'AVAILABLE' ? 'AVAILABLE' : 'OTHER';
    } catch (err) {
      throw this.#metadataHttpError(err);
    }
  }

  #metadataHttpError(err: unknown): unknown {
    if (err instanceof MetadataError) {
      return err.kind === 'not_found'
        ? notFound('MusicBrainz does not know that id')
        : new HttpError(502, 'metadata_unavailable', 'The metadata service is unavailable');
    }
    return err;
  }

  // --- transitions ------------------------------------------------------------------------

  /**
   * The only way a request changes status. Throws 404 for an unknown request and 409
   * `invalid_transition` when the table forbids the move (or the request changed under us).
   */
  transition(requestId: string, to: RequestStatus, options: TransitionOptions = {}): RequestRow {
    const committed = this.#db.transaction(
      (tx) => {
        const row = tx.select().from(requests).where(eq(requests.id, requestId)).get();
        if (!row) throw notFound('Request not found');
        return this.#apply(tx, row, to, options);
      },
      { behavior: 'immediate' },
    );
    this.#afterCommit(committed);
    return committed.row;
  }

  /** Validate and write one transition inside an open transaction. */
  #apply(
    tx: Pick<Db, 'update' | 'insert'>,
    row: RequestRow,
    to: RequestStatus,
    options: TransitionOptions,
  ): Committed {
    const from = row.status;
    if (!TRANSITIONS[from].includes(to)) throw invalidTransition(from, to);
    const note = options.note ?? null;
    const actorId = options.actorId ?? null;
    const [updated] = tx
      .update(requests)
      .set({ ...options.patch, status: to, updatedAt: new Date() })
      // Guard against a concurrent change between our read and this write.
      .where(and(eq(requests.id, row.id), eq(requests.status, from)))
      .returning()
      .all();
    if (!updated) throw invalidTransition(from, to);
    tx.insert(requestEvents)
      .values({ requestId: row.id, actorId, fromStatus: from, toStatus: to, note })
      .run();
    return { row: updated, from, to, actorId, note };
  }

  /** A timeline entry without a status change (poll progress, upload linked, ...). */
  addNote(requestId: string, note: string, actorId: string | null = null): void {
    this.#db.transaction(
      (tx) => {
        const row = tx.select().from(requests).where(eq(requests.id, requestId)).get();
        if (!row) throw notFound('Request not found');
        tx.insert(requestEvents)
          .values({ requestId, actorId, fromStatus: row.status, toStatus: row.status, note })
          .run();
        tx.update(requests).set({ updatedAt: new Date() }).where(eq(requests.id, requestId)).run();
      },
      { behavior: 'immediate' },
    );
  }

  #payload(c: Committed): RequestEventPayload {
    return {
      requestId: c.row.id,
      type: c.row.type,
      mbid: c.row.mbid,
      title: c.row.title,
      artistName: c.row.artistName,
      requestedBy: c.row.requestedBy,
      from: c.from,
      to: c.to,
      actorId: c.actorId,
      note: c.note,
      declineReason: c.row.declineReason,
    };
  }

  #afterCommit(c: Committed): void {
    if (c.to === 'APPROVED') this.#enqueueSubmit(c.row.id);
    const name = EVENT_FOR_STATUS[c.to];
    if (!name) return;
    if (c.to === 'APPROVED' && c.from !== 'PENDING') return; // retry, not a new approval
    this.#events.emit(name as 'request.approved', this.#payload(c));
  }

  /** Queue the submit job; the availability job re-queues stranded APPROVED requests. */
  #enqueueSubmit(requestId: string): void {
    try {
      this.#jobs.enqueue(SUBMIT_JOB, { requestId }, { uniqueKey: `${SUBMIT_JOB}:${requestId}` });
    } catch (err) {
      this.#log.error({ err, requestId }, 'could not queue requests.submit');
    }
  }

  /** Requests the availability job should look at (optionally only the given ids). */
  watched(ids?: readonly string[]): RequestRow[] {
    const statusCondition = inArray(requests.status, WATCHED_STATUSES as RequestStatus[]);
    return this.#db
      .select()
      .from(requests)
      .where(ids ? and(statusCondition, inArray(requests.id, [...ids])) : statusCondition)
      .orderBy(asc(requests.createdAt))
      .all();
  }

  /** Re-queue submit for APPROVED requests that have sat untouched (crash between commit and enqueue). */
  resubmitStranded(olderThanMs: number, now = Date.now()): number {
    const rows = this.#db
      .select({ id: requests.id })
      .from(requests)
      .where(
        and(eq(requests.status, 'APPROVED'), lt(requests.updatedAt, new Date(now - olderThanMs))),
      )
      .all();
    for (const row of rows) this.#enqueueSubmit(row.id);
    return rows.length;
  }

  // --- moderation -------------------------------------------------------------------------

  approve(requestId: string, actor: AuthUser): RequestDto {
    this.#requireManager(actor);
    this.transition(requestId, 'APPROVED', {
      actorId: actor.id,
      note: 'Approved',
      patch: { decidedBy: actor.id, decidedAt: new Date() },
    });
    return this.getDto(requestId);
  }

  decline(requestId: string, actor: AuthUser, reason: string): RequestDto {
    this.#requireManager(actor);
    const trimmed = reason.trim();
    if (trimmed.length === 0 || trimmed.length > DECLINE_REASON_MAX) {
      throw new HttpError(
        400,
        'validation_error',
        `A reason of 1-${String(DECLINE_REASON_MAX)} characters is required`,
      );
    }
    this.transition(requestId, 'DECLINED', {
      actorId: actor.id,
      note: `Declined: ${trimmed}`,
      patch: { decidedBy: actor.id, decidedAt: new Date(), declineReason: trimmed },
    });
    return this.getDto(requestId);
  }

  /** FAILED -> APPROVED, which queues the submit job again. */
  retry(requestId: string, actor: AuthUser): RequestDto {
    this.#requireManager(actor);
    const row = this.require(requestId);
    // Retry is only for FAILED requests; PENDING -> APPROVED is the approve route's job.
    if (row.status !== 'FAILED') throw invalidTransition(row.status, 'APPROVED');
    // A fresh request for the same item may have been made since; do not run two at once.
    const clash = this.#db
      .select({ id: requests.id })
      .from(requests)
      .where(
        and(
          eq(requests.type, row.type),
          eq(requests.mbid, row.mbid),
          inArray(requests.status, ACTIVE_STATUSES as RequestStatus[]),
        ),
      )
      .get();
    if (clash) {
      throw new HttpError(409, 'already_requested', 'A newer request for this is already active', {
        requestId: clash.id,
      });
    }
    this.transition(requestId, 'APPROVED', {
      actorId: actor.id,
      note: 'Retried',
      patch: { providerId: null, providerRef: null },
    });
    return this.getDto(requestId);
  }

  /**
   * The owner (while the request can still be cancelled) or a request manager. A submitted
   * request is withdrawn from its provider first; if that fails the request is cancelled
   * anyway and the timeline says so.
   */
  async cancel(requestId: string, actor: AuthUser): Promise<RequestDto> {
    const row = this.find(requestId);
    if (!row || (row.requestedBy !== actor.id && !canManageRequests(actor))) {
      throw notFound('Request not found');
    }
    if (!TRANSITIONS[row.status].includes('CANCELLED'))
      throw invalidTransition(row.status, 'CANCELLED');
    let note = row.requestedBy === actor.id ? 'Cancelled by the requester' : 'Cancelled';
    if (row.providerId && row.providerRef) {
      const provider = this.fulfillment.get(row.providerId);
      if (provider?.cancel) {
        try {
          await provider.cancel(row.providerRef);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.#log.warn({ err, requestId }, 'provider cancel failed');
          note += ` (could not withdraw it from ${provider.label}: ${message.slice(0, 200)})`;
        }
      }
    }
    this.transition(requestId, 'CANCELLED', { actorId: actor.id, note });
    return this.getDto(requestId);
  }

  #requireManager(actor: AuthUser): void {
    if (!canManageRequests(actor)) throw forbidden();
  }

  // --- upload link ------------------------------------------------------------------------

  /**
   * Called by the import (H-15) when an upload fulfills a request. Records the upload and moves
   * the request to AVAILABLE (or PARTIALLY_AVAILABLE when `partial`, e.g. one track of an album).
   * Throws 409 `invalid_transition` for requests that are not approved yet or already final.
   */
  fulfillFromUpload(
    requestId: string,
    uploadId: string,
    options: { actorId?: string | null; partial?: boolean; note?: string } = {},
  ): RequestRow {
    const to: RequestStatus = options.partial ? 'PARTIALLY_AVAILABLE' : 'AVAILABLE';
    const note = options.note ?? 'Fulfilled by an upload';
    const row = this.require(requestId);
    if (row.status === to) {
      // Another part of a partial request arrived: keep the link current, add a timeline note.
      this.#db
        .update(requests)
        .set({ fulfilledByUploadId: uploadId, updatedAt: new Date() })
        .where(eq(requests.id, requestId))
        .run();
      this.addNote(requestId, note, options.actorId ?? null);
      return this.require(requestId);
    }
    return this.transition(requestId, to, {
      actorId: options.actorId ?? null,
      note,
      patch: { fulfilledByUploadId: uploadId },
    });
  }
}
