/**
 * Fails when src/db/schema.ts and the committed migrations in ./drizzle disagree:
 *   1. `drizzle-kit check` validates the migration history itself.
 *   2. `drizzle-kit generate` against a scratch copy of the migrations must produce nothing new.
 * Run with `pnpm --filter server db:check`.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const drizzleKit = join(dirname(createRequire(import.meta.url).resolve('drizzle-kit')), 'bin.cjs');
// drizzle-kit resolves `out` relative to its cwd, so the scratch dir lives inside the package.
const scratch = mkdtempSync(join(root, '.db-check-'));

function kit(args: string[]): string {
  return execFileSync(process.execPath, [drizzleKit, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sqlFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

class CheckError extends Error {}

try {
  try {
    kit(['check']);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new CheckError(
      `db:check failed: drizzle-kit check reported problems\n${e.stdout ?? ''}${e.stderr ?? ''}`,
    );
  }

  const out = join(scratch, 'drizzle');
  cpSync(join(root, 'drizzle'), out, { recursive: true });
  const configPath = join(scratch, 'drizzle.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      dialect: 'sqlite',
      schema: './src/db/schema.ts',
      out: `./${relative(root, out)}`,
    }),
  );
  const before = sqlFiles(out);
  let output: string;
  try {
    output = kit(['generate', '--config', configPath]);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new CheckError(
      `db:check failed: drizzle-kit generate errored\n${e.stdout ?? ''}${e.stderr ?? ''}`,
    );
  }
  // drizzle-kit can exit 0 on errors, so require its explicit "nothing to do" message.
  const added = sqlFiles(out).filter((f) => !before.includes(f));
  if (added.length > 0) {
    throw new CheckError(
      'db:check failed: src/db/schema.ts has changes that are not in the committed migrations.\n' +
        'Run `pnpm --filter server db:generate` and commit the result.',
    );
  }
  if (!/No schema changes/i.test(output)) {
    throw new CheckError(`db:check failed: unexpected drizzle-kit output\n${output}`);
  }
  console.log(`db:check ok: schema matches ${before.length} committed migration(s)`);
} catch (err) {
  if (!(err instanceof CheckError)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
