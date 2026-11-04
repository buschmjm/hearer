import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.ts';

export type Db = BetterSQLite3Database<typeof schema>;

export const DB_FILENAME = 'hearer.db';
export const MEMORY_DB = ':memory:';
const BUSY_TIMEOUT_MS = 5000;

export interface Database_ {
  db: Db;
  /** The underlying handle, for pragmas and raw statements. */
  sqlite: Database.Database;
  close: () => void;
}

/**
 * Open the SQLite database. `location` is the data directory (created when missing; the file
 * is `<dir>/hearer.db`) or `:memory:` for tests.
 */
export function openDatabase(location: string): Database_ {
  const inMemory = location === MEMORY_DB;
  if (!inMemory) mkdirSync(location, { recursive: true });
  const sqlite = new Database(inMemory ? MEMORY_DB : join(location, DB_FILENAME));
  try {
    // WAL is not available for in-memory databases; SQLite silently keeps "memory" there.
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    sqlite.pragma('synchronous = NORMAL');
  } catch (err) {
    sqlite.close();
    throw err;
  }
  return {
    db: drizzle(sqlite, { schema }),
    sqlite,
    close: () => {
      if (sqlite.open) sqlite.close();
    },
  };
}

/** Cheap liveness probe used by the health endpoint. */
export function pingDatabase(database: Pick<Database_, 'sqlite'>): void {
  database.sqlite.prepare('select 1').get();
}
