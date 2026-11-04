import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AcoustIdClient,
  AcoustIdError,
  ACOUSTID_INTERVAL_MS,
  mapAcoustIdResults,
} from '../src/adapters/metadata/acoustid.ts';
import { RateLimiter } from '../src/lib/ratelimit.ts';
import { AcoustIdMock, acoustIdOk } from './helpers/acoustIdServer.ts';
import { IDS } from './helpers/mbServer.ts';

let mock: AcoustIdMock;
let metadata: { acoustIdApiKey: string; acoustIdBaseUrl: string };
const info = vi.fn();

const client = (limiter = new RateLimiter({ intervalMs: 0 })) =>
  new AcoustIdClient({
    settings: { get: () => metadata } as never,
    logger: { info },
    version: '9.9.9',
    limiter,
  });

beforeAll(async () => {
  mock = await AcoustIdMock.start();
});
afterAll(async () => {
  await mock.stop();
});
beforeEach(() => {
  mock.requests.length = 0;
  mock.respond = () => ({ body: acoustIdOk([{ id: IDS.recording, rg: IDS.releaseGroup }]) });
  metadata = { acoustIdApiKey: 'secret-key', acoustIdBaseUrl: mock.baseUrl };
  info.mockClear();
});

describe('AcoustID lookup', () => {
  it('posts a form with the key, rounded duration, fingerprint and meta, with our User-Agent', async () => {
    const result = await client().lookup('AQAAfingerprint', 383.6);
    expect(mock.requests).toHaveLength(1);
    const [request] = mock.requests;
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe('/v2/lookup');
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(request?.headers['user-agent']).toBe(
      'Hearer/9.9.9 ( https://github.com/buschmjm/hearer )',
    );
    expect(Object.fromEntries(request?.params ?? [])).toEqual({
      client: 'secret-key',
      duration: '384',
      fingerprint: 'AQAAfingerprint',
      meta: 'recordings releasegroups releases tracks compress',
      format: 'json',
    });
    expect(result.status).toBe('ok');
  });

  it('maps recordings, scores, release groups and the track position', async () => {
    const result = await client().lookup('fp', 100);
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.recordings).toHaveLength(1);
    const [rec] = result.recordings;
    expect(rec).toMatchObject({
      mbid: IDS.recording,
      acoustId: 'acoustid-track-1',
      score: 0.98,
      title: 'Paranoid Android',
      durationMs: 384_000,
      artists: [{ name: 'Radiohead' }],
    });
    expect(rec?.releaseGroups[0]).toMatchObject({ mbid: IDS.releaseGroup, type: 'Album' });
    expect(rec?.releaseGroups[0]?.releases[0]).toMatchObject({
      mbid: IDS.release,
      date: '1997-05-21',
      trackCount: 12,
      position: { discNumber: 1, trackNumber: 2, trackMbid: 't1' },
    });
  });

  it('is disabled without a key: no request, one log line', async () => {
    metadata.acoustIdApiKey = '  ';
    const c = client();
    expect(c.enabled).toBe(false);
    expect(await c.lookup('fp', 10)).toEqual({ status: 'disabled' });
    expect(await c.lookup('fp', 10)).toEqual({ status: 'disabled' });
    expect(mock.requests).toHaveLength(0);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('returns no recordings for an unknown fingerprint', async () => {
    mock.respond = () => ({ body: { status: 'ok', results: [] } });
    expect(await client().lookup('fp', 10)).toEqual({ status: 'ok', recordings: [] });
  });

  it('keeps the best score when a recording is found twice and sorts best first', () => {
    const mapped = mapAcoustIdResults({
      status: 'ok',
      results: [
        { id: 'a', score: 0.5, recordings: [{ id: 'r1' }, { id: 'r2' }] },
        { id: 'b', score: 0.9, recordings: [{ id: 'r1' }] },
      ],
    });
    expect(mapped.map((r) => [r.mbid, r.score, r.acoustId])).toEqual([
      ['r1', 0.9, 'b'],
      ['r2', 0.5, 'a'],
    ]);
  });

  it('classifies the error envelope', async () => {
    const cases: [number, number, AcoustIdError['kind']][] = [
      [400, 4, 'auth'],
      [400, 6, 'auth'],
      [500, 5, 'unavailable'],
      [400, 3, 'bad_request'],
    ];
    for (const [status, code, kind] of cases) {
      mock.respond = () => ({
        status,
        body: { status: 'error', error: { code, message: `boom ${String(code)}` } },
      });
      const err = await client()
        .lookup('fp', 10)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AcoustIdError);
      expect((err as AcoustIdError).kind).toBe(kind);
      expect((err as AcoustIdError).code).toBe(code);
      expect((err as AcoustIdError).message).toContain(`boom ${String(code)}`);
    }
  });

  it('treats 5xx, 429, unreachable servers and garbage as the right kind of failure', async () => {
    mock.respond = () => ({ status: 503, headers: { 'retry-after': '1' }, body: 'busy' });
    const limiter = new RateLimiter({ intervalMs: 0 });
    const penalize = vi.spyOn(limiter, 'penalize');
    await expect(client(limiter).lookup('fp', 10)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(penalize).toHaveBeenCalledWith(1000);

    mock.respond = () => ({ status: 502, body: '<html>bad gateway</html>' });
    await expect(client().lookup('fp', 10)).rejects.toMatchObject({ kind: 'unavailable' });

    mock.respond = () => ({ body: { nonsense: true } });
    await expect(client().lookup('fp', 10)).rejects.toMatchObject({ kind: 'bad_response' });

    metadata.acoustIdBaseUrl = 'http://127.0.0.1:1/v2';
    await expect(client().lookup('fp', 10)).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('reads the key and base URL from settings on every call', async () => {
    const c = client();
    await c.lookup('fp', 10);
    metadata.acoustIdApiKey = 'second-key';
    await c.lookup('fp', 10);
    expect(mock.requests.map((r) => r.params.get('client'))).toEqual(['secret-key', 'second-key']);
  });

  it('spaces requests with its own limiter (at most 3 per second)', async () => {
    expect(ACOUSTID_INTERVAL_MS * 3).toBeGreaterThanOrEqual(1000);
    const c = client(new RateLimiter({ intervalMs: 120 }));
    await Promise.all([c.lookup('a', 10), c.lookup('b', 10), c.lookup('c', 10)]);
    const times = mock.requests.map((r) => r.at);
    expect(times).toHaveLength(3);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(100);
    expect((times[2] ?? 0) - (times[1] ?? 0)).toBeGreaterThanOrEqual(100);
  });

  it('stops waiting for the limiter when aborted', async () => {
    const limiter = new RateLimiter({ intervalMs: 60_000 });
    await limiter.acquire();
    const controller = new AbortController();
    const pending = client(limiter).lookup('fp', 10, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'unavailable' });
    expect(mock.requests).toHaveLength(0);
  });
});
