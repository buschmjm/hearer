import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

describe('GET /api/v1/health', () => {
  beforeEach(async () => {
    app = await buildApp(config, { version: '1.2.3' });
  });

  it('returns status, version and uptime', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json<{
      status: string;
      version: string;
      uptimeSeconds: number;
      checks: object;
    }>();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('1.2.3');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.checks).toEqual({ db: { status: 'ok' } });
  });

  it('generates a request id and honors an incoming one', async () => {
    const generated = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const echoed = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(echoed.headers['x-request-id']).toBe('abc-123');
  });
});

describe('health checks', () => {
  it('reports degraded when a check fails or throws', async () => {
    app = await buildApp(config, {
      healthChecks: {
        db: () => ({ status: 'ok' }),
        library: () => {
          throw new Error('not mounted');
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'degraded',
      checks: { db: { status: 'ok' }, library: { status: 'error', message: 'not mounted' } },
    });
  });
});

describe('db health check', () => {
  it('is ok with a working database and exposes the shared services', async () => {
    app = await buildApp(config);
    expect(app.hearer.settings.get('general').appTitle).toBe('Hearer');
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.json()).toMatchObject({ status: 'ok', checks: { db: { status: 'ok' } } });
  });

  it('reports degraded when the database is closed', async () => {
    const database = openDatabase(':memory:');
    runMigrations(database.db);
    app = await buildApp(config, { db: database });
    database.close();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      status: string;
      checks: { db: { status: string; message: string } };
    }>();
    expect(body.status).toBe('degraded');
    expect(body.checks.db.status).toBe('error');
    expect(body.checks.db.message).toMatch(/not open/i);
  });

  it('does not close a database it was given', async () => {
    const database = openDatabase(':memory:');
    runMigrations(database.db);
    app = await buildApp(config, { db: database });
    await app.close();
    expect(database.sqlite.open).toBe(true);
    database.close();
    app = await buildApp(config);
  });
});

describe('OpenAPI and errors', () => {
  beforeEach(async () => {
    app = await buildApp(config);
  });

  it('serves an OpenAPI 3 document containing the health path', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.paths['/api/v1/health']).toBeDefined();
    expect(doc.paths['/api/v1/openapi.json']).toBeUndefined();
  });

  it('returns a JSON 404 for unknown API routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'not_found', message: 'Route GET /api/v1/nope not found' },
    });
  });

  it('returns a JSON 404 for wrong methods on known routes', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/health' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('maps zod validation failures to 400 with details', async () => {
    await app.close();
    app = await buildApp(config, {
      routes: [
        (instance, _options, done) => {
          instance.post(
            '/echo',
            {
              schema: {
                body: z.object({ name: z.string().min(1) }),
                response: { 200: z.object({ name: z.string() }) },
              },
            },
            (request) => request.body,
          );
          instance.get('/boom', () => {
            throw new Error('secret internals');
          });
          done();
        },
      ],
    });
    const bad = await app.inject({ method: 'POST', url: '/api/v1/echo', payload: { name: 5 } });
    expect(bad.statusCode).toBe(400);
    const body = bad.json<{ error: { code: string; message: string; details: unknown[] } }>();
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details.length).toBeGreaterThan(0);

    const ok = await app.inject({ method: 'POST', url: '/api/v1/echo', payload: { name: 'x' } });
    expect(ok.json()).toEqual({ name: 'x' });
  });

  it('hides internal error messages on 500', async () => {
    await app.close();
    app = await buildApp(config, {
      routes: [
        (instance, _options, done) => {
          instance.get('/boom', () => {
            throw new Error('secret internals');
          });
          done();
        },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  });
});
