import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { type rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DestinationExistsError,
  MoveVerificationError,
  TMP_PREFIX,
  moveIntoLibrary,
  sha256File,
} from '../src/lib/atomicMove.ts';
import { PathEscapeError } from '../src/lib/paths.ts';

let base: string;
let root: string;
let src: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'hearer-move-'));
  root = join(base, 'music');
  mkdirSync(root);
  src = join(base, 'work.bin');
  writeFileSync(src, 'some audio bytes');
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const expectedOf = async (path: string) => ({
  size: statSync(path).size,
  sha256: await sha256File(path),
});

const exdev: typeof rename = () =>
  Promise.reject(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));

describe('moveIntoLibrary', () => {
  it('renames within a filesystem, creating directories with the umask applied', async () => {
    const expected = await expectedOf(src);
    const dest = join(root, 'A', 'B', 'x.flac');
    const result = await moveIntoLibrary(src, dest, { root, expected, umask: 0o022 });
    expect(result.how).toBe('rename');
    expect(readFileSync(dest, 'utf8')).toBe('some audio bytes');
    expect(existsSync(src)).toBe(false);
    expect(statSync(dest).mode & 0o777).toBe(0o644);
    expect(statSync(join(root, 'A')).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, 'A', 'B')).mode & 0o777).toBe(0o755);
  });

  it('honours a stricter umask', async () => {
    const dest = join(root, 'A', 'x.flac');
    await moveIntoLibrary(src, dest, { root, expected: await expectedOf(src), umask: 0o077 });
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'A')).mode & 0o777).toBe(0o700);
  });

  it('copies, verifies and removes the source on EXDEV', async () => {
    const expected = await expectedOf(src);
    const dest = join(root, 'A', 'x.flac');
    const points: string[] = [];
    const result = await moveIntoLibrary(src, dest, {
      root,
      expected,
      umask: 0o022,
      rename: exdev,
      hook: (p) => {
        points.push(p);
      },
    });
    expect(result.how).toBe('copy');
    expect(points).toEqual(['dirs-created', 'tmp-written', 'tmp-verified', 'renamed']);
    expect(readFileSync(dest, 'utf8')).toBe('some audio bytes');
    expect(statSync(dest).mode & 0o777).toBe(0o644);
    expect(existsSync(src)).toBe(false);
    expect(readdirSync(join(root, 'A'))).toEqual(['x.flac']);
  });

  it('keeps the source when the copy fails verification, and removes the temp file', async () => {
    const dest = join(root, 'A', 'x.flac');
    await expect(
      moveIntoLibrary(src, dest, {
        root,
        expected: { size: 16, sha256: 'f'.repeat(64) },
        rename: exdev,
      }),
    ).rejects.toBeInstanceOf(MoveVerificationError);
    expect(existsSync(src)).toBe(true);
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(join(root, 'A'))).toEqual([]);
  });

  it('refuses a directory in the way before copying anything', async () => {
    const dest = join(root, 'A', 'x.flac');
    // Cause a failure after the copy: the destination name is a directory.
    mkdirSync(dest, { recursive: true });
    await expect(
      moveIntoLibrary(src, dest, { root, expected: await expectedOf(src), rename: exdev }),
    ).rejects.toBeInstanceOf(DestinationExistsError);
    expect(existsSync(src)).toBe(true);
  });

  it('never overwrites a different file', async () => {
    const dest = join(root, 'x.flac');
    writeFileSync(dest, 'precious');
    await expect(
      moveIntoLibrary(src, dest, { root, expected: await expectedOf(src) }),
    ).rejects.toBeInstanceOf(DestinationExistsError);
    expect(readFileSync(dest, 'utf8')).toBe('precious');
    expect(existsSync(src)).toBe(true);
  });

  it('reports identical content as already there and leaves the source to the caller', async () => {
    const dest = join(root, 'x.flac');
    writeFileSync(dest, 'some audio bytes');
    const result = await moveIntoLibrary(src, dest, { root, expected: await expectedOf(src) });
    expect(result.how).toBe('exists');
    expect(existsSync(src)).toBe(true);
  });

  it('refuses destinations outside the root, including through a symlink', async () => {
    const expected = await expectedOf(src);
    await expect(
      moveIntoLibrary(src, join(root, '..', 'escape.flac'), { root, expected }),
    ).rejects.toBeInstanceOf(PathEscapeError);
    const outside = join(base, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'link'));
    await expect(
      moveIntoLibrary(src, join(root, 'link', 'x.flac'), { root, expected }),
    ).rejects.toBeInstanceOf(PathEscapeError);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(src)).toBe(true);
  });

  it('removes stale temp files of an earlier crash, but not fresh ones', async () => {
    const dir = join(root, 'A');
    mkdirSync(dir);
    const stale = join(dir, `${TMP_PREFIX}stale`);
    const fresh = join(dir, `${TMP_PREFIX}fresh`);
    writeFileSync(stale, 'x');
    writeFileSync(fresh, 'y');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(stale, old, old);
    await moveIntoLibrary(src, join(dir, 'x.flac'), {
      root,
      expected: await expectedOf(src),
      rename: exdev,
    });
    expect(readdirSync(dir).sort()).toEqual([`${TMP_PREFIX}fresh`, 'x.flac']);
  });
});
