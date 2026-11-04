import {
  Permission,
  REQUEST_STATUSES,
  type RequestCounts,
  type RequestDetailDto,
  type RequestDto,
  type RequestListResponse,
  type RequestStatus,
} from '@hearer/shared';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProviderPermanentError,
  ProviderSkipError,
  ProviderTemporaryError,
  type FulfillmentProvider,
} from '../src/adapters/fulfillment/types.ts';
import { jobs, requests, uploads } from '../src/db/schema.ts';
import { EventBus, type HearerEventName } from '../src/lib/events.ts';
import { HttpError } from '../src/lib/http-error.ts';
import { TRANSITIONS } from '../src/services/requests.ts';
import {
  addUser,
  call,
  completeSetup,
  createHarness,
  login,
  type Credentials,
  type Harness,
} from './helpers/auth.ts';
import {
  ALBUM,
  ARTIST,
  FakeMetadata,
  ID,
  TRACKS,
  queuedJobs,
  requestRow,
  runJob,
  seedTracks,
} from './helpers/requests.ts';

const ALB = Permission.REQUEST_ALBUM;

let h: Harness;
let meta: FakeMetadata;
let admin: Credentials;
let events: { name: HearerEventName; payload: unknown }[];

beforeEach(async () => {
  meta = new FakeMetadata();
  h = await createHarness({ deps: { metadata: meta.asProvider() } });
  admin = await completeSetup(h);
  events = [];
  const names: HearerEventName[] = [
    'request.created',
    'request.approved',
    'request.declined',
    'request.available',
    'request.partially_available',
    'request.failed',
    'request.cancelled',
  ];
  h.app.hearer.events.onAny(names, (name, payload) => {
    events.push({ name, payload });
  });
});
afterEach(async () => {
  await h.cleanup();
});

async function userWith(name: string, permissions: number): Promise<Credentials> {
  await addUser(h.app, name, permissions);
  return login(h.app, name);
}
const api = (creds: Credentials, method: 'GET' | 'POST', url: string, body?: unknown) =>
  call(h.app, creds, method, `/api/v1${url}`, body);
const create = async (creds: Credentials, mbid = ALBUM, type = 'album') =>
  (await api(creds, 'POST', '/requests', { type, mbid })).json<RequestDto>();
const detail = async (creds: Credentials, id: string) =>
  (await api(creds, 'GET', `/requests/${id}`)).json<RequestDetailDto>();
const errorCode = (res: LightMyRequestResponse) =>
  res.json<{ error: { code: string } }>().error.code;
const adminUser = () => {
  const row = h.app.hearer.users.getByUsername('admin');
  if (!row) throw new Error('no admin');
  return { ...row, permissions: Permission.ADMIN };
};
const names = () => events.map((e) => e.name);

describe('approve, decline, retry, cancel', () => {
  it('approve: PENDING -> APPROVED, records who, queues submit, emits request.approved', async () => {
    const user = await userWith('u', ALB);
    const created = await create(user);
    const res = await api(admin, 'POST', `/requests/${created.id}/approve`);
    expect(res.statusCode).toBe(200);
    expect(res.json<RequestDto>()).toMatchObject({
      status: 'APPROVED',
      decidedBy: { username: 'admin' },
    });
    expect(res.json<RequestDto>().decidedAt).not.toBeNull();
    expect(queuedJobs(h.app, 'requests.submit')).toHaveLength(1);
    expect(names()).toEqual(['request.created', 'request.approved']);
    const timeline = (await detail(user, created.id)).events;
    expect(timeline.map((e) => e.toStatus)).toEqual(['PENDING', 'APPROVED']);
    expect(timeline[1]).toMatchObject({ fromStatus: 'PENDING', actor: { username: 'admin' } });
  });

  it('approving twice, or approving a declined request, is 409 invalid_transition', async () => {
    const user = await userWith('u', ALB);
    const created = await create(user);
    await api(admin, 'POST', `/requests/${created.id}/approve`);
    const again = await api(admin, 'POST', `/requests/${created.id}/approve`);
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('invalid_transition');
    expect(again.json<{ error: { details: unknown } }>().error.details).toEqual({
      from: 'APPROVED',
      to: 'APPROVED',
    });
    expect(queuedJobs(h.app, 'requests.submit')).toHaveLength(1);
  });

  it('decline needs a reason (1-500 chars), stores it and notifies', async () => {
    const user = await userWith('u', ALB);
    const created = await create(user);
    const url = `/requests/${created.id}/decline`;
    expect((await api(admin, 'POST', url, {})).statusCode).toBe(400);
    expect((await api(admin, 'POST', url, { reason: '   ' })).statusCode).toBe(400);
    expect((await api(admin, 'POST', url, { reason: 'x'.repeat(501) })).statusCode).toBe(400);
    expect(requestRow(h.app, created.id).status).toBe('PENDING');
    const ok = await api(admin, 'POST', url, { reason: 'x'.repeat(500) });
    expect(ok.statusCode).toBe(200);
    const res = await api(user, 'GET', `/requests/${created.id}`);
    expect(res.json<RequestDetailDto>()).toMatchObject({ status: 'DECLINED' });
    expect(res.json<RequestDetailDto>().declineReason).toHaveLength(500);
    expect(events.at(-1)).toMatchObject({
      name: 'request.declined',
      payload: { declineReason: 'x'.repeat(500), requestedBy: expect.any(String) as string },
    });
    // Final: cannot be approved or cancelled afterwards.
    expect(errorCode(await api(admin, 'POST', `/requests/${created.id}/approve`))).toBe(
      'invalid_transition',
    );
    expect(errorCode(await api(user, 'POST', `/requests/${created.id}/cancel`))).toBe(
      'invalid_transition',
    );
    expect(queuedJobs(h.app, 'requests.submit')).toHaveLength(0);
  });

  it('only request managers may approve, decline or retry', async () => {
    const user = await userWith('u', ALB | Permission.VIEW_ALL_REQUESTS);
    const created = await create(user);
    for (const path of ['approve', 'retry']) {
      expect((await api(user, 'POST', `/requests/${created.id}/${path}`)).statusCode).toBe(403);
    }
    expect(
      (await api(user, 'POST', `/requests/${created.id}/decline`, { reason: 'no' })).statusCode,
    ).toBe(403);
    expect(requestRow(h.app, created.id).status).toBe('PENDING');
  });

  it('unknown request ids are 404', async () => {
    expect((await api(admin, 'POST', `/requests/${ID(5)}/approve`)).statusCode).toBe(404);
    expect((await api(admin, 'GET', `/requests/${ID(5)}`)).statusCode).toBe(404);
    expect((await api(admin, 'POST', `/requests/${ID(5)}/cancel`)).statusCode).toBe(404);
  });

  it('retry: FAILED -> APPROVED, clears the provider, queues submit; refuses other states', async () => {
    const user = await userWith('u', ALB);
    const created = await create(user);
    expect(errorCode(await api(admin, 'POST', `/requests/${created.id}/retry`))).toBe(
      'invalid_transition',
    );
    h.app.hearer.requests.transition(created.id, 'APPROVED');
    h.app.hearer.requests.transition(created.id, 'FAILED', {
      note: 'boom',
      patch: { providerId: 'lidarr', providerRef: '{}' },
    });
    events.length = 0;
    const res = await api(admin, 'POST', `/requests/${created.id}/retry`);
    expect(res.statusCode).toBe(200);
    expect(res.json<RequestDto>()).toMatchObject({ status: 'APPROVED', providerId: null });
    expect(requestRow(h.app, created.id).providerRef).toBeNull();
    expect(queuedJobs(h.app, 'requests.submit').length).toBeGreaterThan(0);
    // A retry is not a fresh approval, so no second approval notification.
    expect(names()).toEqual([]);
    const notes = (await detail(admin, created.id)).events.map((e) => e.note);
    expect(notes.slice(-2)).toEqual(['boom', 'Retried']);
  });

  it('retry is refused when a newer request for the same item is active', async () => {
    const user = await userWith('u', ALB);
    const old = await create(user);
    h.app.hearer.requests.transition(old.id, 'APPROVED');
    h.app.hearer.requests.transition(old.id, 'FAILED');
    const fresh = await create(user);
    const res = await api(admin, 'POST', `/requests/${old.id}/retry`);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('already_requested');
    expect(res.json<{ error: { details: { requestId: string } } }>().error.details.requestId).toBe(
      fresh.id,
    );
  });

  it('cancel: the owner while active, a manager any time it is not final; others get 404', async () => {
    const owner = await userWith('owner', ALB);
    const stranger = await userWith('stranger', ALB | Permission.VIEW_ALL_REQUESTS);
    const created = await create(owner);
    expect((await api(stranger, 'POST', `/requests/${created.id}/cancel`)).statusCode).toBe(404);
    expect(requestRow(h.app, created.id).status).toBe('PENDING');
    const res = await api(owner, 'POST', `/requests/${created.id}/cancel`);
    expect(res.statusCode).toBe(200);
    expect(res.json<RequestDto>().status).toBe('CANCELLED');
    expect(names().at(-1)).toBe('request.cancelled');
    expect((await detail(owner, created.id)).events.at(-1)?.note).toBe(
      'Cancelled by the requester',
    );

    const second = await create(owner);
    const byAdmin = await api(admin, 'POST', `/requests/${second.id}/cancel`);
    expect(byAdmin.statusCode).toBe(200);
    expect((await detail(admin, second.id)).events.at(-1)).toMatchObject({
      note: 'Cancelled',
      actor: { username: 'admin' },
    });
  });

  it('an AVAILABLE request cannot be cancelled', async () => {
    const owner = await userWith('owner', ALB);
    const created = await create(owner);
    h.app.hearer.requests.transition(created.id, 'APPROVED');
    h.app.hearer.requests.transition(created.id, 'AVAILABLE');
    expect(errorCode(await api(owner, 'POST', `/requests/${created.id}/cancel`))).toBe(
      'invalid_transition',
    );
  });

  it('cancelling a submitted request asks the provider to withdraw it; a failing provider is noted', async () => {
    const owner = await userWith('owner', ALB);
    const created = await create(owner);
    h.app.hearer.requests.transition(created.id, 'APPROVED');
    h.app.hearer.requests.transition(created.id, 'PROCESSING', {
      patch: { providerId: 'fake', providerRef: 'ref-1' },
    });
    const cancelled: string[] = [];
    const fake: FulfillmentProvider = {
      id: 'fake',
      label: 'Fake',
      supports: { track: true, album: true, artist: true },
      configSchema: z.object({}),
      submit: () => Promise.reject(new Error('unused')),
      cancel: (ref) => {
        cancelled.push(ref);
        return Promise.resolve();
      },
    };
    h.app.hearer.fulfillment.get = (id) => (id === 'fake' ? fake : undefined);
    expect((await api(owner, 'POST', `/requests/${created.id}/cancel`)).statusCode).toBe(200);
    expect(cancelled).toEqual(['ref-1']);
    expect((await detail(owner, created.id)).events.at(-1)?.note).toBe(
      'Cancelled by the requester',
    );
  });

  it('a provider that fails to withdraw does not block the cancel, and the timeline says so', async () => {
    const owner = await userWith('owner', ALB);
    const created = await create(owner);
    h.app.hearer.requests.transition(created.id, 'APPROVED');
    h.app.hearer.requests.transition(created.id, 'PROCESSING', {
      patch: { providerId: 'fake', providerRef: 'ref-2' },
    });
    h.app.hearer.fulfillment.get = () => ({
      id: 'fake',
      label: 'Fake',
      supports: { track: true, album: true, artist: true },
      configSchema: z.object({}),
      submit: () => Promise.reject(new Error('unused')),
      cancel: () => Promise.reject(new Error('provider is down')),
    });
    expect((await api(owner, 'POST', `/requests/${created.id}/cancel`)).statusCode).toBe(200);
    expect(requestRow(h.app, created.id).status).toBe('CANCELLED');
    expect((await detail(owner, created.id)).events.at(-1)?.note).toContain(
      'could not withdraw it from Fake: provider is down',
    );
  });
});

describe('transition table', () => {
  // Every status pair is exercised through the single transition function.
  const route: Record<RequestStatus, RequestStatus[]> = {
    PENDING: [],
    APPROVED: ['APPROVED'],
    PROCESSING: ['APPROVED', 'PROCESSING'],
    AWAITING_UPLOAD: ['APPROVED', 'AWAITING_UPLOAD'],
    PARTIALLY_AVAILABLE: ['APPROVED', 'PARTIALLY_AVAILABLE'],
    AVAILABLE: ['APPROVED', 'AVAILABLE'],
    DECLINED: ['DECLINED'],
    FAILED: ['APPROVED', 'FAILED'],
    CANCELLED: ['CANCELLED'],
  };

  for (const from of REQUEST_STATUSES) {
    for (const to of REQUEST_STATUSES) {
      const allowed = TRANSITIONS[from].includes(to);
      it(`${from} -> ${to} is ${allowed ? 'allowed' : 'refused'}`, async () => {
        const user = await userWith('u', ALB);
        const created = await create(user);
        for (const step of route[from]) h.app.hearer.requests.transition(created.id, step);
        expect(requestRow(h.app, created.id).status).toBe(from);
        const before = (await detail(user, created.id)).events.length;
        if (allowed) {
          h.app.hearer.requests.transition(created.id, to, { note: 'because' });
          expect(requestRow(h.app, created.id).status).toBe(to);
          expect((await detail(user, created.id)).events).toHaveLength(before + 1);
        } else {
          let thrown: unknown;
          try {
            h.app.hearer.requests.transition(created.id, to);
          } catch (err) {
            thrown = err;
          }
          expect(thrown).toBeInstanceOf(HttpError);
          expect(thrown).toMatchObject({ statusCode: 409, code: 'invalid_transition' });
          expect(requestRow(h.app, created.id).status).toBe(from);
          expect((await detail(user, created.id)).events).toHaveLength(before);
        }
      });
    }
  }

  it('final states have no way out', () => {
    for (const s of ['AVAILABLE', 'DECLINED', 'CANCELLED'] as const) {
      expect(TRANSITIONS[s]).toEqual([]);
    }
  });
});

describe('timeline and events', () => {
  it('records every step in order with actor, from/to and note, and bumps updated_at', async () => {
    const user = await userWith('u', ALB);
    const created = await create(user);
    const row0 = requestRow(h.app, created.id);
    await new Promise((r) => setTimeout(r, 5));
    h.app.hearer.requests.transition(created.id, 'APPROVED', { actorId: null, note: 'sys' });
    h.app.hearer.requests.transition(created.id, 'AWAITING_UPLOAD', {
      note: 'Waiting for an upload',
    });
    const tl = (await detail(user, created.id)).events;
    expect(tl.map((e) => [e.fromStatus, e.toStatus, e.note, e.actor?.username ?? null])).toEqual([
      [null, 'PENDING', 'Requested', 'u'],
      ['PENDING', 'APPROVED', 'sys', null],
      ['APPROVED', 'AWAITING_UPLOAD', 'Waiting for an upload', null],
    ]);
    expect(requestRow(h.app, created.id).updatedAt.getTime()).toBeGreaterThan(
      row0.updatedAt.getTime(),
    );
  });

  it('addNote adds a status-less entry', async () => {
    const user = await userWith('u', ALB);
    const created = await create(user);
    h.app.hearer.requests.addNote(created.id, 'Lidarr is searching');
    const last = (await detail(user, created.id)).events.at(-1);
    expect(last).toMatchObject({
      fromStatus: 'PENDING',
      toStatus: 'PENDING',
      note: 'Lidarr is searching',
    });
  });

  it('emits created/approved/declined/available/partially/failed/cancelled with payloads', async () => {
    const user = await userWith('u', ALB | Permission.AUTO_APPROVE);
    const a = await create(user);
    expect(events.map((e) => e.name)).toEqual(['request.created', 'request.approved']);
    expect(events[0]?.payload).toMatchObject({
      requestId: a.id,
      type: 'album',
      mbid: ALBUM,
      title: 'OK Computer',
      artistName: 'Radiohead',
      from: null,
      to: 'PENDING',
    });
    const svc = h.app.hearer.requests;
    svc.transition(a.id, 'PROCESSING'); // no event
    svc.transition(a.id, 'PARTIALLY_AVAILABLE');
    svc.transition(a.id, 'AVAILABLE');
    expect(names().slice(2)).toEqual(['request.partially_available', 'request.available']);

    meta.addAlbum(ID(101), 'Second');
    const b = await create(await userWith('v', ALB), ID(101));
    h.app.hearer.requests.decline(b.id, adminUser(), 'no thanks');
    const c = await create(await userWith('w', ALB), ID(101));
    h.app.hearer.requests.transition(c.id, 'APPROVED');
    h.app.hearer.requests.transition(c.id, 'FAILED', { note: 'broke' });
    h.app.hearer.requests.transition(c.id, 'CANCELLED');
    expect(names().slice(4)).toEqual([
      'request.created',
      'request.declined',
      'request.created',
      'request.approved',
      'request.failed',
      'request.cancelled',
    ]);
    expect(events.find((e) => e.name === 'request.failed')?.payload).toMatchObject({
      note: 'broke',
      from: 'APPROVED',
      to: 'FAILED',
    });
  });

  it('a failing listener is logged and never breaks the request flow or other listeners', async () => {
    const seen: string[] = [];
    h.app.hearer.events.on('request.created', () => {
      throw new Error('listener bug');
    });
    h.app.hearer.events.on('request.created', () => Promise.reject(new Error('async bug')));
    h.app.hearer.events.on('request.created', (p) => {
      seen.push(p.requestId);
    });
    const user = await userWith('u', ALB);
    const res = await api(user, 'POST', '/requests', { type: 'album', mbid: ALBUM });
    expect(res.statusCode).toBe(201);
    expect(seen).toEqual([res.json<RequestDto>().id]);
  });

  it('EventBus: unsubscribe works and listener errors are reported to the logger', () => {
    const errors: object[] = [];
    const bus = new EventBus({ error: (obj) => errors.push(obj) });
    const calls: number[] = [];
    const off = bus.on('upload.imported', () => {
      calls.push(1);
    });
    bus.on('upload.imported', () => {
      throw new Error('x');
    });
    bus.emit('upload.imported', { uploadId: 'u', uploaderId: 'v' });
    off();
    bus.emit('upload.imported', { uploadId: 'u', uploaderId: 'v' });
    expect(calls).toEqual([1]);
    expect(errors).toHaveLength(2);
    expect(bus.listenerCount('upload.imported')).toBe(1);
  });
});

describe('listing, visibility and counts', () => {
  it('lists only your own requests by default; ?all needs VIEW_ALL_REQUESTS or MANAGE_REQUESTS', async () => {
    const a = await userWith('a', ALB);
    const b = await userWith('b', ALB);
    meta.addAlbum(ID(101), 'Second');
    await create(a);
    await create(b, ID(101));

    const own = (await api(a, 'GET', '/requests')).json<RequestListResponse>();
    expect(own.total).toBe(1);
    expect(own.items[0]?.requestedBy?.username).toBe('a');

    const denied = await api(a, 'GET', '/requests?all=1');
    expect(denied.statusCode).toBe(403);
    expect((await api(a, 'GET', '/requests?requestedBy=someone-else')).statusCode).toBe(403);

    const viewer = await userWith('viewer', Permission.VIEW_ALL_REQUESTS);
    expect((await api(viewer, 'GET', '/requests?all=1')).json<RequestListResponse>().total).toBe(2);
    expect((await api(viewer, 'GET', '/requests')).json<RequestListResponse>().total).toBe(0);
    expect((await api(admin, 'GET', '/requests?all=true')).json<RequestListResponse>().total).toBe(
      2,
    );
    const manager = await userWith('mgr', Permission.MANAGE_REQUESTS);
    expect((await api(manager, 'GET', '/requests?all=1')).json<RequestListResponse>().total).toBe(
      2,
    );
  });

  it('filters by status, type and requester; sorts; paginates; includes requester display info', async () => {
    const a = await userWith('a', ALB | Permission.REQUEST | Permission.REQUEST_ARTIST);
    await addUser(h.app, 'b', ALB);
    const bCreds = await login(h.app, 'b');
    meta.addAlbum(ID(101), 'Second');
    const r1 = await create(a);
    await new Promise((r) => setTimeout(r, 3));
    const r2 = await create(a, ARTIST, 'artist');
    await new Promise((r) => setTimeout(r, 3));
    const r3 = await create(bCreds, ID(101));
    h.app.hearer.requests.transition(r1.id, 'APPROVED');

    const list = async (q: string) =>
      (await api(admin, 'GET', `/requests?all=1&${q}`)).json<RequestListResponse>();
    expect((await list('status=APPROVED')).items.map((i) => i.id)).toEqual([r1.id]);
    expect((await list('status=APPROVED,PENDING')).total).toBe(3);
    expect((await list('type=artist')).items.map((i) => i.id)).toEqual([r2.id]);
    const bId = r3.requestedBy?.id ?? '';
    expect((await list(`requestedBy=${bId}`)).items.map((i) => i.id)).toEqual([r3.id]);
    expect((await list('')).items.map((i) => i.id)).toEqual([r3.id, r2.id, r1.id]);
    expect((await list('order=asc')).items.map((i) => i.id)).toEqual([r1.id, r2.id, r3.id]);
    expect((await list('sort=updatedAt')).items[0]?.id).toBe(r1.id);
    const page = await list('limit=1&offset=1');
    expect(page).toMatchObject({ total: 3, offset: 1, limit: 1 });
    expect(page.items.map((i) => i.id)).toEqual([r2.id]);
    expect(page.items[0]?.requestedBy).toMatchObject({
      username: 'a',
      id: expect.any(String) as string,
    });
    expect((await api(admin, 'GET', '/requests?status=NOPE')).statusCode).toBe(400);
    expect((await api(admin, 'GET', '/requests?limit=1000')).statusCode).toBe(400);
  });

  it('GET /requests/:id: owner, VIEW_ALL and MANAGE see it; anyone else gets 404', async () => {
    const owner = await userWith('owner', ALB);
    const other = await userWith('other', ALB);
    const viewer = await userWith('viewer', Permission.VIEW_ALL_REQUESTS);
    const created = await create(owner);
    expect((await api(owner, 'GET', `/requests/${created.id}`)).statusCode).toBe(200);
    expect((await api(viewer, 'GET', `/requests/${created.id}`)).statusCode).toBe(200);
    expect((await api(admin, 'GET', `/requests/${created.id}`)).statusCode).toBe(200);
    const hidden = await api(other, 'GET', `/requests/${created.id}`);
    expect(hidden.statusCode).toBe(404);
    expect(errorCode(hidden)).toBe('not_found');
    const body = (await api(owner, 'GET', `/requests/${created.id}`)).json<RequestDetailDto>();
    expect(body.events).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('providerRef');
  });

  it("counts per status for your own requests or everyone's", async () => {
    const a = await userWith('a', ALB);
    const b = await userWith('b', ALB);
    meta.addAlbum(ID(101), 'Second');
    const r1 = await create(a);
    await create(b, ID(101));
    h.app.hearer.requests.transition(r1.id, 'APPROVED');
    const mine = (await api(a, 'GET', '/requests/counts')).json<RequestCounts>();
    expect(mine.total).toBe(1);
    expect(mine.byStatus).toMatchObject({ APPROVED: 1, PENDING: 0, AVAILABLE: 0 });
    expect(Object.keys(mine.byStatus).sort()).toEqual([...REQUEST_STATUSES].sort());
    const all = (await api(admin, 'GET', '/requests/counts?all=1')).json<RequestCounts>();
    expect(all).toMatchObject({ total: 2, byStatus: { APPROVED: 1, PENDING: 1 } });
    expect((await api(a, 'GET', '/requests/counts?all=1')).statusCode).toBe(403);
  });
});

describe('requests.availability job', () => {
  const pending = async (permissions = ALB) => {
    const user = await userWith(`u${String(Math.random()).slice(2, 8)}`, permissions);
    return create(user);
  };

  it('flips a fully present album to AVAILABLE and a partly present one to PARTIALLY_AVAILABLE', async () => {
    const full = await pending();
    h.app.hearer.requests.transition(full.id, 'APPROVED');
    seedTracks(h.app, [TRACKS[0], TRACKS[1]]);
    await runJob(h.app, 'requests.availability', {});
    expect(requestRow(h.app, full.id).status).toBe('PARTIALLY_AVAILABLE');
    expect(names()).toContain('request.partially_available');
    seedTracks(h.app, [TRACKS[2]]);
    await runJob(h.app, 'requests.availability', {});
    expect(requestRow(h.app, full.id).status).toBe('AVAILABLE');
    const tl = (await detail(admin, full.id)).events.map((e) => [e.toStatus, e.note, e.actor]);
    expect(tl.slice(-2)).toEqual([
      ['PARTIALLY_AVAILABLE', 'Part of this is in the library', null],
      ['AVAILABLE', 'Found in the library', null],
    ]);
    expect(names().at(-1)).toBe('request.available');
  });

  it('leaves PENDING and final requests alone', async () => {
    const cancelled = await pending();
    h.app.hearer.requests.transition(cancelled.id, 'CANCELLED');
    const waiting = await pending();
    seedTracks(h.app, TRACKS);
    await runJob(h.app, 'requests.availability', {});
    expect(requestRow(h.app, waiting.id).status).toBe('PENDING');
    expect(requestRow(h.app, cancelled.id).status).toBe('CANCELLED');
  });

  it('leaves a request that is not in the library yet where it is', async () => {
    const r = await pending();
    h.app.hearer.requests.transition(r.id, 'APPROVED');
    await runJob(h.app, 'requests.availability', {});
    expect(requestRow(h.app, r.id).status).toBe('APPROVED');
    expect((await detail(admin, r.id)).events).toHaveLength(2);
  });

  it('works for tracks and from AWAITING_UPLOAD / PROCESSING, and honours requestIds', async () => {
    const user = await userWith('t', Permission.REQUEST | ALB);
    meta.addAlbum(ID(101), 'Second');
    const track = await create(user, TRACKS[0], 'track');
    const album = await create(user, ID(101));
    for (const r of [track, album]) {
      h.app.hearer.requests.transition(r.id, 'APPROVED');
    }
    h.app.hearer.requests.transition(track.id, 'AWAITING_UPLOAD');
    h.app.hearer.requests.transition(album.id, 'PROCESSING');
    seedTracks(h.app, [TRACKS[0]]);
    // Only the album is evaluated: the track stays put.
    await runJob(h.app, 'requests.availability', { requestIds: [album.id] });
    expect(requestRow(h.app, track.id).status).toBe('AWAITING_UPLOAD');
    await runJob(h.app, 'requests.availability', {});
    expect(requestRow(h.app, track.id).status).toBe('AVAILABLE');
  });

  it('ignores a request cancelled mid-run and skips ids the catalog dropped', async () => {
    const r = await pending();
    h.app.hearer.requests.transition(r.id, 'APPROVED');
    seedTracks(h.app, TRACKS);
    meta.groups.delete(ALBUM);
    await runJob(h.app, 'requests.availability', {}); // not_found: logged, not thrown
    expect(requestRow(h.app, r.id).status).toBe('APPROVED');
  });

  it('a catalog outage fails the job for a retry but still processes the others', async () => {
    const user = await userWith('t', Permission.REQUEST | ALB);
    const track = await create(user, TRACKS[0], 'track');
    const album = await create(user, ALBUM);
    h.app.hearer.requests.transition(track.id, 'APPROVED');
    h.app.hearer.requests.transition(album.id, 'APPROVED');
    seedTracks(h.app, [TRACKS[0]]); // the track matches by id with no catalog call
    meta.down = true;
    await expect(runJob(h.app, 'requests.availability', {})).rejects.toMatchObject({
      name: 'MetadataError',
    });
    expect(requestRow(h.app, track.id).status).toBe('AVAILABLE');
    expect(requestRow(h.app, album.id).status).toBe('APPROVED');
  });

  it('re-queues APPROVED requests that lost their submit job', async () => {
    const r = await pending();
    h.app.hearer.requests.transition(r.id, 'APPROVED');
    h.app.hearer.database.db
      .update(requests)
      .set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(requests.id, r.id))
      .run();
    h.app.hearer.database.db.delete(jobs).run();
    await runJob(h.app, 'requests.availability', {});
    expect(queuedJobs(h.app, 'requests.submit')).toHaveLength(1);
    await runJob(h.app, 'requests.availability', {});
    expect(queuedJobs(h.app, 'requests.submit')).toHaveLength(1); // deduplicated by key
  });

  it('is the job the library sync queues (registered and payload-free)', () => {
    expect(h.app.hearer.jobs.registry.has('requests.availability')).toBe(true);
    const id = h.app.hearer.jobs.enqueue(
      'requests.availability',
      {},
      { uniqueKey: 'requests.availability' },
    );
    expect(
      h.app.hearer.jobs.enqueue(
        'requests.availability',
        {},
        { uniqueKey: 'requests.availability' },
      ),
    ).toBe(id);
  });
});

describe('requests.submit job', () => {
  async function approved(permissions = ALB, type = 'album', mbid = ALBUM) {
    const user = await userWith(
      `s${String(Math.random()).slice(2, 8)}`,
      permissions | Permission.REQUEST,
    );
    const created = await create(user, mbid, type);
    h.app.hearer.requests.transition(created.id, 'APPROVED');
    return created;
  }

  it('Manual: APPROVED -> AWAITING_UPLOAD with provider id and ref', async () => {
    const r = await approved();
    await runJob(h.app, 'requests.submit', { requestId: r.id });
    const row = requestRow(h.app, r.id);
    expect(row).toMatchObject({
      status: 'AWAITING_UPLOAD',
      providerId: 'manual',
      providerRef: `manual:${r.id}`,
    });
    const last = (await detail(admin, r.id)).events.at(-1);
    expect(last).toMatchObject({
      fromStatus: 'APPROVED',
      toStatus: 'AWAITING_UPLOAD',
      note: 'Waiting for an upload',
    });
  });

  it('a request that is no longer APPROVED (cancelled while queued, unknown) is ignored', async () => {
    const r = await approved();
    h.app.hearer.requests.transition(r.id, 'CANCELLED');
    await runJob(h.app, 'requests.submit', { requestId: r.id });
    expect(requestRow(h.app, r.id).status).toBe('CANCELLED');
    await runJob(h.app, 'requests.submit', { requestId: ID(404) });
  });

  it('no enabled provider: the request fails with a clear note and can be retried', async () => {
    h.app.hearer.settings.set('fulfillment', { manual: { enabled: false } });
    const r = await approved();
    await runJob(h.app, 'requests.submit', { requestId: r.id });
    expect(requestRow(h.app, r.id).status).toBe('FAILED');
    const last = (await detail(admin, r.id)).events.at(-1);
    expect(last?.note).toBe('No fulfillment provider is available for album requests');
    expect(names().at(-1)).toBe('request.failed');
    h.app.hearer.settings.set('fulfillment', { manual: { enabled: true } });
    expect((await api(admin, 'POST', `/requests/${r.id}/retry`)).statusCode).toBe(200);
    await runJob(h.app, 'requests.submit', { requestId: r.id });
    expect(requestRow(h.app, r.id).status).toBe('AWAITING_UPLOAD');
  });

  describe('with a scripted provider', () => {
    let behaviour: () => Promise<{ ref: string; status: 'PROCESSING' | 'AWAITING_UPLOAD' }>;
    let submitted: string[];
    beforeEach(() => {
      submitted = [];
      const fake: FulfillmentProvider = {
        id: 'fake',
        label: 'Fake',
        supports: { track: true, album: true, artist: true },
        configSchema: {} as FulfillmentProvider['configSchema'],
        submit: (req) => {
          submitted.push(req.id);
          return behaviour();
        },
      };
      const registry = h.app.hearer.fulfillment;
      const original = registry.select.bind(registry);
      registry.select = (req, opts) =>
        opts?.exclude?.includes('fake') ? original(req, opts) : fake;
    });

    it('PROCESSING result is stored with the ref', async () => {
      behaviour = () => Promise.resolve({ ref: '{"id":1}', status: 'PROCESSING' });
      const r = await approved();
      await runJob(h.app, 'requests.submit', { requestId: r.id });
      expect(requestRow(h.app, r.id)).toMatchObject({
        status: 'PROCESSING',
        providerId: 'fake',
        providerRef: '{"id":1}',
      });
      expect((await detail(admin, r.id)).events.at(-1)?.note).toBe('Submitted to Fake');
    });

    it('a skip falls through to the next provider (Manual)', async () => {
      behaviour = () => Promise.reject(new ProviderSkipError('not for tracks'));
      const r = await approved();
      await runJob(h.app, 'requests.submit', { requestId: r.id });
      expect(requestRow(h.app, r.id)).toMatchObject({
        status: 'AWAITING_UPLOAD',
        providerId: 'manual',
      });
    });

    it('a permanent error fails the request at once with the provider named', async () => {
      behaviour = () => Promise.reject(new ProviderPermanentError('API key rejected'));
      const r = await approved();
      await runJob(h.app, 'requests.submit', { requestId: r.id });
      expect(requestRow(h.app, r.id).status).toBe('FAILED');
      expect((await detail(admin, r.id)).events.at(-1)?.note).toBe('Fake: API key rejected');
    });

    it('a temporary error is rethrown for the runner to retry, until the last attempt fails the request', async () => {
      behaviour = () => Promise.reject(new ProviderTemporaryError('album not refreshed yet'));
      const r = await approved();
      await expect(runJob(h.app, 'requests.submit', { requestId: r.id }, 1)).rejects.toThrow(
        'album not refreshed yet',
      );
      expect(requestRow(h.app, r.id).status).toBe('APPROVED');
      await runJob(h.app, 'requests.submit', { requestId: r.id }, 6);
      expect(requestRow(h.app, r.id).status).toBe('FAILED');
      expect((await detail(admin, r.id)).events.at(-1)?.note).toContain('after 6 attempts');
    });

    it('a request cancelled during the provider call is withdrawn, not resurrected', async () => {
      let cancelledRef = '';
      const r = await approved();
      behaviour = () => {
        h.app.hearer.requests.transition(r.id, 'CANCELLED');
        return Promise.resolve({ ref: 'late', status: 'PROCESSING' as const });
      };
      const registry = h.app.hearer.fulfillment;
      registry.select = () =>
        ({
          id: 'fake',
          label: 'Fake',
          supports: { track: true, album: true, artist: true },
          configSchema: {},
          submit: () => behaviour(),
          cancel: (ref: string) => {
            cancelledRef = ref;
            return Promise.resolve();
          },
        }) as unknown as FulfillmentProvider;
      await runJob(h.app, 'requests.submit', { requestId: r.id });
      expect(requestRow(h.app, r.id).status).toBe('CANCELLED');
      expect(cancelledRef).toBe('late');
    });
  });
});

describe('fulfillFromUpload (for the import batch)', () => {
  const upload = (userId: string) =>
    h.app.hearer.database.db
      .insert(uploads)
      .values({ uploaderId: userId, originalName: 'a.flac' })
      .returning()
      .get().id;

  async function awaiting() {
    const user = await userWith('u', ALB);
    const userId = h.app.hearer.users.getByUsername('u')?.id ?? '';
    const created = await create(user);
    h.app.hearer.requests.transition(created.id, 'APPROVED');
    h.app.hearer.requests.transition(created.id, 'AWAITING_UPLOAD');
    return { user, userId, created };
  }

  it('links the upload and completes the request', async () => {
    const { user, userId, created } = await awaiting();
    const upId = upload(userId);
    const row = h.app.hearer.requests.fulfillFromUpload(created.id, upId);
    expect(row).toMatchObject({ status: 'AVAILABLE', fulfilledByUploadId: upId });
    expect(names().at(-1)).toBe('request.available');
    expect((await detail(user, created.id)).events.at(-1)?.note).toBe('Fulfilled by an upload');
  });

  it('partial fulfilment keeps the request open; a second part only adds a note', async () => {
    const { user, userId, created } = await awaiting();
    const svc = h.app.hearer.requests;
    const first = upload(userId);
    const second = upload(userId);
    expect(svc.fulfillFromUpload(created.id, first, { partial: true }).status).toBe(
      'PARTIALLY_AVAILABLE',
    );
    const row = svc.fulfillFromUpload(created.id, second, {
      partial: true,
      note: 'Track 2 uploaded',
    });
    expect(row).toMatchObject({ status: 'PARTIALLY_AVAILABLE', fulfilledByUploadId: second });
    expect(names().filter((n) => n === 'request.partially_available')).toHaveLength(1);
    expect((await detail(user, created.id)).events.at(-1)?.note).toBe('Track 2 uploaded');
    expect(svc.fulfillFromUpload(created.id, second).status).toBe('AVAILABLE');
  });

  it('refuses requests that are not approved yet or already final', async () => {
    const user = await userWith('u', ALB);
    const userId = h.app.hearer.users.getByUsername('u')?.id ?? '';
    const created = await create(user);
    const svc = h.app.hearer.requests;
    expect(() => svc.fulfillFromUpload(created.id, upload(userId))).toThrow(/cannot become/);
    svc.transition(created.id, 'CANCELLED');
    expect(() => svc.fulfillFromUpload(created.id, upload(userId))).toThrow(HttpError);
    expect(() => svc.fulfillFromUpload(ID(9), upload(userId))).toThrow(/not found/);
  });
});
