import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  it('applies defaults for an empty environment', () => {
    expect(loadConfig({})).toEqual({
      nodeEnv: 'production',
      host: '0.0.0.0',
      port: 5055,
      baseUrl: undefined,
      dataDir: '/data',
      musicDir: '/music',
      stagingDir: '/staging',
      logLevel: 'info',
      logFormat: 'json',
      secret: undefined,
      trustProxy: false,
      authRateLimitMax: 10,
    });
  });

  it('applies overrides', () => {
    const config = loadConfig({
      PORT: '8080',
      HOST: '127.0.0.1',
      BASE_URL: 'https://hearer.example.com',
      DATA_DIR: '/var/hearer',
      MUSIC_DIR: '/srv/music',
      STAGING_DIR: '/srv/staging',
      LOG_LEVEL: 'debug',
      LOG_FORMAT: 'pretty',
      HEARER_SECRET: 'a-sufficiently-long-secret',
      TRUST_PROXY: '2',
      NODE_ENV: 'development',
    });
    expect(config).toMatchObject({
      port: 8080,
      host: '127.0.0.1',
      baseUrl: 'https://hearer.example.com',
      dataDir: '/var/hearer',
      musicDir: '/srv/music',
      stagingDir: '/srv/staging',
      logLevel: 'debug',
      logFormat: 'pretty',
      secret: 'a-sufficiently-long-secret',
      trustProxy: 2,
      nodeEnv: 'development',
    });
  });

  it.each([
    ['true', true],
    ['false', false],
    ['1', 1],
    ['0', false],
    ['3', 3],
    ['', false],
  ])('parses TRUST_PROXY=%j', (raw, expected) => {
    expect(loadConfig({ TRUST_PROXY: raw }).trustProxy).toBe(expected);
  });

  it('treats empty optional values as unset', () => {
    const config = loadConfig({ BASE_URL: '', HEARER_SECRET: '' });
    expect(config.baseUrl).toBeUndefined();
    expect(config.secret).toBeUndefined();
  });

  it('throws a readable ConfigError listing every bad variable', () => {
    let error: unknown;
    try {
      loadConfig({ PORT: 'abc', BASE_URL: 'not a url', LOG_LEVEL: 'loud', TRUST_PROXY: 'maybe' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain('PORT');
    expect(message).toContain('BASE_URL');
    expect(message).toContain('LOG_LEVEL');
    expect(message).toContain('TRUST_PROXY');
  });

  it('rejects out-of-range ports and short secrets', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '0' })).toThrow(/PORT/);
    expect(() => loadConfig({ HEARER_SECRET: 'short' })).toThrow(/HEARER_SECRET/);
  });
});

describe('E2E import pause hook', () => {
  it('is ignored unless NODE_ENV=test', () => {
    expect(loadConfig({ HEARER_TEST_IMPORT_PAUSE_MS: '5000' }).testImportPause).toBeUndefined();
    expect(
      loadConfig({ NODE_ENV: 'development', HEARER_TEST_IMPORT_PAUSE_MS: '5000' }).testImportPause,
    ).toBeUndefined();
  });

  it('defaults to the state-saved step under NODE_ENV=test and accepts another', () => {
    const env = { NODE_ENV: 'test', HEARER_TEST_IMPORT_PAUSE_MS: '5000' };
    expect(loadConfig(env).testImportPause).toEqual({ ms: 5000, point: 'state-saved' });
    expect(loadConfig({ ...env, HEARER_TEST_IMPORT_PAUSE_AT: 'moved' }).testImportPause).toEqual({
      ms: 5000,
      point: 'moved',
    });
  });

  it('is off when unset', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).testImportPause).toBeUndefined();
  });
});
