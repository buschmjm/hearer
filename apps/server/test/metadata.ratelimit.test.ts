import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MUSICBRAINZ_INTERVAL_MS,
  RateLimiter,
  getMusicBrainzLimiter,
  parseRetryAfter,
} from '../src/lib/ratelimit.ts';
import { nth } from './helpers/mbServer.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RateLimiter', () => {
  it('releases concurrent callers at most once per interval, in FIFO order', async () => {
    const limiter = new RateLimiter({ intervalMs: 1000 });
    const started: { id: number; at: number }[] = [];
    const calls = [0, 1, 2, 3, 4].map((id) =>
      limiter.run(() => {
        started.push({ id, at: Date.now() });
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(calls);

    expect(started.map((s) => s.id)).toEqual([0, 1, 2, 3, 4]);
    for (let i = 1; i < started.length; i++) {
      expect(nth(started, i).at - nth(started, i - 1).at).toBeGreaterThanOrEqual(1000);
    }
    expect(nth(started, 4).at - nth(started, 0).at).toBe(4000);
  });

  it('serves a caller immediately when the bucket has been idle', async () => {
    const limiter = new RateLimiter({ intervalMs: 1000 });
    await limiter.acquire();
    await vi.advanceTimersByTimeAsync(5000);
    const before = Date.now();
    await limiter.acquire();
    expect(Date.now()).toBe(before);
  });

  it('spaces callers that arrive later too', async () => {
    const limiter = new RateLimiter({ intervalMs: 1000 });
    const times: number[] = [];
    const take = () => limiter.run(() => times.push(Date.now()));
    void take();
    await vi.advanceTimersByTimeAsync(300);
    const second = take();
    const third = take();
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([second, third]);
    expect(nth(times, 1) - nth(times, 0)).toBe(1000);
    expect(nth(times, 2) - nth(times, 1)).toBe(1000);
  });

  it('rejects a waiter whose signal aborts and keeps the queue moving', async () => {
    const limiter = new RateLimiter({ intervalMs: 1000 });
    await limiter.acquire();
    const controller = new AbortController();
    const aborted = limiter.acquire(controller.signal);
    const survivor = limiter.acquire();
    const assertion = expect(aborted).rejects.toThrow(/abort/i);
    expect(limiter.pending).toBe(2);
    controller.abort();
    await assertion;
    expect(limiter.pending).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await survivor;
    expect(limiter.pending).toBe(0);
  });

  it('rejects immediately for an already aborted signal', async () => {
    const limiter = new RateLimiter({ intervalMs: 1000 });
    await expect(limiter.acquire(AbortSignal.abort())).rejects.toThrow();
    expect(limiter.pending).toBe(0);
  });

  it('penalize delays every later caller, including ones already queued', async () => {
    const limiter = new RateLimiter({ intervalMs: 1000 });
    await limiter.acquire();
    const times: number[] = [];
    const start = Date.now();
    const next = limiter.run(() => times.push(Date.now() - start));
    limiter.penalize(5000);
    await vi.advanceTimersByTimeAsync(10_000);
    await next;
    expect(times).toEqual([5000]);
  });

  it('never moves the schedule earlier when penalized with less than is pending', async () => {
    const limiter = new RateLimiter({ intervalMs: 1000 });
    await limiter.acquire();
    limiter.penalize(10);
    const start = Date.now();
    const next = limiter.run(() => Date.now() - start);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await next).toBe(1000);
  });

  it('rejects a negative or non-finite interval', () => {
    expect(() => new RateLimiter({ intervalMs: -1 })).toThrow(RangeError);
    expect(() => new RateLimiter({ intervalMs: Number.NaN })).toThrow(RangeError);
  });

  it('accepts an injected clock', async () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ intervalMs: 1000, now: () => now });
    await limiter.acquire();
    now += 1000;
    await limiter.acquire(); // due immediately under the injected clock
  });
});

describe('the MusicBrainz limiter', () => {
  it('is a process-wide singleton at 1 request per second', () => {
    expect(getMusicBrainzLimiter()).toBe(getMusicBrainzLimiter());
    expect(getMusicBrainzLimiter().intervalMs).toBe(MUSICBRAINZ_INTERVAL_MS);
    expect(MUSICBRAINZ_INTERVAL_MS).toBe(1000);
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('7')).toBe(7000);
    expect(parseRetryAfter('0')).toBe(0);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:00:00 GMT', now)).toBe(0);
  });

  it('returns null for missing or unusable values', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});
