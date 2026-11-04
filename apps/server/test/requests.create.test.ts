import { Permission, type RequestDto, type RequestQuota } from '@hearer/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requests, users } from '../src/db/schema.ts';
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
  recording,
  seedTracks,
} from './helpers/requests.ts';

const DAY = 86_400_000;
const REQ = Permission.REQUEST;
const ALB = Permission.REQUEST_ALBUM;
const ART = Permission.REQUEST_ARTIST;

let h: Harness;
let meta: FakeMetadata;
let admin: Credentials;

beforeEach(async () => {
  meta = new FakeMetadata();
  h = await createHarness({ deps: { metadata: meta.asProvider() } });
  admin = await completeSetup(h);
});
afterEach(async () => {
  await h.cleanup();
});

async function userWith(name: string, permissions: number): Promise<Credentials> {
  await addUser(h.app, name, permissions);
  return login(h.app, name);
}

const post = (creds: Credentials, type: string, mbid: string) =>
  call(h.app, creds, 'POST', '/api/v1/requests', { type, mbid });

/** Make `n` extra requests for the user directly in the database, `ageMs` old. */
function seedRequests(userId: string, n: number, ageMs: number, status = 'PENDING') {
  for (let i = 0; i < n; i++) {
    h.app.hearer.database.db
      .insert(requests)
      .values({
        type: 'track',
        mbid: ID(9000 + i + Math.floor(ageMs / 1000) + status.length),
        title: `Seed ${String(i)}`,
        status: status as 'PENDING',
        requestedBy: userId,
        createdAt: new Date(Date.now() - ageMs),
      })
      .run();
  }
}

describe('POST /requests: per-type permissions', () => {
  const cases: { type: 'track' | 'album' | 'artist'; mbid: string; bit: number }[] = [
    { type: 'track', mbid: TRACKS[0], bit: REQ },
    { type: 'album', mbid: ALBUM, bit: ALB },
    { type: 'artist', mbid: ARTIST, bit: ART },
  ];
  const allBits = [REQ, ALB, ART];

  for (const c of cases) {
    it(`${c.type}: allowed only with its own bit (and ADMIN)`, async () => {
      const ok = await userWith(`ok-${c.type}`, c.bit);
      const res = await post(ok, c.type, c.mbid);
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json<RequestDto>();
      expect(body).toMatchObject({ type: c.type, mbid: c.mbid, status: 'PENDING' });
      expect(body.requestedBy?.username).toBe(`ok-${c.type}`);

      // Everyone holding only the other two bits is refused.
      const others = allBits.filter((b) => b !== c.bit).reduce((a, b) => a | b, 0);
      const no = await userWith(`no-${c.type}`, others);
      const denied = await post(no, c.type, c.mbid);
      expect(denied.statusCode).toBe(403);
    });
  }

  it('ADMIN may request any type', async () => {
    for (const c of cases) {
      const res = await post(admin, c.type, c.mbid);
      expect(res.statusCode, `${c.type}: ${res.body}`).toBe(201);
    }
  });

  it('a user with no request bits is refused before anything else', async () => {
    const nobody = await userWith('nobody', Permission.UPLOAD);
    expect((await post(nobody, 'album', ALBUM)).statusCode).toBe(403);
  });
});

describe('POST /requests: catalog data and validation', () => {
  it('copies title, artist and cover from the catalog', async () => {
    const creds = await userWith('u', ALB);
    const body = (await post(creds, 'album', ALBUM)).json<RequestDto>();
    expect(body).toMatchObject({
      title: 'OK Computer',
      artistName: 'Radiohead',
      parentMbid: null,
      declineReason: null,
      providerId: null,
    });
    expect(body.coverUrl).toContain(ALBUM);
  });

  it('an artist request has no cover; a track remembers its release group', async () => {
    const creds = await userWith('u', REQ | ART);
    const artist = (await post(creds, 'artist', ARTIST)).json<RequestDto>();
    expect(artist).toMatchObject({ title: 'Radiohead', artistName: 'Radiohead', coverUrl: null });
    const track = (await post(creds, 'track', TRACKS[1])).json<RequestDto>();
    expect(track.parentMbid).toBe(ALBUM);
    expect(track.title).toBe('Track 2');
  });

  it('a track without any release group has no parent', async () => {
    meta.recordings.set(ID(300), recording(ID(300), 'Loose', null));
    const creds = await userWith('u', REQ);
    const track = (await post(creds, 'track', ID(300))).json<RequestDto>();
    expect(track.parentMbid).toBeNull();
    expect(track.coverUrl).toBeNull();
  });

  it('an unknown MBID is 404; an unreachable catalog is 502; a bad body is 400', async () => {
    const creds = await userWith('u', ALB);
    expect((await post(creds, 'album', ID(777))).statusCode).toBe(404);
    meta.down = true;
    const res = await post(creds, 'album', ALBUM);
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('metadata_unavailable');
    expect((await post(creds, 'album', 'not-a-uuid')).statusCode).toBe(400);
    expect((await post(creds, 'playlist', ALBUM)).statusCode).toBe(400);
  });

  it('upper-case MBIDs are normalised', async () => {
    const creds = await userWith('u', ALB);
    const res = await post(creds, 'album', ALBUM.toUpperCase());
    expect(res.statusCode).toBe(201);
    expect(res.json<RequestDto>().mbid).toBe(ALBUM);
  });
});

describe('duplicates and availability', () => {
  it('rejects an active duplicate from anyone with 409 and the existing id', async () => {
    const a = await userWith('a', ALB);
    const b = await userWith('b', ALB);
    const first = (await post(a, 'album', ALBUM)).json<RequestDto>();
    const res = await post(b, 'album', ALBUM);
    expect(res.statusCode).toBe(409);
    const err = res.json<{ error: { code: string; details: { requestId: string } } }>().error;
    expect(err.code).toBe('already_requested');
    expect(err.details.requestId).toBe(first.id);
  });

  it('a duplicate costs no catalog lookup', async () => {
    const a = await userWith('a', ALB);
    await post(a, 'album', ALBUM);
    meta.calls = [];
    await post(a, 'album', ALBUM);
    expect(meta.calls).toEqual([]);
  });

  it('the same mbid as another type is not a duplicate', async () => {
    meta.recordings.set(ALBUM, recording(ALBUM, 'Same id', null));
    const creds = await userWith('u', REQ | ALB);
    expect((await post(creds, 'album', ALBUM)).statusCode).toBe(201);
    expect((await post(creds, 'track', ALBUM)).statusCode).toBe(201);
  });

  it('declined, cancelled and failed requests free the slot', async () => {
    const creds = await userWith('u', ALB);
    for (const status of ['DECLINED', 'CANCELLED', 'FAILED'] as const) {
      const res = await post(creds, 'album', ALBUM);
      expect(res.statusCode, status).toBe(201);
      h.app.hearer.database.db
        .update(requests)
        .set({ status })
        .where(eq(requests.id, res.json<RequestDto>().id))
        .run();
    }
  });

  it('an AVAILABLE request does not block a new one when the library lost the item', async () => {
    const creds = await userWith('u', ALB);
    const first = (await post(creds, 'album', ALBUM)).json<RequestDto>();
    h.app.hearer.database.db
      .update(requests)
      .set({ status: 'AVAILABLE' })
      .where(eq(requests.id, first.id))
      .run();
    expect((await post(creds, 'album', ALBUM)).statusCode).toBe(201);
  });

  it('409 already_available when the library has every track', async () => {
    seedTracks(h.app, TRACKS);
    const creds = await userWith('u', ALB | REQ);
    const album = await post(creds, 'album', ALBUM);
    expect(album.statusCode).toBe(409);
    expect(album.json<{ error: { code: string } }>().error.code).toBe('already_available');
    const track = await post(creds, 'track', TRACKS[0]);
    expect(track.json<{ error: { code: string } }>().error.code).toBe('already_available');
    expect(h.app.hearer.database.db.select().from(requests).all()).toHaveLength(0);
  });

  it('a partly-present album can still be requested', async () => {
    seedTracks(h.app, [TRACKS[0]]);
    const creds = await userWith('u', ALB);
    expect((await post(creds, 'album', ALBUM)).statusCode).toBe(201);
  });
});

describe('auto-approve', () => {
  it('AUTO_APPROVE creates an APPROVED request, queues submit and records both steps', async () => {
    const creds = await userWith('auto', ALB | Permission.AUTO_APPROVE);
    const created = (await post(creds, 'album', ALBUM)).json<RequestDto>();
    expect(created.status).toBe('APPROVED');
    expect(created.decidedBy?.username).toBe('auto');
    expect(queuedJobs(h.app, 'requests.submit')).toHaveLength(1);
    const detail = (await call(h.app, creds, 'GET', `/api/v1/requests/${created.id}`)).json<{
      events: { fromStatus: string | null; toStatus: string; note: string | null }[];
    }>();
    expect(detail.events.map((e) => [e.fromStatus, e.toStatus, e.note])).toEqual([
      [null, 'PENDING', 'Requested'],
      ['PENDING', 'APPROVED', 'Auto-approved'],
    ]);
  });

  it('without AUTO_APPROVE the request waits and nothing is queued', async () => {
    const creds = await userWith('plain', ALB);
    const created = (await post(creds, 'album', ALBUM)).json<RequestDto>();
    expect(created.status).toBe('PENDING');
    expect(created.decidedBy).toBeNull();
    expect(queuedJobs(h.app, 'requests.submit')).toHaveLength(0);
  });

  it('auto-approve is a permission, not tied to a provider (Manual and Lidarr alike)', async () => {
    h.app.hearer.settings.set('fulfillment', {
      manual: { enabled: false },
      lidarr: { enabled: true, url: 'http://127.0.0.1:1', apiKey: 'k' },
    });
    const creds = await userWith('auto', ALB | Permission.AUTO_APPROVE);
    expect((await post(creds, 'album', ALBUM)).json<RequestDto>().status).toBe('APPROVED');
  });
});

describe('quota', () => {
  const setDefault = (limit: number, days: number) => {
    const current = h.app.hearer.settings.get('general');
    h.app.hearer.settings.set('general', { ...current, defaultRequestQuota: { limit, days } });
  };
  const userId = (name: string) => {
    const row = h.app.hearer.users.getByUsername(name);
    if (!row) throw new Error('no user');
    return row.id;
  };
  const albumIds = [ALBUM, ID(101), ID(102), ID(103)] as const;
  beforeEach(() => {
    for (const [i, id] of albumIds.entries()) {
      if (i > 0) meta.addAlbum(id, `Album ${String(i)}`);
    }
  });

  it('enforces the default limit and answers 429 with limit, used and resetsAt', async () => {
    setDefault(2, 7);
    const creds = await userWith('u', ALB);
    expect((await post(creds, 'album', albumIds[0])).statusCode).toBe(201);
    expect((await post(creds, 'album', albumIds[1])).statusCode).toBe(201);
    const third = await post(creds, 'album', albumIds[2]);
    expect(third.statusCode).toBe(429);
    const err = third.json<{
      error: { code: string; details: { limit: number; used: number; resetsAt: string } };
    }>().error;
    expect(err.code).toBe('quota_exceeded');
    expect(err.details).toMatchObject({ limit: 2, used: 2 });
    const first = h.app.hearer.database.db
      .select()
      .from(requests)
      .orderBy(requests.createdAt)
      .get();
    expect(Date.parse(err.details.resetsAt)).toBe((first?.createdAt.getTime() ?? 0) + 7 * DAY);
    expect(h.app.hearer.database.db.select().from(requests).all()).toHaveLength(2);
  });

  it('limit 0 is unlimited', async () => {
    setDefault(0, 7);
    const creds = await userWith('u', ALB);
    seedRequests(userId('u'), 30, 1000);
    expect((await post(creds, 'album', ALBUM)).statusCode).toBe(201);
    const quota = (await call(h.app, creds, 'GET', '/api/v1/requests/quota')).json<RequestQuota>();
    expect(quota).toMatchObject({ unlimited: true, remaining: null, limit: 0, used: 31 });
  });

  it('counts a rolling window: older requests age out exactly at the boundary', async () => {
    setDefault(1, 3);
    const creds = await userWith('u', ALB);
    const id = userId('u');
    // Just inside the window still counts; just outside it does not.
    seedRequests(id, 1, 3 * DAY - 5_000);
    expect((await post(creds, 'album', ALBUM)).statusCode).toBe(429);
    h.app.hearer.database.db.delete(requests).run();
    seedRequests(id, 1, 3 * DAY + 1);
    expect((await post(creds, 'album', ALBUM)).statusCode).toBe(201);
  });

  it('declined and cancelled requests do not count; failed and available ones do', async () => {
    setDefault(2, 7);
    const creds = await userWith('u', ALB);
    const id = userId('u');
    seedRequests(id, 1, 1000, 'DECLINED');
    seedRequests(id, 1, 1000, 'CANCELLED');
    const quota = () => call(h.app, creds, 'GET', '/api/v1/requests/quota');
    expect((await quota()).json<RequestQuota>().used).toBe(0);
    seedRequests(id, 1, 1000, 'FAILED');
    seedRequests(id, 1, 1000, 'AVAILABLE');
    const q = (await quota()).json<RequestQuota>();
    expect(q).toMatchObject({ used: 2, remaining: 0, limit: 2, days: 7, unlimited: false });
    expect((await post(creds, 'album', ALBUM)).statusCode).toBe(429);
  });

  it('a per-user override beats the default (limit and days independently)', async () => {
    setDefault(1, 7);
    const creds = await userWith('u', ALB);
    const id = userId('u');
    h.app.hearer.database.db
      .update(users)
      .set({ requestQuotaLimit: 3 })
      .where(eq(users.id, id))
      .run();
    seedRequests(id, 2, 1000);
    expect((await post(creds, 'album', ALBUM)).statusCode).toBe(201);
    expect((await post(creds, 'album', albumIds[1])).statusCode).toBe(429);
    // A shorter personal window lets the old requests expire.
    h.app.hearer.database.db
      .update(users)
      .set({ requestQuotaDays: 1 })
      .where(eq(users.id, id))
      .run();
    h.app.hearer.database.db
      .update(requests)
      .set({ createdAt: new Date(Date.now() - 2 * DAY) })
      .run();
    expect((await post(creds, 'album', albumIds[1])).statusCode).toBe(201);
    // A personal 0 means unlimited even when the default is not.
    h.app.hearer.database.db
      .update(users)
      .set({ requestQuotaLimit: 0 })
      .where(eq(users.id, id))
      .run();
    expect((await post(creds, 'album', albumIds[2])).statusCode).toBe(201);
  });

  it('ADMIN and MANAGE_REQUESTS are exempt', async () => {
    setDefault(1, 7);
    seedRequests(userId('admin'), 5, 1000);
    expect((await post(admin, 'album', ALBUM)).statusCode).toBe(201);
    const manager = await userWith('mgr', ALB | Permission.MANAGE_REQUESTS);
    seedRequests(userId('mgr'), 5, 1000);
    expect((await post(manager, 'album', albumIds[1])).statusCode).toBe(201);
    const quota = (
      await call(h.app, manager, 'GET', '/api/v1/requests/quota')
    ).json<RequestQuota>();
    expect(quota.unlimited).toBe(true);
  });

  it('a duplicate is reported before the quota, and a quota refusal leaves nothing behind', async () => {
    setDefault(1, 7);
    const creds = await userWith('u', ALB);
    const other = await userWith('other', ALB);
    await post(other, 'album', ALBUM);
    seedRequests(userId('u'), 1, 1000);
    const dup = await post(creds, 'album', ALBUM);
    expect(dup.json<{ error: { code: string } }>().error.code).toBe('already_requested');
  });

  it('GET /requests/quota reports an empty window with no reset time', async () => {
    setDefault(5, 7);
    const creds = await userWith('u', ALB);
    const quota = (await call(h.app, creds, 'GET', '/api/v1/requests/quota')).json<RequestQuota>();
    expect(quota).toEqual({
      limit: 5,
      days: 7,
      used: 0,
      remaining: 5,
      unlimited: false,
      resetsAt: null,
    });
  });

  it('parallel requests cannot overshoot the quota', async () => {
    setDefault(2, 7);
    const creds = await userWith('u', ALB);
    const results = await Promise.all(albumIds.map((id) => post(creds, 'album', id)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(2);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(2);
    expect(h.app.hearer.database.db.select().from(requests).all()).toHaveLength(2);
  });
});
