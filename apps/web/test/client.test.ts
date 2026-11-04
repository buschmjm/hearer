import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, configureApi, getCsrfToken, setCsrfToken } from '../src/api/client.ts';
import { apiError, mockApi } from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
  configureApi({});
  setCsrfToken(null);
});

describe('api client', () => {
  it('adds x-csrf-token to mutating requests only', async () => {
    setCsrfToken('tok-123');
    const { calls } = mockApi({
      'GET /api/v1/thing': { json: { ok: true } },
      'POST /api/v1/thing': { json: { ok: true } },
      'PUT /api/v1/thing': { json: { ok: true } },
      'DELETE /api/v1/thing': { status: 204 },
    });
    await api('/thing');
    await api('/thing', { method: 'POST', body: { a: 1 } });
    await api('/thing', { method: 'PUT', body: {} });
    await api('/thing', { method: 'DELETE' });
    expect(calls.map((c) => [c.method, c.headers['x-csrf-token']])).toEqual([
      ['GET', undefined],
      ['POST', 'tok-123'],
      ['PUT', 'tok-123'],
      ['DELETE', 'tok-123'],
    ]);
    expect(calls[1]?.body).toEqual({ a: 1 });
    expect(calls[1]?.headers['content-type']).toBe('application/json');
  });

  it('sends no csrf header when there is no session token', async () => {
    const { calls } = mockApi({ 'POST /api/v1/auth/login': { json: {} } });
    await api('/auth/login', { method: 'POST', body: {} });
    expect(calls[0]?.headers['x-csrf-token']).toBeUndefined();
  });

  it('uses same-origin credentials and the /api/v1 prefix, with query params', async () => {
    const { fetchMock } = mockApi({ 'GET /api/v1/search': { json: [] } });
    await api('/search', { query: { q: 'a b', skip: undefined, limit: 5 } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/search?q=a+b&limit=5');
    expect(init.credentials).toBe('same-origin');
  });

  it('parses the error envelope into an ApiError', async () => {
    mockApi({
      'POST /api/v1/x': apiError(409, 'setup_admin_exists', 'An administrator already exists'),
    });
    const err = await api('/x', { method: 'POST' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      code: 'setup_admin_exists',
      message: 'An administrator already exists',
    });
  });

  it('exposes validation details as field errors', async () => {
    mockApi({
      'POST /api/v1/x': apiError(400, 'validation_error', 'Request validation failed', [
        { instancePath: '/username', message: 'Too small' },
        { instancePath: '/a/b', message: 'Nested' },
      ]),
    });
    const err = (await api('/x', { method: 'POST' }).catch((e: unknown) => e)) as ApiError;
    expect(err.fieldErrors).toEqual({ username: 'Too small', 'a.b': 'Nested' });
  });

  it('falls back to a generic error for non-JSON failures', async () => {
    mockApi({ 'GET /api/v1/x': new Response('<html>Bad gateway</html>', { status: 502 }) });
    const err = (await api('/x').catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ status: 502, code: 'http_502' });
  });

  it('reports network failures as ApiError status 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = (await api('/x').catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ status: 0, code: 'network_error' });
  });

  it('runs the 401 handler, unless the call opts out', async () => {
    const onUnauthorized = vi.fn();
    configureApi({ onUnauthorized });
    mockApi({ 'GET /api/v1/x': apiError(401, 'unauthorized', 'Sign in') });
    await expect(api('/x')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await expect(api('/x', { redirectOn401: false })).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('runs the setup handler for 503 setup_required only', async () => {
    const onSetupRequired = vi.fn();
    configureApi({ onSetupRequired });
    mockApi({
      'GET /api/v1/a': apiError(503, 'setup_required', 'Setup is not complete'),
      'GET /api/v1/b': apiError(503, 'unavailable', 'Down'),
    });
    await expect(api('/a')).rejects.toMatchObject({ code: 'setup_required' });
    expect(onSetupRequired).toHaveBeenCalledTimes(1);
    await expect(api('/b')).rejects.toMatchObject({ code: 'unavailable' });
    expect(onSetupRequired).toHaveBeenCalledTimes(1);
  });

  it('validates responses with a schema', async () => {
    const { z } = await import('zod');
    mockApi({ 'GET /api/v1/x': { json: { n: 'not a number' } } });
    await expect(api('/x', { schema: z.object({ n: z.number() }) })).rejects.toThrow();
  });

  it('keeps the csrf token in module state', () => {
    setCsrfToken('a');
    expect(getCsrfToken()).toBe('a');
  });
});
