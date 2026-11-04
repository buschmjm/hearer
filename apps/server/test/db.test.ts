import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, getTableName, is, sql } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Database_ } from '../src/db/client.ts';
import { resolveMigrationsFolder, runMigrations } from '../src/db/migrate.ts';
import * as schema from '../src/db/schema.ts';

let database: Database_;

beforeEach(() => {
  database = openDatabase(':memory:');
  runMigrations(database.db);
});
afterEach(() => {
  database.close();
});

const mkUser = (username: string, extra: Partial<schema.NewUser> = {}) =>
  database.db
    .insert(schema.users)
    .values({ username, authType: 'local', ...extra })
    .returning()
    .get();

describe('migrations', () => {
  it('create every table in the data model', () => {
    const rows = database.sqlite
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '\\_\\_%' escape '\\'",
      )
      .all() as { name: string }[];
    expect(rows.map((r) => r.name).sort()).toEqual(
      [
        'api_keys',
        'jobs',
        'library_items',
        'mb_cache',
        'notification_targets',
        'request_events',
        'requests',
        'sessions',
        'settings',
        'uploads',
        'users',
      ].sort(),
    );
    const exported = Object.values(schema)
      .filter((v) => is(v, SQLiteTable))
      .map((t) => getTableName(t));
    expect(exported.sort()).toEqual(rows.map((r) => r.name).sort());
  });

  it('are idempotent', () => {
    expect(() => {
      runMigrations(database.db);
    }).not.toThrow();
  });

  it('fail clearly when the folder is missing', () => {
    expect(() => resolveMigrationsFolder('/nonexistent/dir')).toThrow(/migrations not found/);
  });

  it('keep foreign keys enforced and the expected pragmas', () => {
    expect(database.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(database.sqlite.pragma('synchronous', { simple: true })).toBe(1);
    expect(() =>
      database.db
        .insert(schema.sessions)
        .values({ id: 's', userId: 'missing', expiresAt: new Date() })
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe('file database', () => {
  it('creates the data dir, uses WAL and persists across opens', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'hearer-db-')), 'nested', 'data');
    try {
      const first = openDatabase(dir);
      expect(existsSync(join(dir, 'hearer.db'))).toBe(true);
      expect(first.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
      runMigrations(first.db);
      first.db.insert(schema.settings).values({ key: 'k', valueJson: '1' }).run();
      first.close();
      first.close(); // double close is safe
      const second = openDatabase(dir);
      runMigrations(second.db);
      expect(second.db.select().from(schema.settings).all()).toHaveLength(1);
      second.close();
    } finally {
      rmSync(join(dir, '..', '..'), { recursive: true, force: true });
    }
  });
});

describe('defaults and timestamps', () => {
  it('fills ids, default permissions and ms timestamps', () => {
    const before = Date.now();
    const user = mkUser('alice');
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.permissions).toBe(8 | 16 | 256);
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(user.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('round trips JSON columns', () => {
    const user = mkUser('bob', {
      notifyPrefs: { email: { enabled: true, events: ['request.available'] } },
    });
    const upload = database.db
      .insert(schema.uploads)
      .values({ uploaderId: user.id, originalName: 'a.flac', matchJson: [{ score: 0.9 }] })
      .returning()
      .get();
    expect(upload.matchJson).toEqual([{ score: 0.9 }]);
    expect(upload.status).toBe('RECEIVING');
    expect(user.notifyPrefs).toEqual({ email: { enabled: true, events: ['request.available'] } });
  });
});

describe('unique constraints', () => {
  it('rejects duplicate usernames regardless of case', () => {
    mkUser('Alice');
    expect(() => mkUser('alice')).toThrow(/UNIQUE/);
  });

  it('rejects duplicate (auth_type, external_id) but allows many null external ids', () => {
    mkUser('a', { authType: 'jellyfin', externalId: 'jf-1' });
    expect(() => mkUser('b', { authType: 'jellyfin', externalId: 'jf-1' })).toThrow(/UNIQUE/);
    expect(() => mkUser('c', { authType: 'oidc', externalId: 'jf-1' })).not.toThrow();
    expect(() => mkUser('d')).not.toThrow();
    expect(() => mkUser('e')).not.toThrow();
  });

  it('rejects duplicate api key hashes', () => {
    const u = mkUser('k');
    const row = { userId: u.id, name: 'n', hash: 'h', prefix: 'p' };
    database.db.insert(schema.apiKeys).values(row).run();
    expect(() => database.db.insert(schema.apiKeys).values(row).run()).toThrow(/UNIQUE/);
  });

  it('allows one active job per unique key, but a new one after it finishes', () => {
    const insert = () =>
      database.db
        .insert(schema.jobs)
        .values({ type: 'library.sync', uniqueKey: 'sync' })
        .returning()
        .get();
    const first = insert();
    expect(() => insert()).toThrow(/UNIQUE/);
    database.db
      .update(schema.jobs)
      .set({ status: 'succeeded' })
      .where(eq(schema.jobs.id, first.id))
      .run();
    expect(() => insert()).not.toThrow();
    // jobs without a key are never de-duplicated
    database.db.insert(schema.jobs).values({ type: 'x' }).run();
    database.db.insert(schema.jobs).values({ type: 'x' }).run();
  });
});

describe('foreign key behavior', () => {
  it('cascades user deletion to sessions, api keys, requests, events and uploads', () => {
    const u = mkUser('victim');
    database.db
      .insert(schema.sessions)
      .values({ id: 's1', userId: u.id, expiresAt: new Date() })
      .run();
    database.db
      .insert(schema.apiKeys)
      .values({ userId: u.id, name: 'n', hash: 'h', prefix: 'p' })
      .run();
    const req = database.db
      .insert(schema.requests)
      .values({ type: 'album', mbid: 'm', title: 'T', requestedBy: u.id })
      .returning()
      .get();
    database.db
      .insert(schema.requestEvents)
      .values({ requestId: req.id, toStatus: 'PENDING', actorId: u.id })
      .run();
    database.db.insert(schema.uploads).values({ uploaderId: u.id, originalName: 'x.mp3' }).run();

    database.db.delete(schema.users).where(eq(schema.users.id, u.id)).run();
    for (const t of [
      schema.sessions,
      schema.apiKeys,
      schema.requests,
      schema.requestEvents,
      schema.uploads,
    ]) {
      expect(
        database.db
          .select({ n: sql<number>`count(*)` })
          .from(t)
          .get()?.n,
      ).toBe(0);
    }
  });

  it('nulls decided_by and the actor when the deciding user is deleted', () => {
    const requester = mkUser('requester');
    const admin = mkUser('admin');
    const req = database.db
      .insert(schema.requests)
      .values({
        type: 'track',
        mbid: 'm',
        title: 'T',
        requestedBy: requester.id,
        decidedBy: admin.id,
      })
      .returning()
      .get();
    database.db
      .insert(schema.requestEvents)
      .values({ requestId: req.id, toStatus: 'APPROVED', actorId: admin.id })
      .run();
    database.db.delete(schema.users).where(eq(schema.users.id, admin.id)).run();
    expect(database.db.select().from(schema.requests).get()?.decidedBy).toBeNull();
    expect(database.db.select().from(schema.requestEvents).get()?.actorId).toBeNull();
  });

  it('keeps the link between requests and uploads consistent when either side is deleted', () => {
    const u = mkUser('linker');
    const req = database.db
      .insert(schema.requests)
      .values({ type: 'track', mbid: 'm', title: 'T', requestedBy: u.id })
      .returning()
      .get();
    const up = database.db
      .insert(schema.uploads)
      .values({ uploaderId: u.id, originalName: 'x', targetRequestId: req.id })
      .returning()
      .get();
    database.db
      .update(schema.requests)
      .set({ fulfilledByUploadId: up.id })
      .where(eq(schema.requests.id, req.id))
      .run();

    database.db.delete(schema.uploads).where(eq(schema.uploads.id, up.id)).run();
    expect(database.db.select().from(schema.requests).get()?.fulfilledByUploadId).toBeNull();

    const up2 = database.db
      .insert(schema.uploads)
      .values({ uploaderId: u.id, originalName: 'y', targetRequestId: req.id })
      .returning()
      .get();
    database.db.delete(schema.requests).where(eq(schema.requests.id, req.id)).run();
    expect(
      database.db.select().from(schema.uploads).where(eq(schema.uploads.id, up2.id)).get()
        ?.targetRequestId,
    ).toBeNull();
  });
});
