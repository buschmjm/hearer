/**
 * Cookie sessions.
 *
 * The cookie carries a random 32-byte id (base64url). The database only ever stores its
 * SHA-256, so a leaked database (or backup) cannot be replayed as live sessions.
 *
 * Expiry is sliding: a session lasts `ttlMs` (default 30 days) from its last refresh, and a
 * refresh happens at most once per `refreshIntervalMs` (default 1 day) so a busy client does
 * not write on every request.
 *
 * CSRF (synchronizer token): each session has a token derived from its raw id,
 * `base64url(HMAC-SHA256(key = raw id, "hearer-csrf-v1"))`. It is not stored. The SPA reads it
 * from `GET /api/v1/auth/me` (or the login response) and sends it in the `x-csrf-token` header
 * on POST/PUT/PATCH/DELETE. The cookie is httpOnly, so a cross-site page cannot learn the id or
 * the token. API-key requests are exempt because browsers never attach those automatically.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, lt, ne } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { sessions, users } from '../db/schema.ts';
import { toAuthUser, type AuthUser } from '../services/users.ts';

export const SESSION_COOKIE = 'hearer_session';
export const CSRF_HEADER = 'x-csrf-token';
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_USER_AGENT_LENGTH = 255;

export interface SessionOptions {
  ttlMs?: number;
  refreshIntervalMs?: number;
  /** Clock override (tests). */
  now?: () => number;
}

export interface SessionMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface CreatedSession {
  /** The raw id for the cookie. Never stored. */
  id: string;
  expiresAt: Date;
  csrfToken: string;
}

export interface ValidSession {
  user: AuthUser;
  csrfToken: string;
  expiresAt: Date;
  /** True when the expiry was just pushed out, so the cookie should be re-issued. */
  refreshed: boolean;
}

/** SHA-256 hex of the raw session id: the value stored as `sessions.id`. */
export const hashSessionId = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex');

export const csrfTokenFor = (rawSessionId: string): string =>
  createHmac('sha256', rawSessionId).update('hearer-csrf-v1').digest('base64url');

/** Constant-time comparison of a presented CSRF token with the session's. */
export function csrfTokenMatches(rawSessionId: string, presented: unknown): boolean {
  if (typeof presented !== 'string') return false;
  const expected = Buffer.from(csrfTokenFor(rawSessionId));
  const given = Buffer.from(presented);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export class SessionService {
  readonly #db: Db;
  readonly #ttlMs: number;
  readonly #refreshMs: number;
  readonly #now: () => number;

  constructor(db: Db, options: SessionOptions = {}) {
    this.#db = db;
    this.#ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#refreshMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  create(userId: string, meta: SessionMeta = {}): CreatedSession {
    const id = randomBytes(32).toString('base64url');
    const now = this.#now();
    const expiresAt = new Date(now + this.#ttlMs);
    this.#db
      .insert(sessions)
      .values({
        id: hashSessionId(id),
        userId,
        createdAt: new Date(now),
        lastSeenAt: new Date(now),
        expiresAt,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
      })
      .run();
    return { id, expiresAt, csrfToken: csrfTokenFor(id) };
  }

  /** Resolve a raw cookie value to its user, extending the session when due. */
  validate(rawId: string): ValidSession | undefined {
    // Real ids are 43 chars of base64url; reject junk before hashing.
    if (rawId.length < 20 || rawId.length > 128) return undefined;
    const hashed = hashSessionId(rawId);
    const row = this.#db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, hashed))
      .get();
    if (!row) return undefined;
    const now = this.#now();
    if (row.session.expiresAt.getTime() <= now) {
      this.#db.delete(sessions).where(eq(sessions.id, hashed)).run();
      return undefined;
    }
    let expiresAt = row.session.expiresAt;
    let refreshed = false;
    const lastSeen = row.session.lastSeenAt?.getTime() ?? 0;
    if (now - lastSeen >= this.#refreshMs) {
      expiresAt = new Date(now + this.#ttlMs);
      this.#db
        .update(sessions)
        .set({ expiresAt, lastSeenAt: new Date(now) })
        .where(eq(sessions.id, hashed))
        .run();
      refreshed = true;
    }
    return { user: toAuthUser(row.user), csrfToken: csrfTokenFor(rawId), expiresAt, refreshed };
  }

  destroy(rawId: string): void {
    this.#db
      .delete(sessions)
      .where(eq(sessions.id, hashSessionId(rawId)))
      .run();
  }

  /** Revoke every session of a user, optionally keeping one (the caller's own). */
  destroyAllForUser(userId: string, keepRawId?: string): number {
    const where = keepRawId
      ? and(eq(sessions.userId, userId), ne(sessions.id, hashSessionId(keepRawId)))
      : eq(sessions.userId, userId);
    return this.#db.delete(sessions).where(where).run().changes;
  }

  purgeExpired(): number {
    return this.#db
      .delete(sessions)
      .where(lt(sessions.expiresAt, new Date(this.#now())))
      .run().changes;
  }
}
