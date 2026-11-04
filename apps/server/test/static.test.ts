import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { resolveStaticDir } from '../src/static.ts';
import { createHarness, type Harness } from './helpers/auth.ts';

const INDEX = '<!doctype html><title>Hearer</title><div id="root"></div>';
const HTML = { accept: 'text/html,application/xhtml+xml' };

let webDir: string;
let h: Harness | undefined;

beforeEach(() => {
  webDir = mkdtempSync(join(tmpdir(), 'hearer-web-'));
  mkdirSync(join(webDir, 'assets'));
  writeFileSync(join(webDir, 'index.html'), INDEX);
  writeFileSync(join(webDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(webDir, 'assets', 'index-abc123.js'), 'console.log(1)');
});

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  rmSync(webDir, { recursive: true, force: true });
});

const withWeb = async () => {
  h = await createHarness({ env: { STATIC_DIR: webDir } });
  return h.app;
};

describe('static web app', () => {
  it('serves index.html at / with no-cache', async () => {
    const app = await withWeb();
    const res = await app.inject({ url: '/', headers: HTML });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toBe(INDEX);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('caches hashed assets for a year and other files briefly', async () => {
    const app = await withWeb();
    const asset = await app.inject({ url: '/assets/index-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const icon = await app.inject({ url: '/favicon.svg' });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('falls back to index.html for client routes requested as HTML', async () => {
    const app = await withWeb();
    for (const url of ['/setup', '/login', '/search?q=radiohead', '/requests/42']) {
      const res = await app.inject({ url, headers: HTML });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toBe(INDEX);
      expect(res.headers['cache-control'], url).toBe('no-cache');
    }
  });

  it('answers HEAD for client routes too', async () => {
    const app = await withWeb();
    const res = await app.inject({ method: 'HEAD', url: '/setup', headers: HTML });
    expect(res.statusCode).toBe(200);
  });

  it('keeps JSON 404s for unknown /api paths, even when HTML is accepted', async () => {
    const app = await withWeb();
    for (const url of ['/api/v1/nope', '/api/nope', '/api']) {
      const res = await app.inject({ url, headers: HTML });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toContain('application/json');
      expect(res.json<{ error: { code: string } }>().error.code).toBe('not_found');
    }
  });

  it('keeps API routes working', async () => {
    const app = await withWeb();
    const res = await app.inject({ url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('ok');
  });

  it('returns a JSON 404 for missing non-HTML requests and missing assets', async () => {
    const app = await withWeb();
    const asset = await app.inject({ url: '/assets/missing.js', headers: { accept: '*/*' } });
    expect(asset.statusCode).toBe(404);
    expect(asset.headers['content-type']).toContain('application/json');
    const post = await app.inject({ method: 'POST', url: '/setup', headers: HTML });
    expect(post.statusCode).toBe(404);
  });

  it('does not escape the web root', async () => {
    const app = await withWeb();
    const res = await app.inject({ url: '/..%2f..%2fetc/passwd', headers: { accept: '*/*' } });
    expect(res.statusCode).not.toBe(200);
  });
});

describe('security headers', () => {
  it('sends a CSP with the expected directives on pages and API responses', async () => {
    const app = await withWeb();
    for (const url of ['/', '/api/v1/health', '/api/v1/nope']) {
      const res = await app.inject({ url, headers: HTML });
      const csp = String(res.headers['content-security-policy']);
      expect(csp, url).toContain("default-src 'self'");
      expect(csp, url).toContain("script-src 'self'");
      expect(csp, url).toContain("style-src 'self'");
      expect(csp, url).not.toContain('unsafe-inline');
      expect(csp, url).toContain("connect-src 'self'");
      expect(csp, url).toContain(
        "img-src 'self' data: https://coverartarchive.org https://archive.org https://*.archive.org",
      );
      expect(csp, url).toContain("frame-ancestors 'none'");
      expect(csp, url).not.toContain('upgrade-insecure-requests');
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
    }
  });

  it('adds the configured cover art origin to img-src, and follows settings changes', async () => {
    const app = await withWeb();
    const imgSrc = async (): Promise<string> => {
      const res = await app.inject({ url: '/api/v1/health' });
      const csp = String(res.headers['content-security-policy']);
      return csp.split(';').find((d) => d.startsWith('img-src')) ?? '';
    };
    // Default: the origin repeats the built-in coverartarchive.org entry.
    expect(await imgSrc()).toContain('https://coverartarchive.org');
    const metadata = app.hearer.settings.get('metadata');
    app.hearer.settings.set('metadata', {
      ...metadata,
      coverArtBaseUrl: 'http://127.0.0.1:4567/caa',
    });
    expect(await imgSrc()).toContain('http://127.0.0.1:4567');
    expect(await imgSrc()).not.toContain('/caa');
  });

  it('is present in API-only mode too', async () => {
    h = await createHarness();
    const res = await h.app.inject({ url: '/api/v1/health' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});

describe('API-only mode', () => {
  it('works without a web build: / is a JSON 404, API unaffected', async () => {
    h = await createHarness({ env: { STATIC_DIR: join(webDir, 'does-not-exist') } });
    const root = await h.app.inject({ url: '/', headers: HTML });
    expect(root.statusCode).toBe(404);
    expect(root.headers['content-type']).toContain('application/json');
    expect((await h.app.inject({ url: '/api/v1/health' })).statusCode).toBe(200);
  });

  it('treats a directory without index.html as no web app', () => {
    const empty = mkdtempSync(join(tmpdir(), 'hearer-empty-'));
    try {
      expect(resolveStaticDir(loadConfig({ NODE_ENV: 'test', STATIC_DIR: empty }))).toBeUndefined();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('resolveStaticDir', () => {
  it('honours STATIC_DIR when it holds a build', () => {
    expect(resolveStaticDir(loadConfig({ NODE_ENV: 'test', STATIC_DIR: webDir }))).toBe(webDir);
  });

  it('defaults to nothing in tests and to /app/public only if it exists in production', () => {
    expect(resolveStaticDir(loadConfig({ NODE_ENV: 'test' }))).toBeUndefined();
    // /app/public does not exist in the dev container.
    expect(resolveStaticDir(loadConfig({ NODE_ENV: 'production' }))).toBeUndefined();
  });
});

describe('GET /api/v1/auth/methods', () => {
  it('is public and reports the defaults, before and after setup', async () => {
    h = await createHarness();
    const res = await h.app.inject({ url: '/api/v1/auth/methods' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      appTitle: 'Hearer',
      local: true,
      jellyfin: false,
      oidc: { enabled: false, buttonLabel: 'Sign in with SSO' },
    });
  });

  it('reflects settings and requires OIDC to be configured', async () => {
    h = await createHarness();
    const { settings } = h.app.hearer;
    settings.set('general', { ...settings.get('general'), appTitle: 'Tunes' });
    settings.set('auth', {
      ...settings.get('auth'),
      jellyfinEnabled: true,
      oidc: { ...settings.get('auth').oidc, enabled: true, buttonLabel: 'Keycloak' },
    });
    let body = (await h.app.inject({ url: '/api/v1/auth/methods' })).json<{
      appTitle: string;
      jellyfin: boolean;
      oidc: { enabled: boolean };
    }>();
    expect(body).toMatchObject({ appTitle: 'Tunes', jellyfin: true, oidc: { enabled: false } });
    settings.set('auth', {
      ...settings.get('auth'),
      oidc: {
        ...settings.get('auth').oidc,
        issuerUrl: 'https://idp.example.test/realm',
        clientId: 'hearer',
      },
    });
    body = (await h.app.inject({ url: '/api/v1/auth/methods' })).json();
    expect(body.oidc).toEqual({ enabled: true, buttonLabel: 'Keycloak' });
  });
});
