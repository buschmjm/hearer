import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './client.ts';

/**
 * Locate the committed migrations. In dev this file is `src/db/migrate.ts` and the folder is
 * `apps/server/drizzle`; in the bundle everything is `dist/index.js` and the build copies the
 * folder to `dist/drizzle`.
 */
export function resolveMigrationsFolder(
  fromDir: string = dirname(fileURLToPath(import.meta.url)),
): string {
  const candidates = [join(fromDir, 'drizzle'), join(fromDir, '..', '..', 'drizzle')];
  const found = candidates.find((dir) => existsSync(join(dir, 'meta', '_journal.json')));
  if (!found) {
    throw new Error(`Database migrations not found (looked in: ${candidates.join(', ')})`);
  }
  return found;
}

/** Apply all pending migrations. Idempotent. */
export function runMigrations(db: Db, migrationsFolder: string = resolveMigrationsFolder()): void {
  migrate(db, { migrationsFolder });
}
