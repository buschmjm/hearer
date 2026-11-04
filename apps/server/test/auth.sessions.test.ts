import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDatabase, type Database_ } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { apiKeys, sessions } from '../src/db/schema.ts';
import {
  API_KEY_PREFIX,
  ApiKeyService,
  LAST_USED_THROTTLE_MS,
  MAX_KEYS_PER_USER,
  TooManyKeysError,
  extractApiKey,
  hashApiKey,
} from '../src/auth/apikeys.ts';
import {
  hashPassword,
  needsRehash,
  verifyAgainstDummy,
  verifyPassword,
} from '../src/auth/password.ts';
import {
  DEFAULT_SESSION_TTL_MS,
  SessionService,
  csrfTokenFor,
  csrfTokenMatches,
  hashSessionId,
} from '../src/auth/sessions.ts';
import { SecretBox } from '../src/lib/secrets.ts';
import { SettingsService } from '../src/services/settings.ts';
import { UsersService } from '../src/services/users.ts';

let database: Database_;
let users: UsersService;
let userId: string;
const clock = { t: 1_800_000_000_000 };
const now = () => clock.t;

beforeEach(() => {
  clock.t = 1_800_000_000_000;
  database = openDatabase(':memory:');
  runMigrations(database.db);
  const settings = new SettingsService(database.db, new SecretBox('k'.repeat(32)), {
    warn: () => undefined,
  });
  users = new UsersService(database.db, settings);
  userId = users.createLocal({ username: 'alice', passwordHash: 'x' }).id;
});
afterEach(() => {
  database.close();
});

describe('password hashing', () => {
  it('produces argon2id hashes with the OWASP parameters and verifies them', async () => {
    const hash = await hashPassword('s3cret-pass');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(hash, 's3cret-pass')).toBe(true);
    expect(await verifyPassword(hash, 's3cret-pasS')).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('treats a malformed hash as a mismatch and flags weak ones for rehash', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
    expect(needsRehash('not-a-hash')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNo')).toBe(true);
  });

  it('verifyAgainstDummy resolves without throwing', async () => {
    await expect(verifyAgainstDummy('anything')).resolves.toBeUndefined();
  });
});

describe('SessionService', () => {
  it('stores only the SHA-256 of the id, never the cookie value', () => {
    const svc = new SessionService(database.db, { now });
    const created = svc.create(userId, { ip: '10.0.0.1', userAgent: 'agent/1' });
    expect(created.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = database.db.select().from(sessions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(hashSessionId(created.id));
    expect(rows[0]?.id).not.toBe(created.id);
    expect(rows[0]).toMatchObject({ ip: '10.0.0.1', userAgent: 'agent/1', userId });
    expect(rows[0]?.expiresAt.getTime()).toBe(clock.t + DEFAULT_SESSION_TTL_MS);
  });

  it('issues unique ids', () => {
    const svc = new SessionService(database.db, { now });
    const ids = new Set(Array.from({ length: 50 }, () => svc.create(userId).id));
    expect(ids.size).toBe(50);
  });

  it('validates a live session and rejects unknown, junk or hashed values', () => {
    const svc = new SessionService(database.db, { now });
    const { id } = svc.create(userId);
    expect(svc.validate(id)?.user.id).toBe(userId);
    expect(svc.validate('x'.repeat(43))).toBeUndefined();
    expect(svc.validate('short')).toBeUndefined();
    expect(svc.validate('a'.repeat(500))).toBeUndefined();
    // Presenting the stored hash must not authenticate.
    expect(svc.validate(hashSessionId(id))).toBeUndefined();
  });

  it('expires sessions and deletes the stale row', () => {
    const svc = new SessionService(database.db, { now, ttlMs: 1000 });
    const { id } = svc.create(userId);
    clock.t += 999;
    expect(svc.validate(id)).toBeDefined();
    clock.t += 2000;
    expect(svc.validate(id)).toBeUndefined();
    expect(database.db.select().from(sessions).all()).toHaveLength(0);
  });

  it('slides the expiry at most once per refresh interval', () => {
    const day = 24 * 60 * 60 * 1000;
    const svc = new SessionService(database.db, { now, ttlMs: 30 * day, refreshIntervalMs: day });
    const { id } = svc.create(userId);
    clock.t += day / 2;
    expect(svc.validate(id)?.refreshed).toBe(false);
    clock.t += day / 2;
    const first = svc.validate(id);
    expect(first?.refreshed).toBe(true);
    expect(first?.expiresAt.getTime()).toBe(clock.t + 30 * day);
    clock.t += 1000;
    expect(svc.validate(id)?.refreshed).toBe(false);
    clock.t += 29 * day; // 29 days after the slide: still alive thanks to it
    expect(svc.validate(id)).toBeDefined();
  });

  it('destroy and destroyAllForUser (optionally keeping one)', () => {
    const svc = new SessionService(database.db, { now });
    const a = svc.create(userId);
    const b = svc.create(userId);
    const c = svc.create(userId);
    svc.destroy(a.id);
    expect(svc.validate(a.id)).toBeUndefined();
    expect(svc.destroyAllForUser(userId, b.id)).toBe(1);
    expect(svc.validate(b.id)).toBeDefined();
    expect(svc.validate(c.id)).toBeUndefined();
    expect(svc.destroyAllForUser(userId)).toBe(1);
    expect(svc.validate(b.id)).toBeUndefined();
  });

  it('cascades when the user is deleted', () => {
    const svc = new SessionService(database.db, { now });
    const { id } = svc.create(userId);
    database.sqlite.prepare('delete from users where id = ?').run(userId);
    expect(svc.validate(id)).toBeUndefined();
  });

  it('purgeExpired removes only expired rows', () => {
    const svc = new SessionService(database.db, { now, ttlMs: 1000 });
    svc.create(userId);
    clock.t += 5000;
    const live = svc.create(userId);
    expect(svc.purgeExpired()).toBe(1);
    expect(svc.validate(live.id)).toBeDefined();
  });

  it('derives a stable per-session CSRF token and compares it strictly', () => {
    const svc = new SessionService(database.db, { now });
    const a = svc.create(userId);
    const b = svc.create(userId);
    expect(a.csrfToken).toBe(csrfTokenFor(a.id));
    expect(svc.validate(a.id)?.csrfToken).toBe(a.csrfToken);
    expect(a.csrfToken).not.toBe(b.csrfToken);
    expect(csrfTokenMatches(a.id, a.csrfToken)).toBe(true);
    expect(csrfTokenMatches(a.id, b.csrfToken)).toBe(false);
    expect(csrfTokenMatches(a.id, undefined)).toBe(false);
    expect(csrfTokenMatches(a.id, '')).toBe(false);
    expect(csrfTokenMatches(a.id, a.csrfToken + 'x')).toBe(false);
  });
});

describe('ApiKeyService', () => {
  it('stores only a hash and shows the secret once', () => {
    const svc = new ApiKeyService(database.db, now);
    const { row, secret } = svc.create(userId, 'ci');
    expect(secret.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(secret.length).toBeGreaterThan(40);
    expect(row.hash).toBe(hashApiKey(secret));
    expect(row.hash).not.toContain(secret);
    expect(row.prefix).toBe(secret.slice(0, 8));
    expect(JSON.stringify(database.db.select().from(apiKeys).all())).not.toContain(secret);
  });

  it('authenticates, rejects wrong keys, and stops after deletion', () => {
    const svc = new ApiKeyService(database.db, now);
    const { row, secret } = svc.create(userId, 'ci');
    expect(svc.authenticate(secret)?.user.id).toBe(userId);
    expect(svc.authenticate(secret + 'x')).toBeUndefined();
    expect(svc.authenticate('hrr_nope')).toBeUndefined();
    expect(svc.authenticate(hashApiKey(secret))).toBeUndefined();
    expect(svc.delete('someone-else', row.id)).toBe(false);
    expect(svc.delete(userId, row.id)).toBe(true);
    expect(svc.authenticate(secret)).toBeUndefined();
  });

  it('throttles last_used_at writes', () => {
    const svc = new ApiKeyService(database.db, now);
    const { row, secret } = svc.create(userId, 'ci');
    const lastUsed = () =>
      database.db.select().from(apiKeys).where(eq(apiKeys.id, row.id)).get()?.lastUsedAt?.getTime();
    expect(lastUsed()).toBeUndefined();
    svc.authenticate(secret);
    const first = lastUsed();
    expect(first).toBe(clock.t);
    clock.t += LAST_USED_THROTTLE_MS - 1;
    svc.authenticate(secret);
    expect(lastUsed()).toBe(first);
    clock.t += 2;
    svc.authenticate(secret);
    expect(lastUsed()).toBe(clock.t);
  });

  it('caps keys per user', () => {
    const svc = new ApiKeyService(database.db, now);
    for (let i = 0; i < MAX_KEYS_PER_USER; i++) svc.create(userId, `k${String(i)}`);
    expect(() => svc.create(userId, 'one too many')).toThrow(TooManyKeysError);
  });

  it('is removed with its user', () => {
    const svc = new ApiKeyService(database.db, now);
    const { secret } = svc.create(userId, 'ci');
    users.delete(userId);
    expect(svc.authenticate(secret)).toBeUndefined();
  });

  it('extracts keys from X-Api-Key or a hrr_ bearer token only', () => {
    expect(extractApiKey({ 'x-api-key': 'hrr_abc' })).toBe('hrr_abc');
    expect(extractApiKey({ authorization: 'Bearer hrr_abc' })).toBe('hrr_abc');
    expect(extractApiKey({ authorization: 'bearer hrr_abc' })).toBe('hrr_abc');
    expect(extractApiKey({ authorization: 'Bearer something-else' })).toBeUndefined();
    expect(extractApiKey({ authorization: 'Basic hrr_abc' })).toBeUndefined();
    expect(extractApiKey({})).toBeUndefined();
  });
});
