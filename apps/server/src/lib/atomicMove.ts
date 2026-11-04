/**
 * Moving a finished file into the library (DECISIONS rule 4/5, PLAN H-15).
 *
 * `moveIntoLibrary` renames when source and destination share a filesystem. Across filesystems
 * (EXDEV) it copies to `<destdir>/.hearer-tmp-<random>`, fsyncs the file and the directory,
 * verifies size and sha256 of what landed on disk, renames to the final name (same directory, so
 * atomic), fsyncs the directory and only then removes the source. A crash at any point leaves
 * either the source intact or a complete destination, never a half-written final file; a leftover
 * `.hearer-tmp-*` is dotted (media servers skip it) and is removed by the next move into that
 * directory once it is older than ten minutes.
 *
 * New files get `0o666 & ~umask`, new directories `0o777 & ~umask`, explicitly (the process umask
 * is applied by the OS as well; this makes the result independent of how the caller created it).
 * An existing destination with different content is never overwritten.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { assertInside } from './paths.ts';

/** Streaming sha256 of a file, hex. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => {
        resolve(hash.digest('hex'));
      })
      .on('error', reject);
  });
}

export const TMP_PREFIX = '.hearer-tmp-';
const STALE_TMP_MS = 10 * 60_000;
const COPY_CHUNK = 1024 * 1024;

/** The destination exists and holds different content. */
export class DestinationExistsError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Refusing to overwrite an existing, different file: ${path}`);
    this.name = 'DestinationExistsError';
    this.path = path;
  }
}

/** The copy that landed on disk differs from the source. */
export class MoveVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoveVerificationError';
  }
}

export interface MoveOptions {
  /** The library root; the destination must stay inside it. */
  root: string;
  /** Expected size and sha256 of the source (used to verify the copy). */
  expected: { size: number; sha256: string };
  /** Process umask. Default: the current one. */
  umask?: number;
  /** `fs.rename` replacement (tests simulate EXDEV). */
  rename?: typeof rename;
  /** Called at named steps; tests make it throw to simulate a crash. */
  hook?: (point: MovePoint) => void | Promise<void>;
  now?: () => number;
}

export type MovePoint = 'dirs-created' | 'tmp-written' | 'tmp-verified' | 'renamed';

export interface MoveResult {
  path: string;
  /** `rename`, `copy` (EXDEV), or `exists` (identical content was already there). */
  how: 'rename' | 'copy' | 'exists';
}

export function currentUmask(): number {
  const previous = process.umask(0);
  process.umask(previous);
  return previous;
}

const isCode = (err: unknown, ...codes: string[]): boolean =>
  codes.includes((err as NodeJS.ErrnoException).code ?? '');

async function fsyncDir(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch (err) {
    // Not every filesystem lets a directory be synced; that is not a failure of the move.
    if (!isCode(err, 'EINVAL', 'EPERM', 'ENOTSUP', 'EISDIR', 'EBADF')) throw err;
  } finally {
    await handle?.close();
  }
}

/** `mkdir -p` that gives every directory it creates `0o777 & ~umask`. */
export async function mkdirp(root: string, dir: string, umask: number): Promise<void> {
  const target = assertInside(root, dir, { allowRoot: true });
  const missing: string[] = [];
  for (let current = target; ; current = dirname(current)) {
    try {
      const stats = await stat(current);
      if (!stats.isDirectory()) throw new Error(`${current} is not a directory`);
      break;
    } catch (err) {
      if (!isCode(err, 'ENOENT')) throw err;
      missing.unshift(current);
      if (dirname(current) === current) break;
    }
  }
  const mode = 0o777 & ~umask;
  for (const created of missing) {
    try {
      await mkdir(created, { mode });
    } catch (err) {
      if (!isCode(err, 'EEXIST')) throw err;
      continue;
    }
    await chmod(created, mode);
  }
}

async function removeStaleTemps(dir: string, now: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const path = join(dir, name);
    try {
      if (now - (await stat(path)).mtimeMs > STALE_TMP_MS) await rm(path, { force: true });
    } catch {
      // best effort
    }
  }
}

async function copyDurably(src: string, tmp: string, mode: number): Promise<void> {
  const input = await open(src, 'r');
  let output;
  try {
    output = await open(tmp, 'wx', mode);
    const buffer = Buffer.allocUnsafe(COPY_CHUNK);
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, COPY_CHUNK, null);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        written += (await output.write(buffer, written, bytesRead - written)).bytesWritten;
      }
    }
    await output.sync();
  } finally {
    await output?.close();
    await input.close();
  }
  await chmod(tmp, mode);
}

/** Move `src` to `dest` (both absolute). See the file header. */
export async function moveIntoLibrary(
  src: string,
  dest: string,
  options: MoveOptions,
): Promise<MoveResult> {
  const { root, expected } = options;
  const doRename = options.rename ?? rename;
  const umask = options.umask ?? currentUmask();
  const destination = assertInside(root, dest);
  const dir = dirname(destination);
  const fileMode = 0o666 & ~umask;

  await mkdirp(root, dir, umask);
  await options.hook?.('dirs-created');

  try {
    const existing = await stat(destination);
    if (existing.isFile() && existing.size === expected.size) {
      if ((await sha256File(destination)) === expected.sha256) {
        return { path: destination, how: 'exists' };
      }
    }
    throw new DestinationExistsError(destination);
  } catch (err) {
    if (!isCode(err, 'ENOENT')) throw err;
  }

  await chmod(src, fileMode);
  try {
    await doRename(src, destination);
    await options.hook?.('renamed');
    await fsyncDir(dir);
    return { path: destination, how: 'rename' };
  } catch (err) {
    if (!isCode(err, 'EXDEV')) throw err;
  }

  // Different filesystem: copy durably next to the destination, verify, then rename.
  await removeStaleTemps(dir, (options.now ?? Date.now)());
  const tmp = join(dir, `${TMP_PREFIX}${randomBytes(6).toString('hex')}`);
  if (!tmp.startsWith(dir + sep)) throw new Error('temporary path escaped its directory');
  try {
    await copyDurably(src, tmp, fileMode);
    await options.hook?.('tmp-written');
    await fsyncDir(dir);
    const copied = await stat(tmp);
    if (copied.size !== expected.size || (await sha256File(tmp)) !== expected.sha256) {
      throw new MoveVerificationError('The copied file does not match the source');
    }
    await options.hook?.('tmp-verified');
    await rename(tmp, destination);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await fsyncDir(dir);
  await options.hook?.('renamed');
  await unlink(src);
  return { path: destination, how: 'copy' };
}
