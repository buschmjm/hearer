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
