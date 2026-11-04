import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import {
  Permission,
  REDACTED_SECRET,
  notificationEventsToMask,
  type NotificationAgentsResponse,
  type NotificationEvent,
  type NotificationTargetDto,
  type NotificationTestResult,
  type RequestDto,
  type UserNotificationsResponse,
} from '@hearer/shared';
import { eq } from 'drizzle-orm';
import { SMTPServer } from 'smtp-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAgent } from '../src/adapters/notify/registry.ts';
import { PermanentJobError } from '../src/jobs/registry.ts';
import { jobs as jobsTable, notificationTargets, users } from '../src/db/schema.ts';
import {
  NOTIFY_JOB,
  NotificationService,
  notifySendPayload,
  type NotifySendPayload,
} from '../src/services/notifications.ts';
import { ALBUM, FakeMetadata, queuedJobs, runJob } from './helpers/requests.ts';
import {
  addUser,
  call,
  completeSetup,
  createHarness,
  login,
  type Credentials,
  type Harness,
} from './helpers/auth.ts';
import { HttpMock } from './helpers/notify.ts';

let h: Harness;
let admin: Credentials;
let mock: HttpMock;

beforeEach(async () => {
  mock = await new HttpMock().start();
  h = await createHarness({
    deps: { metadata: new FakeMetadata().asProvider(), notifyOptions: { timeoutMs: 2000 } },
  });
  admin = await completeSetup(h);
});
afterEach(async () => {
  await h.cleanup();
  await mock.stop();
});

const api = (
  creds: Credentials | undefined,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
) => call(h.app, creds, method, `/api/v1${url}`, body);
const db = () => h.app.hearer.database.db;
const svc = () => h.app.hearer.notifications;

async function userWith(name: string, permissions: number, email?: string): Promise<Credentials> {
  const id = await addUser(h.app, name, permissions);
  if (email) db().update(users).set({ email }).where(eq(users.id, id)).run();
  return login(h.app, name);
}
const userId = (name: string): string => {
  const row = h.app.hearer.users.getByUsername(name);
  if (!row) throw new Error(`no user ${name}`);
  return row.id;
};

async function addTarget(
  agent: 'webhook' | 'discord' | 'slack' | 'ntfy' | 'smtp',
  config: Record<string, unknown>,
  events: NotificationEvent[] | readonly string[],
  extra: { name?: string; enabled?: boolean } = {},
): Promise<NotificationTargetDto> {
  const res = await api(admin, 'POST', '/notifications/targets', {
    name: extra.name ?? `${agent} target`,
    agent,
    config,
    events,
    enabled: extra.enabled ?? true,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<NotificationTargetDto>();
}
const webhookTarget = (
  events: NotificationEvent[],
  extra: { name?: string; enabled?: boolean } = {},
) => addTarget('webhook', { url: `${mock.url}/hook` }, events, extra);

/** Every notify.send job payload, whatever its state, oldest first. */
function sent(): NotifySendPayload[] {
  return db()
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.type, NOTIFY_JOB))
    .orderBy(jobsTable.id)
    .all()
    .map((row) => notifySendPayload.parse(row.payloadJson));
}
const create = async (creds: Credentials, mbid = ALBUM) =>
  (await api(creds, 'POST', '/requests', { type: 'album', mbid })).json<RequestDto>();

describe('agents endpoint', () => {
  it('lists agents with JSON schemas, secret markers and events', async () => {
    const res = await api(admin, 'GET', '/notifications/agents');
    expect(res.statusCode).toBe(200);
    const body = res.json<NotificationAgentsResponse>();
    expect(body.agents.map((a) => a.id)).toEqual(['webhook', 'discord', 'slack', 'ntfy', 'smtp']);
    const smtp = body.agents.find((a) => a.id === 'smtp');
    const props = smtp?.configSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.pass?.['x-secret']).toBe(true);
    expect(props.host?.['x-secret']).toBeUndefined();
    expect(smtp?.configSchema.required).toEqual(expect.arrayContaining(['host', 'from', 'to']));
    expect(body.agents.find((a) => a.id === 'ntfy')?.defaultConfig).toMatchObject({
      serverUrl: 'https://ntfy.sh',
    });
    expect(body.events.map((e) => e.id)).toContain('request.created');
    expect(body.events.find((e) => e.id === 'test')?.subscribable).toBe(false);
  });
});

describe('target storage and secrets', () => {
  it('encrypts secrets at rest, masks them in the API and keeps them on a masked echo', async () => {
    const created = await addTarget(
      'webhook',
      { url: `${mock.url}/hook`, secret: 'hmac-key', authorization: 'Bearer tok' },
      ['request.created'],
    );
    expect(created.config).toMatchObject({
      url: `${mock.url}/hook`,
      secret: REDACTED_SECRET,
      authorization: REDACTED_SECRET,
    });
    expect(JSON.stringify(created)).not.toContain('hmac-key');

    const raw = db()
      .select()
      .from(notificationTargets)
      .where(eq(notificationTargets.id, created.id))
      .get();
    expect(raw?.configJson.secret).toMatch(/^enc:v1:/);
    expect(raw?.configJson.authorization).toMatch(/^enc:v1:/);
    expect(JSON.stringify(raw)).not.toContain('hmac-key');
    expect(JSON.stringify(raw)).not.toContain('Bearer tok');
    expect(raw?.configJson.url).toBe(`${mock.url}/hook`);

    // List and get are masked too.
    const list = (await api(admin, 'GET', '/notifications/targets')).json<{
      targets: NotificationTargetDto[];
    }>();
    expect(list.targets[0]?.config.secret).toBe(REDACTED_SECRET);
    const one = (
      await api(admin, 'GET', `/notifications/targets/${created.id}`)
    ).json<NotificationTargetDto>();
    expect(one.config.authorization).toBe(REDACTED_SECRET);

    // Echoing the masked values back (the UI does) keeps the stored secrets.
    const put = await api(admin, 'PUT', `/notifications/targets/${created.id}`, {
      name: 'renamed',
      agent: 'webhook',
      config: one.config,
      events: ['request.created', 'request.approved'],
      enabled: true,
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json<NotificationTargetDto>()).toMatchObject({
      name: 'renamed',
      events: ['request.created', 'request.approved'],
    });
    const after = db()
      .select()
      .from(notificationTargets)
      .where(eq(notificationTargets.id, created.id))
      .get();
    expect(after?.configJson.secret).toMatch(/^enc:v1:/);
    expect(after?.events).toBe(notificationEventsToMask(['request.created', 'request.approved']));
    // The real secret still signs deliveries.
    svc().handleEvent('upload.failed', { uploadId: 'u1', uploaderId: userId('admin') });
    expect(sent()).toHaveLength(0); // not subscribed to upload.failed
    await svc().deliver({
      event: 'test',
      message: svc().testMessage(getAgent('webhook')),
      targetId: created.id,
    });
    const req = mock.requests[0];
    expect(req?.headers['x-hearer-signature']).toBe(
      `sha256=${createHmac('sha256', 'hmac-key')
        .update(req?.raw ?? '')
        .digest('hex')}`,
    );
    expect(req?.headers.authorization).toBe('Bearer tok');
  });

  it('a new secret replaces the old one and an empty string clears it', async () => {
    const created = await addTarget('webhook', { url: mock.url, secret: 'one' }, []);
    const base = { name: 'w', agent: 'webhook', events: [], enabled: true };
    await api(admin, 'PUT', `/notifications/targets/${created.id}`, {
      ...base,
      config: { url: mock.url, secret: 'two' },
    });
    await svc().deliver({
      event: 'test',
      message: svc().testMessage(getAgent('webhook')),
      targetId: created.id,
    });
    expect(mock.requests[0]?.headers['x-hearer-signature']).toBe(
      `sha256=${createHmac('sha256', 'two')
        .update(mock.requests[0]?.raw ?? '')
        .digest('hex')}`,
    );
    const cleared = await api(admin, 'PUT', `/notifications/targets/${created.id}`, {
      ...base,
      config: { url: mock.url, secret: '' },
    });
    expect(cleared.json<NotificationTargetDto>().config.secret).toBe('');
    const raw = db()
      .select()
      .from(notificationTargets)
      .where(eq(notificationTargets.id, created.id))
      .get();
    expect(raw?.configJson.secret).toBe('');
  });

  it('validates config, name, events and agent; rejects an agent change', async () => {
    const bad = await api(admin, 'POST', '/notifications/targets', {
      name: 'x',
      agent: 'discord',
      config: { webhookUrl: 'nope' },
      events: [],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: { code: string } }>().error.code).toBe('validation_error');
    expect(
      (
        await api(admin, 'POST', '/notifications/targets', {
          name: '',
          agent: 'webhook',
          config: { url: mock.url },
          events: [],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api(admin, 'POST', '/notifications/targets', {
          name: 'a',
          agent: 'webhook',
          config: { url: mock.url },
          events: ['test'],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api(admin, 'POST', '/notifications/targets', {
          name: 'a',
          agent: 'carrier-pigeon',
          config: {},
          events: [],
        })
      ).statusCode,
    ).toBe(400);
    const created = await webhookTarget([]);
    const change = await api(admin, 'PUT', `/notifications/targets/${created.id}`, {
      name: 'a',
      agent: 'slack',
      config: { webhookUrl: `${mock.url}/s` },
      events: [],
      enabled: true,
    });
    expect(change.statusCode).toBe(400);
    expect(change.json<{ error: { code: string } }>().error.code).toBe('agent_immutable');
  });

  it('fills defaults for omitted config fields', async () => {
    const created = await addTarget('ntfy', { topic: 'abc' }, []);
    expect(created.config).toMatchObject({
      serverUrl: 'https://ntfy.sh',
      topic: 'abc',
      priority: 3,
      token: '',
      password: '',
    });
  });

  it('deletes targets; unknown ids are 404', async () => {
    const created = await webhookTarget([]);
    expect((await api(admin, 'DELETE', `/notifications/targets/${created.id}`)).statusCode).toBe(
      204,
    );
    expect((await api(admin, 'GET', `/notifications/targets/${created.id}`)).statusCode).toBe(404);
    expect((await api(admin, 'DELETE', `/notifications/targets/${created.id}`)).statusCode).toBe(
      404,
    );
    expect(
      (
        await api(admin, 'PUT', '/notifications/targets/nope', {
          name: 'a',
          agent: 'webhook',
          config: { url: mock.url },
          events: [],
        })
      ).statusCode,
    ).toBe(404);
    expect((await api(admin, 'POST', '/notifications/targets/nope/test')).statusCode).toBe(404);
  });

  it('a secret that can no longer be decrypted is blanked, not fatal', async () => {
    const created = await addTarget('webhook', { url: mock.url, secret: 'k' }, []);
    db()
      .update(notificationTargets)
      .set({
        configJson: {
          url: mock.url,
          secret: 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
      })
      .where(eq(notificationTargets.id, created.id))
      .run();
    const got = await api(admin, 'GET', `/notifications/targets/${created.id}`);
    expect(got.statusCode).toBe(200);
    expect(got.json<NotificationTargetDto>().config.secret).toBe('');
  });
});

describe('permissions', () => {
  it('target and agent routes need MANAGE_SETTINGS; own preferences need only a session', async () => {
    const plain = await userWith('plain', Permission.REQUEST);
    const manager = await userWith('mgr', Permission.MANAGE_SETTINGS);
    const created = await webhookTarget([]);
    const adminRoutes: ['GET' | 'POST' | 'PUT' | 'DELETE', string][] = [
      ['GET', '/notifications/agents'],
      ['GET', '/notifications/targets'],
      ['POST', '/notifications/targets'],
      ['GET', `/notifications/targets/${created.id}`],
      ['PUT', `/notifications/targets/${created.id}`],
      ['DELETE', `/notifications/targets/${created.id}`],
      ['POST', `/notifications/targets/${created.id}/test`],
      ['POST', '/notifications/test'],
    ];
    for (const [method, url] of adminRoutes) {
      expect((await api(undefined, method, url, {})).statusCode, `anon ${method} ${url}`).toBe(401);
      expect((await api(plain, method, url, {})).statusCode, `plain ${method} ${url}`).toBe(403);
    }
    expect((await api(manager, 'GET', '/notifications/targets')).statusCode).toBe(200);
    expect((await api(plain, 'GET', '/auth/me/notifications')).statusCode).toBe(200);
    expect((await api(undefined, 'GET', '/auth/me/notifications')).statusCode).toBe(401);
    expect((await api(undefined, 'PUT', '/auth/me/notifications', {})).statusCode).toBe(401);
  });
});

describe('test endpoints', () => {
  it('sends a test message to a saved target and reports delivery failures as ok:false', async () => {
    const created = await webhookTarget([]);
    const ok = await api(admin, 'POST', `/notifications/targets/${created.id}/test`);
    expect(ok.json<NotificationTestResult>()).toEqual({ ok: true });
    expect(mock.requests[0]?.json).toMatchObject({
      event: 'test',
      message: { title: 'Test notification' },
    });
    mock.statuses = [500];
    const failed = await api(admin, 'POST', `/notifications/targets/${created.id}/test`);
    expect(failed.statusCode).toBe(200);
    expect(failed.json<NotificationTestResult>()).toMatchObject({
      ok: false,
      message: expect.stringContaining('HTTP 500') as string,
    });
  });

  it('tests an unsaved candidate; masked secrets resolve against targetId', async () => {
    const res = await api(admin, 'POST', '/notifications/test', {
      agent: 'webhook',
      config: { url: `${mock.url}/candidate`, secret: 'abc' },
    });
    expect(res.json<NotificationTestResult>().ok).toBe(true);
    expect(mock.requests[0]?.path).toBe('/candidate');
    expect(mock.requests[0]?.headers['x-hearer-signature']).toBeDefined();
    // Nothing was saved.
    expect(
      (await api(admin, 'GET', '/notifications/targets')).json<{ targets: unknown[] }>().targets,
    ).toEqual([]);

    const saved = await addTarget('webhook', { url: mock.url, secret: 'stored' }, []);
    mock.requests = [];
    const echo = await api(admin, 'POST', '/notifications/test', {
      agent: 'webhook',
      config: { url: mock.url, secret: REDACTED_SECRET },
      targetId: saved.id,
    });
    expect(echo.json<NotificationTestResult>().ok).toBe(true);
    expect(mock.requests[0]?.headers['x-hearer-signature']).toBe(
      `sha256=${createHmac('sha256', 'stored')
        .update(mock.requests[0]?.raw ?? '')
        .digest('hex')}`,
    );
  });

  it('an invalid candidate is 400; a wrong targetId is 404; an unreachable one is ok:false', async () => {
    expect(
      (
        await api(admin, 'POST', '/notifications/test', {
          agent: 'slack',
          config: { webhookUrl: 'x' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api(admin, 'POST', '/notifications/test', {
          agent: 'webhook',
          config: { url: mock.url },
          targetId: 'zzz',
        })
      ).statusCode,
    ).toBe(404);
    const dead = await new HttpMock().start();
    const url = dead.url;
    await dead.stop();
    const res = await api(admin, 'POST', '/notifications/test', {
      agent: 'webhook',
      config: { url },
    });
    expect(res.json<NotificationTestResult>().ok).toBe(false);
  });
});

describe('event fan-out', () => {
  it('queues one job per enabled target subscribed to the event, by bitmask', async () => {
    await webhookTarget(['request.created'], { name: 'creations' });
    await webhookTarget(['request.approved', 'upload.imported'], { name: 'approvals' });
    await webhookTarget(['request.created', 'request.approved'], { name: 'both' });
    await webhookTarget(['request.created'], { name: 'off', enabled: false });
    await webhookTarget([], { name: 'nothing' });
    const user = await userWith('u', Permission.REQUEST_ALBUM);
    const request = await create(user);
    const names = (payloads: NotifySendPayload[]) =>
      payloads
        .map(
          (p) =>
            db()
              .select()
              .from(notificationTargets)
              .where(eq(notificationTargets.id, p.targetId ?? ''))
              .get()?.name,
        )
        .sort();
    expect(sent().every((p) => p.event === 'request.created')).toBe(true);
    expect(names(sent())).toEqual(['both', 'creations']);

    await api(admin, 'POST', `/requests/${request.id}/approve`);
    const approvals = sent().filter((p) => p.event === 'request.approved');
    expect(names(approvals)).toEqual(['approvals', 'both']);

    h.app.hearer.events.emit('upload.imported', { uploadId: 'up1', uploaderId: userId('u') });
    expect(names(sent().filter((p) => p.event === 'upload.imported'))).toEqual(['approvals']);
    // Nothing for events nobody subscribed to.
    h.app.hearer.events.emit('upload.failed', { uploadId: 'up2', uploaderId: userId('u') });
    expect(sent().filter((p) => p.event === 'upload.failed')).toEqual([]);
    // Cancelled requests are not notified.
    await api(user, 'POST', `/requests/${request.id}/cancel`);
    expect(sent().some((p) => p.message.data.to === 'CANCELLED')).toBe(false);
  });

  it('a target disabled after queuing is skipped at delivery', async () => {
    const target = await webhookTarget(['upload.imported']);
    h.app.hearer.events.emit('upload.imported', { uploadId: 'up1', uploaderId: userId('admin') });
    expect(queuedJobs(h.app, NOTIFY_JOB)).toHaveLength(1);
    await api(admin, 'PUT', `/notifications/targets/${target.id}`, {
      name: 'x',
      agent: 'webhook',
      config: { url: mock.url },
      events: ['upload.imported'],
      enabled: false,
    });
    await runJob(h.app, NOTIFY_JOB, sent()[0]);
    expect(mock.requests).toHaveLength(0);
    // A deleted target is dropped quietly too.
    await api(admin, 'DELETE', `/notifications/targets/${target.id}`);
    await runJob(h.app, NOTIFY_JOB, sent()[0]);
    expect(mock.requests).toHaveLength(0);
  });

  it('snapshots the rendered message: deep link, cover, fields, actor, subject', async () => {
    h.app.hearer.settings.set('general', {
      ...h.app.hearer.settings.get('general'),
      applicationUrl: 'https://hearer.example/',
      appTitle: 'Tunes',
    });
    await webhookTarget(['request.declined']);
    const user = await userWith('alice', Permission.REQUEST_ALBUM);
    const request = await create(user);
    await api(admin, 'POST', `/requests/${request.id}/decline`, { reason: 'Already own it' });
    const [payload] = sent();
    expect(payload?.message).toMatchObject({
      event: 'request.declined',
      title: 'Request declined',
      url: `https://hearer.example/requests/${request.id}`,
      appTitle: 'Tunes',
      actor: 'admin',
      subject: { kind: 'request', id: request.id, type: 'album', status: 'DECLINED' },
    });
    expect(payload?.message.body).toContain('was declined');
    expect(payload?.message.fields).toEqual(
      expect.arrayContaining([
        { name: 'Requested by', value: 'alice' },
        { name: 'Reason', value: 'Already own it' },
      ]),
    );
    expect(payload?.message.data).toMatchObject({
      requestId: request.id,
      declineReason: 'Already own it',
    });
    expect(payload?.message.imageUrl).not.toBeUndefined();
  });

  it('has no link when the application URL is not set', async () => {
    await webhookTarget(['upload.needs_review']);
    h.app.hearer.events.emit('upload.needs_review', {
      uploadId: 'u-1',
      uploaderId: userId('admin'),
      originalName: 'a.flac',
      title: 'Song',
      artist: 'Band',
      score: 0.92,
    });
    const [payload] = sent();
    expect(payload?.message.url).toBeNull();
    expect(payload?.message).toMatchObject({
      title: 'Upload needs review',
      subject: { kind: 'upload', id: 'u-1', title: 'Song', artist: 'Band' },
    });
    expect(payload?.message.fields).toEqual(
      expect.arrayContaining([
        { name: 'File', value: 'a.flac' },
        { name: 'Match confidence', value: '92%' },
      ]),
    );
  });

  it('an auto-approved request is announced by its approval, not as awaiting approval', async () => {
    await webhookTarget(['request.created', 'request.approved']);
    const auto = await userWith('auto', Permission.REQUEST_ALBUM | Permission.AUTO_APPROVE);
    await create(auto);
    expect(sent().map((p) => p.event)).toEqual(['request.approved']);
  });
});

describe('delivery jobs', () => {
  it('delivers a queued job to the webhook and retries/gives up per error class', async () => {
    await webhookTarget(['upload.imported']);
    h.app.hearer.events.emit('upload.imported', { uploadId: 'u1', uploaderId: userId('admin') });
    const payload = sent()[0];
    expect(h.app.hearer.jobs.registry.get(NOTIFY_JOB)?.maxAttempts).toBe(5);
    await runJob(h.app, NOTIFY_JOB, payload);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.json).toMatchObject({ event: 'upload.imported' });

    mock.statuses = [503];
    const retry = await runJob(h.app, NOTIFY_JOB, payload).catch((e: unknown) => e);
    expect(retry).toBeInstanceOf(Error);
    expect(retry).not.toBeInstanceOf(PermanentJobError);
    mock.statuses = [404];
    await expect(runJob(h.app, NOTIFY_JOB, payload)).rejects.toBeInstanceOf(PermanentJobError);
    // The snapshot is stable: every attempt sent the identical body.
    expect(new Set(mock.requests.map((r) => r.raw)).size).toBe(1);
  });

  it('the runner retries a 5xx with backoff and records last_error; a 4xx is dead at once', async () => {
    await webhookTarget(['upload.imported']);
    mock.statuses = [500];
    h.app.hearer.events.emit('upload.imported', { uploadId: 'u1', uploaderId: userId('admin') });
    h.app.hearer.jobs.start();
    await waitFor(() => rowOf()?.attempts === 1 && rowOf()?.status === 'queued');
    expect(rowOf()?.lastError).toMatch(/Webhook: HTTP 500/);
    expect(rowOf()?.maxAttempts).toBe(5);

    mock.statuses = [404];
    h.app.hearer.events.emit('upload.imported', { uploadId: 'u2', uploaderId: userId('admin') });
    await waitFor(() => allRows().some((r) => r.status === 'dead'));
    const dead = allRows().find((r) => r.status === 'dead');
    expect(dead?.attempts).toBe(1);
    expect(dead?.lastError).toMatch(/HTTP 404/);
  });

  it('acceptance #4: a non-auto-approve user creates a request and the webhook receives request.created', async () => {
    await webhookTarget(['request.created', 'request.approved', 'request.available']);
    h.app.hearer.jobs.start();
    const user = await userWith('listener', Permission.REQUEST_ALBUM);
    const request = await create(user);
    expect(request.status).toBe('PENDING');
    await waitFor(() => mock.requests.length >= 1);
    const received = mock.requests[0]?.json as {
      event: string;
      message: { title: string; subject: { id: string; title: string }; fields: unknown[] };
      data: Record<string, unknown>;
    };
    expect(received.event).toBe('request.created');
    expect(received.message.title).toBe('New request awaiting approval');
    expect(received.message.subject.id).toBe(request.id);
    expect(received.data).toMatchObject({
      requestId: request.id,
      type: 'album',
      status: 'PENDING',
      mbid: ALBUM,
    });
    expect(mock.requests).toHaveLength(1);
  });
});

describe('the bus is never blocked by notifications', () => {
  it('a broken target, a failing queue and a dead destination do not affect the emitting flow', async () => {
    await webhookTarget(['request.created', 'request.approved']);
    // A row that cannot even be parsed as a config, subscribed to everything.
    db()
      .insert(notificationTargets)
      .values({
        name: 'broken',
        agent: 'discord',
        configJson: { webhookUrl: 5 },
        events: 2 ** 11 - 1,
        enabled: true,
      })
      .run();
    const user = await userWith('u', Permission.REQUEST_ALBUM);
    const request = await create(user);
    expect(request.status).toBe('PENDING');
    const approve = await api(admin, 'POST', `/requests/${request.id}/approve`);
    expect(approve.statusCode).toBe(200);

    // The queue itself failing is logged, not thrown into the request flow.
    const jobs = h.app.hearer.jobs;
    const original = jobs.enqueue.bind(jobs);
    jobs.enqueue = () => {
      throw new Error('queue is down');
    };
    expect(() => {
      h.app.hearer.events.emit('upload.failed', { uploadId: 'x', uploaderId: userId('u') });
    }).not.toThrow();
    const req2 = await api(user, 'POST', '/requests', { type: 'album', mbid: ALBUM });
    expect([201, 409]).toContain(req2.statusCode);
    jobs.enqueue = original;
  });

  it('events for vanished rows and malformed payloads are ignored', () => {
    expect(() => {
      svc().handleEvent('request.approved', { requestId: 'gone' } as never);
      svc().handleEvent('upload.imported', {} as never);
      svc().handleEvent('request.cancelled', { requestId: 'x' } as never);
    }).not.toThrow();
  });
});

describe('per-user notifications', () => {
  let smtp: SMTPServer;
  let port = 0;
  let mails: { to: string[]; data: string }[] = [];

  beforeEach(async () => {
    mails = [];
    smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS', 'AUTH'],
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          mails.push({
            to: session.envelope.rcptTo.map((r) => r.address),
            data: Buffer.concat(chunks).toString('utf8'),
          });
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
    port = (smtp.server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      smtp.close(() => {
        resolve();
      });
    });
  });

  const smtpTarget = (userEmail: boolean, enabled = true) =>
    addTarget(
      'smtp',
      { host: '127.0.0.1', port, from: 'hearer@example.com', to: 'admin@example.com', userEmail },
      ['request.created'],
      { enabled },
    );
  const setPrefs = (creds: Credentials, prefs: unknown) =>
    api(creds, 'PUT', '/auth/me/notifications', prefs);

  it('reads defaults and stores a validated shape; reports availability and why not', async () => {
    const alice = await userWith('alice', Permission.REQUEST_ALBUM, 'alice@example.com');
    const noMail = await userWith('nomail', Permission.REQUEST_ALBUM);
    const first = (
      await api(alice, 'GET', '/auth/me/notifications')
    ).json<UserNotificationsResponse>();
    expect(first.prefs).toEqual({});
    expect(first.email).toMatchObject({ available: false, address: 'alice@example.com' });
    expect(first.email.reason).toMatch(/administrator/);
    expect(first.ntfy).toEqual({ available: true, server: 'https://ntfy.sh' });
    expect(first.events.map((e) => e.id)).not.toContain('test');

    await smtpTarget(true);
    const second = (
      await api(alice, 'GET', '/auth/me/notifications')
    ).json<UserNotificationsResponse>();
    expect(second.email).toMatchObject({ available: true, reason: null });
    const third = (
      await api(noMail, 'GET', '/auth/me/notifications')
    ).json<UserNotificationsResponse>();
    expect(third.email).toMatchObject({
      available: false,
      reason: 'Your account has no email address.',
    });

    const saved = await setPrefs(alice, {
      email: { enabled: true, events: ['request.available'] },
      ntfy: { topic: 'alice-music', events: ['request.approved'] },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<UserNotificationsResponse>().prefs).toEqual({
      email: { enabled: true, events: ['request.available'] },
      ntfy: { topic: 'alice-music', events: ['request.approved'] },
    });
    expect(
      (await api(alice, 'GET', '/auth/me/notifications')).json<UserNotificationsResponse>().prefs
        .ntfy?.topic,
    ).toBe('alice-music');
    // Invalid shapes are refused.
    expect((await setPrefs(alice, { ntfy: { topic: 'bad topic!', events: [] } })).statusCode).toBe(
      400,
    );
    expect((await setPrefs(alice, { email: { enabled: true, events: ['test'] } })).statusCode).toBe(
      400,
    );
    // Other people's prefs are untouched.
    expect(
      db()
        .select()
        .from(users)
        .where(eq(users.id, userId('nomail')))
        .get()?.notifyPrefs,
    ).toBeNull();
  });

  it('sends opted-in users email for their own requests only, via the designated SMTP target', async () => {
    const designated = await smtpTarget(true);
    await smtpTarget(false); // an admin-only SMTP target must never be used for users
    const alice = await userWith('alice', Permission.REQUEST_ALBUM, 'alice@example.com');
    const bob = await userWith('bob', Permission.REQUEST_ALBUM, 'bob@example.com');
    await userWith('carol', Permission.REQUEST_ALBUM, 'carol@example.com'); // never opted in
    const allEvents = ['request.created', 'request.approved', 'request.available'];
    await setPrefs(alice, { email: { enabled: true, events: allEvents } });
    await setPrefs(bob, { email: { enabled: false, events: allEvents } });

    const req = await create(alice);
    await api(admin, 'POST', `/requests/${req.id}/approve`);

    const personal = sent().filter((p) => p.recipient?.email);
    expect(personal.map((p) => [p.event, p.recipient?.email, p.targetId])).toEqual([
      ['request.created', 'alice@example.com', designated.id],
      ['request.approved', 'alice@example.com', designated.id],
    ]);

    // Deliver everything queued; check the real mailbox.
    for (const payload of sent()) await runJob(h.app, NOTIFY_JOB, payload);
    const toAlice = mails.filter((m) => m.to.length === 1 && m.to[0] === 'alice@example.com');
    expect(toAlice).toHaveLength(2);
    expect(toAlice[0]?.data).toMatch(/^Subject: \[Hearer\] New request awaiting approval$/m);
    // The admin copy of the designated target (to: admin@) is a separate admin delivery.
    expect(mails.some((m) => m.to.includes('bob@example.com'))).toBe(false);
    expect(mails.some((m) => m.to.includes('carol@example.com'))).toBe(false);
  });

  it('does not email without a designated SMTP target, an address, a subscription or enabled=true', async () => {
    const alice = await userWith('alice', Permission.REQUEST_ALBUM, 'alice@example.com');
    const noAddr = await userWith('noaddr', Permission.REQUEST_ALBUM);
    await setPrefs(alice, { email: { enabled: true, events: ['request.created'] } });
    await setPrefs(noAddr, { email: { enabled: true, events: ['request.created'] } });
    await create(alice, ALBUM); // no SMTP target at all
    expect(sent()).toEqual([]);

    await smtpTarget(false); // not designated
    h.app.hearer.events.emit('upload.failed', { uploadId: 'a', uploaderId: userId('alice') });
    expect(sent()).toEqual([]);

    await smtpTarget(true, false); // designated but disabled
    h.app.hearer.events.emit('upload.imported', { uploadId: 'a', uploaderId: userId('alice') });
    expect(sent().filter((p) => p.recipient)).toEqual([]);
  });

  it('upload events go to the uploader only, per their subscribed events', async () => {
    await smtpTarget(true);
    const alice = await userWith('alice', Permission.UPLOAD, 'alice@example.com');
    const bob = await userWith('bob', Permission.UPLOAD, 'bob@example.com');
    await setPrefs(alice, { email: { enabled: true, events: ['upload.imported'] } });
    await setPrefs(bob, { email: { enabled: true, events: ['upload.imported', 'upload.failed'] } });
    h.app.hearer.events.emit('upload.imported', {
      uploadId: 'u1',
      uploaderId: userId('alice'),
      originalName: 'a.flac',
    });
    h.app.hearer.events.emit('upload.failed', {
      uploadId: 'u2',
      uploaderId: userId('alice'),
      detail: 'bad file',
    });
    h.app.hearer.events.emit('upload.imported', { uploadId: 'u3', uploaderId: userId('bob') });
    h.app.hearer.events.emit('upload.failed', { uploadId: 'u4', uploaderId: userId('bob') });
    expect(
      sent()
        .filter((p) => p.recipient)
        .map((p) => `${p.event}:${p.recipient?.email ?? ''}`),
    ).toEqual([
      'upload.imported:alice@example.com',
      'upload.imported:bob@example.com',
      'upload.failed:bob@example.com',
    ]);
  });

  it('personal ntfy topics use the default server, or the designated ntfy target', async () => {
    const alice = await userWith('alice', Permission.REQUEST_ALBUM);
    await setPrefs(alice, { ntfy: { topic: 'alice-music', events: ['request.created'] } });
    await create(alice);
    const first = sent();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ targetId: null, recipient: { ntfyTopic: 'alice-music' } });

    // With no target the personal topic goes to ntfy.sh; point a fetch stub at the mock to check.
    const seen: string[] = [];
    const sentVia = new NotificationService({
      db: db(),
      secrets: h.app.hearer.secrets,
      settings: h.app.hearer.settings,
      jobs: h.app.hearer.jobs,
      events: h.app.hearer.events,
      log: h.app.log,
      version: 'test',
      fetch: ((url: string) => {
        seen.push(url);
        return Promise.resolve(new Response('ok'));
      }) as typeof fetch,
    });
    const first0 = first[0];
    if (!first0) throw new Error('no payload');
    await sentVia.deliver(first0);
    expect(seen).toEqual(['https://ntfy.sh/alice-music']);

    // A designated ntfy target supplies the server and credentials but not the topic.
    await addTarget(
      'ntfy',
      { serverUrl: mock.url, topic: 'admins', token: 'srv', userTopics: true },
      [],
    );
    expect(
      (await api(alice, 'GET', '/auth/me/notifications')).json<UserNotificationsResponse>().ntfy
        .server,
    ).toBe(mock.url);
    await create(await userWith('bob', Permission.REQUEST_ALBUM), ALBUM).catch(() => undefined);
    h.app.hearer.events.emit('upload.imported', { uploadId: 'zz', uploaderId: userId('alice') });
    await setPrefs(alice, { ntfy: { topic: 'alice-music', events: ['upload.imported'] } });
    h.app.hearer.events.emit('upload.imported', { uploadId: 'zz', uploaderId: userId('alice') });
    const viaTarget = sent().at(-1);
    expect(viaTarget?.recipient?.ntfyTopic).toBe('alice-music');
    expect(viaTarget?.targetId).not.toBeNull();
    if (viaTarget) await svc().deliver(viaTarget);
    const req = mock.requests.at(-1);
    expect(req?.path).toBe('/alice-music');
    expect(req?.headers.authorization).toBe('Bearer srv');
  });

  it('ignores stored prefs that no longer validate', async () => {
    await smtpTarget(true);
    const alice = await userWith('alice', Permission.UPLOAD, 'alice@example.com');
    db()
      .update(users)
      .set({ notifyPrefs: { email: { enabled: 'yes' } } as never })
      .where(eq(users.id, userId('alice')))
      .run();
    h.app.hearer.events.emit('upload.imported', { uploadId: 'u', uploaderId: userId('alice') });
    expect(sent()).toEqual([]);
    expect(
      (await api(alice, 'GET', '/auth/me/notifications')).json<UserNotificationsResponse>().prefs,
    ).toEqual({});
  });
});

// ---- helpers --------------------------------------------------------------------------------

const allRows = () => db().select().from(jobsTable).where(eq(jobsTable.type, NOTIFY_JOB)).all();
const rowOf = () => allRows()[0];

async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
