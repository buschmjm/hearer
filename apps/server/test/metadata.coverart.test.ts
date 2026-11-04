import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CoverArtError,
  coverArtUrl,
  fetchFrontCover,
  getCoverArtLimiter,
} from '../src/adapters/metadata/coverart.ts';
import { RateLimiter } from '../src/lib/ratelimit.ts';

const MBID = 'b1392450-e666-3926-a536-22c65f834433';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const limiter = new RateLimiter({ intervalMs: 0 });

let server: Server;
let base: string;
let userAgents: (string | undefined)[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    userAgents.push(req.headers['user-agent']);
    const url = req.url ?? '';
    if (url === `/release-group/${MBID}/front-500`) {
      // The real archive redirects to archive.org; the client has to follow.
      res.writeHead(307, { location: '/files/cover.png' }).end();
    } else if (url === '/files/cover.png') {
      res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    } else if (url.startsWith('/release/') && url.endsWith('/front-250')) {
      res.writeHead(200, { 'content-type': 'image/jpeg; charset=binary' }).end(PNG);
    } else if (url.endsWith('/front-1200')) {
      res.writeHead(404).end();
    } else if (url.includes('/html/')) {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
    } else if (url.includes('/big/')) {
      res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.alloc(5000));
    } else if (url.includes('/chunked/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write(Buffer.alloc(3000));
      res.write(Buffer.alloc(3000));
      res.end();
    } else if (url.includes('/slow/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write(PNG); // never finishes
    } else {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe('coverArtUrl', () => {
  it('is deterministic and needs no network', () => {
    expect(coverArtUrl('https://coverartarchive.org', 'release-group', MBID, 250)).toBe(
      `https://coverartarchive.org/release-group/${MBID}/front-250`,
    );
    expect(coverArtUrl('https://c.example/', 'release', MBID, 1200)).toBe(
      `https://c.example/release/${MBID}/front-1200`,
    );
    expect(coverArtUrl('https://c.example', 'release-group', MBID)).toMatch(/front-250$/);
  });

  it('has its own limiter, separate from the MusicBrainz one', () => {
    expect(getCoverArtLimiter()).toBe(getCoverArtLimiter());
    expect(getCoverArtLimiter().intervalMs).toBeGreaterThan(0);
    expect(getCoverArtLimiter().intervalMs).toBeLessThan(1000);
  });
});

describe('fetchFrontCover', () => {
  it('follows redirects and returns the bytes with the content type', async () => {
    userAgents = [];
    const cover = await fetchFrontCover(MBID, 500, { baseUrl: base, limiter, version: '9.9.9' });
    expect(cover?.contentType).toBe('image/png');
    expect(cover?.data.equals(PNG)).toBe(true);
    expect(userAgents[0]).toBe('Hearer/9.9.9 ( https://github.com/buschmjm/hearer )');
  });

  it('strips content-type parameters and supports release covers', async () => {
    const cover = await fetchFrontCover(MBID, 250, { baseUrl: base, limiter, entity: 'release' });
    expect(cover?.contentType).toBe('image/jpeg');
  });

  it('returns null when there is no cover', async () => {
    await expect(fetchFrontCover(MBID, 1200, { baseUrl: base, limiter })).resolves.toBeNull();
  });

  it('rejects other content types', async () => {
    await expect(
      fetchFrontCover('html', 250, { baseUrl: `${base}/html`, limiter }),
    ).rejects.toThrow(/content type/);
  });

  it('enforces the size limit, declared and streamed', async () => {
    await expect(
      fetchFrontCover('x', 250, { baseUrl: `${base}/big`, limiter, maxBytes: 1000 }),
    ).rejects.toThrow(/too large/);
    await expect(
      fetchFrontCover('x', 250, { baseUrl: `${base}/chunked`, limiter, maxBytes: 5000 }),
    ).rejects.toThrow(/too large/);
  });

  it('times out on a stalled download', async () => {
    await expect(
      fetchFrontCover('x', 250, { baseUrl: `${base}/slow`, limiter, timeoutMs: 150 }),
    ).rejects.toBeInstanceOf(CoverArtError);
  });

  it('reports server errors and network failures as CoverArtError', async () => {
    await expect(fetchFrontCover('x', 250, { baseUrl: base, limiter })).rejects.toThrow(/500/);
    await expect(
      fetchFrontCover('x', 250, { baseUrl: 'http://127.0.0.1:1', limiter }),
    ).rejects.toBeInstanceOf(CoverArtError);
  });

  it('goes through its limiter and honours abort', async () => {
    const slow = new RateLimiter({ intervalMs: 60_000 });
    await slow.acquire();
    await expect(
      fetchFrontCover(MBID, 500, { baseUrl: base, limiter: slow, signal: AbortSignal.timeout(50) }),
    ).rejects.toThrow();
  });
});
