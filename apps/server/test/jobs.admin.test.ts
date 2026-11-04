import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAINTENANCE_JOB } from '../src/jobs/maintenance.ts';
import { redactPayload } from '../src/routes/jobs.ts';
import {
  ROLES,
  addUser,
  call,
  completeSetup,
  createHarness,
  login,
  type Credentials,
  type Harness,
} from './helpers/auth.ts';

let h: Harness;
let admin: Credentials;

beforeEach(async () => {
  h = await createHarness();
  admin = await completeSetup(h);
});
afterEach(async () => {
  await h.cleanup();
});

/** Insert a job row directly, so tests control status and attempts. */
function seed(
  fields: Partial<{
    type: string;
    status: string;
    attempts: number;
    uniqueKey: string | null;
    payload: unknown;
    lastError: string | null;
  }> = {},
): number {
  const row = h.app.hearer.database.sqlite
    .prepare(
      `insert into jobs (type, status, attempts, max_attempts, unique_key, payload_json, last_error, run_after, locked_by)
       values (@type, @status, @attempts, 5, @uniqueKey, @payload, @lastError, @runAfter, @lockedBy) returning id`,
    )
    .get({
      type: fields.type ?? 'test.job',
      status: fields.status ?? 'queued',
      attempts: fields.attempts ?? 0,
      uniqueKey: fields.uniqueKey ?? null,
      payload: JSON.stringify(fields.payload ?? {}),
      lastError: fields.lastError ?? null,
      runAfter: Date.now() + 3_600_000,
      lockedBy: fields.status === 'running' ? 'w1' : null,
    }) as { id: number };
  return row.id;
}

const getJob = (id: number) =>
  h.app.hearer.database.sqlite.prepare('select * from jobs where id = ?').get(id) as
    | { status: string; attempts: number; locked_by: string | null; finished_at: number | null }
    | undefined;

describe('GET /jobs', () => {
  it('lists newest first with filters and pagination', async () => {
    const ids = [
      seed({ type: 'a.job', status: 'dead' }),
      seed({ type: 'b.job', status: 'queued' }),
      seed({ type: 'a.job', status: 'succeeded' }),
    ];
    const all = await call(h.app, admin, 'GET', '/api/v1/jobs?pageSize=2');
    expect(all.statusCode).toBe(200);
    const body = all.json<{ items: { id: number }[]; total: number; pageSize: number }>();
    expect(body.total).toBe(3);
    expect(body.items.map((j) => j.id)).toEqual([ids[2], ids[1]]);

    const page2 = await call(h.app, admin, 'GET', '/api/v1/jobs?pageSize=2&page=2');
    expect(page2.json<{ items: { id: number }[] }>().items.map((j) => j.id)).toEqual([ids[0]]);

    const dead = await call(h.app, admin, 'GET', '/api/v1/jobs?status=dead');
    expect(dead.json<{ total: number }>().total).toBe(1);
    const typed = await call(h.app, admin, 'GET', '/api/v1/jobs?type=a.job');
    expect(typed.json<{ total: number }>().total).toBe(2);
    const both = await call(h.app, admin, 'GET', '/api/v1/jobs?type=a.job&status=succeeded');
    expect(both.json<{ items: { id: number }[] }>().items.map((j) => j.id)).toEqual([ids[2]]);
  });

  it('rejects an unknown status', async () => {
    const res = await call(h.app, admin, 'GET', '/api/v1/jobs?status=bogus');
    expect(res.statusCode).toBe(400);
  });

  it('never exposes secret-looking payload fields', async () => {
    const id = seed({
      payload: { apiKey: 'sk-live', nested: { password: 'p', note: 'ok' }, list: [{ token: 't' }] },
    });
    const res = await call(h.app, admin, 'GET', `/api/v1/jobs/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('sk-live');
    expect(res.json<{ payload: unknown }>().payload).toEqual({
      apiKey: '[redacted]',
      nested: { password: '[redacted]', note: 'ok' },
      list: [{ token: '[redacted]' }],
    });
    const list = await call(h.app, admin, 'GET', '/api/v1/jobs');
    expect(list.body).not.toContain('sk-live');
  });

  it('redactPayload leaves empty secrets and primitives alone', () => {
    expect(redactPayload({ token: '', n: 1 })).toEqual({ token: '', n: 1 });
    expect(redactPayload('x')).toBe('x');
    expect(redactPayload(null)).toBeNull();
  });
});

describe('GET /jobs/:id', () => {
  it('returns one job and 404s for an unknown id', async () => {
    const id = seed({ lastError: 'Error: boom' });
    const res = await call(h.app, admin, 'GET', `/api/v1/jobs/${id}`);
    expect(res.json<{ id: number; lastError: string }>()).toMatchObject({
      id,
      lastError: 'Error: boom',
    });
    expect((await call(h.app, admin, 'GET', '/api/v1/jobs/99999')).statusCode).toBe(404);
    expect((await call(h.app, admin, 'GET', '/api/v1/jobs/abc')).statusCode).toBe(400);
  });
});

describe('POST /jobs/:id/retry', () => {
  it('requeues a dead job with attempts reset', async () => {
    const id = seed({ status: 'dead', attempts: 5, lastError: 'boom' });
    const res = await call(h.app, admin, 'POST', `/api/v1/jobs/${id}/retry`);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string; attempts: number }>()).toMatchObject({
      status: 'queued',
      attempts: 0,
    });
    expect(getJob(id)).toMatchObject({ status: 'queued', attempts: 0, locked_by: null });
  });

  it('also retries failed jobs', async () => {
    const id = seed({ status: 'failed', attempts: 2 });
    expect((await call(h.app, admin, 'POST', `/api/v1/jobs/${id}/retry`)).statusCode).toBe(200);
  });

  it.each(['queued', 'running', 'succeeded'])('refuses a %s job', async (status) => {
    const id = seed({ status });
    const res = await call(h.app, admin, 'POST', `/api/v1/jobs/${id}/retry`);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('job_not_retryable');
    expect(getJob(id)?.status).toBe(status);
  });

  it('answers 409 when the same unique job is already active', async () => {
    seed({ status: 'queued', uniqueKey: 'schedule:x' });
    const dead = seed({ status: 'dead', uniqueKey: 'schedule:x' });
    const res = await call(h.app, admin, 'POST', `/api/v1/jobs/${dead}/retry`);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('job_already_active');
    expect(getJob(dead)?.status).toBe('dead');
  });

  it('404s for an unknown job', async () => {
    expect((await call(h.app, admin, 'POST', '/api/v1/jobs/4040/retry')).statusCode).toBe(404);
  });
});

describe('DELETE /jobs/:id', () => {
  it('deletes queued and dead jobs only', async () => {
    const queued = seed({ status: 'queued' });
    const dead = seed({ status: 'dead' });
    const running = seed({ status: 'running' });
    const done = seed({ status: 'succeeded' });
    expect((await call(h.app, admin, 'DELETE', `/api/v1/jobs/${queued}`)).statusCode).toBe(204);
    expect((await call(h.app, admin, 'DELETE', `/api/v1/jobs/${dead}`)).statusCode).toBe(204);
    expect(getJob(queued)).toBeUndefined();
    for (const id of [running, done]) {
      const res = await call(h.app, admin, 'DELETE', `/api/v1/jobs/${id}`);
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('job_not_deletable');
      expect(getJob(id)).toBeDefined();
    }
    expect((await call(h.app, admin, 'DELETE', `/api/v1/jobs/${dead}`)).statusCode).toBe(404);
  });
});

describe('GET /jobs/summary', () => {
  it('counts by type and status and lists schedules', async () => {
    seed({ type: 'a.job', status: 'dead' });
    seed({ type: 'a.job', status: 'dead' });
    seed({ type: 'b.job', status: 'queued' });
    const res = await call(h.app, admin, 'GET', '/api/v1/jobs/summary');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      counts: { type: string; status: string; count: number }[];
      totals: Record<string, number>;
      schedules: { key: string; type: string }[];
    }>();
    expect(body.counts).toContainEqual({ type: 'a.job', status: 'dead', count: 2 });
    expect(body.counts).toContainEqual({ type: 'b.job', status: 'queued', count: 1 });
    expect(body.totals).toMatchObject({ dead: 2, queued: 1, running: 0, succeeded: 0 });
    expect(body.schedules.map((s) => s.type)).toContain(MAINTENANCE_JOB);
    expect(body.schedules.every((s) => s.key.startsWith('schedule:'))).toBe(true);
  });
});

describe('permissions', () => {
  it('requires MANAGE_SETTINGS', async () => {
    await addUser(h.app, 'plain', ROLES.user);
    const plain = await login(h.app, 'plain');
    const id = seed({ status: 'dead' });
    for (const [method, url] of [
      ['GET', '/api/v1/jobs'],
      ['GET', '/api/v1/jobs/summary'],
      ['GET', `/api/v1/jobs/${id}`],
      ['POST', `/api/v1/jobs/${id}/retry`],
      ['DELETE', `/api/v1/jobs/${id}`],
    ] as const) {
      expect((await call(h.app, plain, method, url)).statusCode, `${method} ${url}`).toBe(403);
      expect((await call(h.app, undefined, method, url)).statusCode, `${method} ${url}`).toBe(401);
    }
    expect(getJob(id)?.status).toBe('dead');
  });
});
