/**
 * API keys: `hrr_` + 32 random bytes (base64url). Only the SHA-256 is stored, plus a short
 * display prefix. Present a key as `X-Api-Key: hrr_...` or `Authorization: Bearer hrr_...`.
 * A key acts with its owner's current permissions and is revoked by deleting it (or the user).
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, count, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { apiKeys, users } from '../db/schema.ts';
import { toAuthUser, type AuthUser } from '../services/users.ts';

export const API_KEY_PREFIX = 'hrr_';
export const MAX_KEYS_PER_USER = 25;
/** `last_used_at` is written at most this often per key. */
export const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;
const DISPLAY_PREFIX_LENGTH = 8;

export type ApiKeyRow = typeof apiKeys.$inferSelect;

export const hashApiKey = (key: string): string => createHash('sha256').update(key).digest('hex');

export class TooManyKeysError extends Error {
  constructor() {
    super(`At most ${MAX_KEYS_PER_USER} API keys per user`);
    this.name = 'TooManyKeysError';
  }
}

/** Pull a Hearer API key out of the request headers, if one was presented. */
export function extractApiKey(headers: {
  'x-api-key'?: string | string[] | undefined;
  authorization?: string | undefined;
}): string | undefined {
  const direct = headers['x-api-key'];
  const value = Array.isArray(direct) ? direct[0] : direct;
  if (value) return value.trim();
  const auth = headers.authorization;
  if (auth) {
    const match = /^Bearer\s+(hrr_\S+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export class ApiKeyService {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** Create a key. The returned `secret` is the only time the full key exists. */
  create(userId: string, name: string): { row: ApiKeyRow; secret: string } {
    return this.#db.transaction(
      (tx) => {
        const existing = tx
          .select({ n: count() })
          .from(apiKeys)
          .where(eq(apiKeys.userId, userId))
          .get();
        if ((existing?.n ?? 0) >= MAX_KEYS_PER_USER) throw new TooManyKeysError();
        const secret = API_KEY_PREFIX + randomBytes(32).toString('base64url');
        const row = tx
          .insert(apiKeys)
          .values({
            userId,
            name,
            hash: hashApiKey(secret),
            prefix: secret.slice(0, DISPLAY_PREFIX_LENGTH),
            createdAt: new Date(this.#now()),
          })
          .returning()
          .get();
        return { row, secret };
      },
      { behavior: 'immediate' },
    );
  }

  list(userId: string): ApiKeyRow[] {
    return this.#db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .orderBy(asc(apiKeys.createdAt), asc(apiKeys.id))
      .all();
  }

  /** Delete one of the user's own keys. */
  delete(userId: string, id: string): boolean {
    return (
      this.#db
        .delete(apiKeys)
        .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
        .run().changes > 0
    );
  }

  /** Resolve a presented key to its owner, recording use (throttled). */
  authenticate(key: string): { user: AuthUser; keyId: string } | undefined {
    if (!key.startsWith(API_KEY_PREFIX) || key.length > 256) return undefined;
    const row = this.#db
      .select({ key: apiKeys, user: users })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(eq(apiKeys.hash, hashApiKey(key)))
      .get();
    if (!row) return undefined;
    const now = this.#now();
    const last = row.key.lastUsedAt?.getTime();
    if (last === undefined || now - last >= LAST_USED_THROTTLE_MS) {
      this.#db
        .update(apiKeys)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(apiKeys.id, row.key.id))
        .run();
    }
    return { user: toAuthUser(row.user), keyId: row.key.id };
  }
}
