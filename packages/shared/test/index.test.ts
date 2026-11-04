import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_NAME, APP_VERSION, REPO_URL, userAgent } from '../src/index.ts';

describe('shared constants', () => {
  it('exposes the app name and a semver version', () => {
    expect(APP_NAME).toBe('Hearer');
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('builds a MusicBrainz-compliant user agent', () => {
    expect(userAgent()).toBe(`Hearer/${APP_VERSION} ( ${REPO_URL} )`);
    expect(userAgent('1.2.3')).toBe('Hearer/1.2.3 ( https://github.com/buschmjm/hearer )');
  });
});

describe('release versioning', () => {
  const repo = join(import.meta.dirname, '..', '..', '..');
  const versionOf = (path: string): unknown =>
    (JSON.parse(readFileSync(join(repo, path), 'utf8')) as { version?: unknown }).version;

  it('keeps APP_VERSION and every package.json version in lockstep (release-please updates all)', () => {
    for (const path of [
      'package.json',
      'apps/server/package.json',
      'apps/web/package.json',
      'packages/shared/package.json',
    ]) {
      expect(versionOf(path), path).toBe(APP_VERSION);
    }
  });

  it('marks APP_VERSION so release-please can rewrite it', () => {
    const source = readFileSync(join(repo, 'packages/shared/src/index.ts'), 'utf8');
    expect(source).toMatch(/export const APP_VERSION = '[^']+'; \/\/ x-release-please-version/u);
  });
});
