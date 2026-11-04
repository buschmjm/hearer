import {
  Permission,
  type LidarrSettings,
  type RequestDetailDto,
  type RequestDto,
} from '@hearer/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requests } from '../src/db/schema.ts';
import {
  addUser,
  call,
  completeSetup,
  createHarness,
  login,
  type Credentials,
  type Harness,
} from './helpers/auth.ts';
import { LIDARR, LidarrMock, queueFixture } from './helpers/lidarr-mock.ts';
import {
  ALBUM,
  FakeMetadata,
  ID,
  TRACKS,
  queuedJobs,
  recording,
  requestRow,
  runJob,
  seedTracks,
} from './helpers/requests.ts';

// The Lidarr side is the synthesized mock (unverified, see test/fixtures/lidarr/README.md).

let h: Harness;
let mock: LidarrMock;
let meta: FakeMetadata;
let admin: Credentials;

beforeEach(async () => {
  mock = new LidarrMock();
  await mock.start();
  meta = new FakeMetadata();
  // The catalog knows the albums Lidarr is asked about, under their real MusicBrainz ids.
  meta.addAlbum(LIDARR.albumMbid, 'OK Computer');
  meta.addArtist(LIDARR.artistMbid, 'Radiohead');
  h = await createHarness({ deps: { metadata: meta.asProvider() } });
  admin = await completeSetup(h);
});
afterEach(async () => {
  await h.cleanup();
  await mock.stop();
});

const lidarrSettings = (over: Partial<LidarrSettings> = {}): LidarrSettings => ({
  enabled: true,
  url: mock.url,
  apiKey: LIDARR.apiKey,
  rootFolder: '/music',
  qualityProfileId: 1,
  metadataProfileId: 1,
  trackPolicy: 'album',
  ...over,
});
const configure = (lidarr: Partial<LidarrSettings> | null, manual = true) =>
  h.app.hearer.settings.set('fulfillment', {
    manual: { enabled: manual },
    lidarr: lidarr === null ? { enabled: false } : lidarrSettings(lidarr),
  });
const api = (creds: Credentials, method: 'GET' | 'POST', url: string, body?: unknown) =>
  call(h.app, creds, method, `/api/v1${url}`, body);
async function userWith(name: string, permissions: number): Promise<Credentials> {
  await addUser(h.app, name, permissions);
  return login(h.app, name);
}
const detail = async (id: string) =>
  (await api(admin, 'GET', `/requests/${id}`)).json<RequestDetailDto>();
const notes = async (id: string) => (await detail(id)).events.map((e) => e.note);

describe('provider selection', () => {
  const pick = (type: 'track' | 'album' | 'artist') =>
    h.app.hearer.fulfillment.select({ type })?.id ?? null;

  it('Lidarr is off by default, so Manual takes everything', () => {
    for (const type of ['track', 'album', 'artist'] as const) expect(pick(type)).toBe('manual');
  });

  it('an enabled Lidarr takes albums and artists; tracks follow trackPolicy', () => {
    configure({});
    expect(pick('album')).toBe('lidarr');
    expect(pick('artist')).toBe('lidarr');
    expect(pick('track')).toBe('lidarr');
    configure({ trackPolicy: 'skip' });
    expect(pick('track')).toBe('manual');
    expect(pick('album')).toBe('lidarr');
  });

  it('with Manual off a skipped track has nowhere to go', () => {
    configure({ trackPolicy: 'skip' }, false);
    expect(pick('track')).toBeNull();
    expect(pick('album')).toBe('lidarr');
    configure(null, false);
    expect(pick('album')).toBeNull();
  });

  it('exclude moves on to the next provider', () => {
    configure({});
    expect(h.app.hearer.fulfillment.select({ type: 'album' }, { exclude: ['lidarr'] })?.id).toBe(
      'manual',
    );
  });

  it('get() finds a provider even when it is disabled (cancel and poll still need it)', () => {
    expect(h.app.hearer.fulfillment.get('lidarr')?.id).toBe('lidarr');
    expect(h.app.hearer.fulfillment.get('nope')).toBeUndefined();
  });
});

describe('PLAN acceptance #4: request, approve, fulfill', () => {
  it('a non-auto-approve user asks for an album, an admin approves, Lidarr gets a monitored album and AlbumSearch', async () => {
    configure({});
    const user = await userWith('listener', Permission.REQUEST_ALBUM);
    const created = await api(user, 'POST', '/requests', {
      type: 'album',
      mbid: LIDARR.albumMbid,
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<RequestDto>();
    expect(created.json<RequestDto>().status).toBe('PENDING');
    expect(mock.log).toHaveLength(0); // nothing is sent before approval

    expect((await api(admin, 'POST', `/requests/${id}/approve`)).statusCode).toBe(200);
    expect(queuedJobs(h.app, 'requests.submit')).toHaveLength(1);
    await runJob(h.app, 'requests.submit', { requestId: id });

    expect(mock.albums.find((a) => a.foreignAlbumId === LIDARR.albumMbid)?.monitored).toBe(true);
    expect(mock.commands).toMatchObject([{ name: 'AlbumSearch', albumIds: [41] }]);
    const row = requestRow(h.app, id);
    expect(row).toMatchObject({ status: 'PROCESSING', providerId: 'lidarr' });
    expect(JSON.parse(row.providerRef ?? '{}')).toMatchObject({ kind: 'album', albumId: 41 });
    expect((await notes(id)).at(-1)).toContain('started a search');
    // The API never exposes the provider reference.
    expect((await api(user, 'GET', `/requests/${id}`)).body).not.toContain('albumId');
  });

  it('with Lidarr disabled the same flow lands in AWAITING_UPLOAD (Manual)', async () => {
    configure(null);
    const user = await userWith('listener', Permission.REQUEST_ALBUM);
    const { id } = (
      await api(user, 'POST', '/requests', { type: 'album', mbid: LIDARR.albumMbid })
    ).json<RequestDto>();
    await api(admin, 'POST', `/requests/${id}/approve`);
    await runJob(h.app, 'requests.submit', { requestId: id });
    expect(requestRow(h.app, id)).toMatchObject({
      status: 'AWAITING_UPLOAD',
      providerId: 'manual',
    });
    expect(mock.log).toHaveLength(0);
  });

  it('an auto-approve user goes straight to submission', async () => {
    configure({});
    const user = await userWith('trusted', Permission.REQUEST_ARTIST | Permission.AUTO_APPROVE);
    const { id } = (
      await api(user, 'POST', '/requests', { type: 'artist', mbid: LIDARR.artistMbid })
    ).json<RequestDto>();
    await runJob(h.app, 'requests.submit', { requestId: id });
    expect(requestRow(h.app, id).status).toBe('PROCESSING');
    expect(mock.requests('POST', /^artist$/)).toHaveLength(1);
  });

  it('completion comes from the library, not from Lidarr', async () => {
    configure({});
    const user = await userWith('listener', Permission.REQUEST_ALBUM);
    const { id } = (
      await api(user, 'POST', '/requests', { type: 'album', mbid: ALBUM })
    ).json<RequestDto>();
    meta.addAlbum(ALBUM, 'OK Computer');
    await api(admin, 'POST', `/requests/${id}/approve`);
    h.app.hearer.requests.transition(id, 'PROCESSING', {
      patch: { providerId: 'lidarr', providerRef: '{}' },
    });
    // Lidarr claims everything is done; Hearer keeps waiting until the files are indexed.
    mock.commands.push({ id: 1, name: 'AlbumSearch', status: 'completed' });
    await runJob(h.app, 'requests.availability', {});
    expect(requestRow(h.app, id).status).toBe('PROCESSING');
    seedTracks(h.app, TRACKS);
    await runJob(h.app, 'requests.availability', {});
    expect(requestRow(h.app, id).status).toBe('AVAILABLE');
  });
});

describe('requests.submit with Lidarr', () => {
  async function approvedRequest(type: 'track' | 'album' | 'artist', mbid: string) {
    const user = await userWith(
      `u${String(Math.random()).slice(2, 8)}`,
      Permission.REQUEST | Permission.REQUEST_ALBUM | Permission.REQUEST_ARTIST,
    );
    const { id } = (await api(user, 'POST', '/requests', { type, mbid })).json<RequestDto>();
    h.app.hearer.requests.transition(id, 'APPROVED');
    return id;
  }

  it('an album that Lidarr has not imported yet is retried by the runner, then succeeds', async () => {
    configure({});
    mock.holdRefresh = true;
    const id = await approvedRequest('album', LIDARR.albumMbid);
    await expect(runJob(h.app, 'requests.submit', { requestId: id }, 1)).rejects.toThrow(
      /has not imported/,
    );
    expect(requestRow(h.app, id).status).toBe('APPROVED');
    mock.finishRefresh();
    await runJob(h.app, 'requests.submit', { requestId: id }, 2);
    expect(requestRow(h.app, id).status).toBe('PROCESSING');
    expect(mock.requests('POST', /^artist$/)).toHaveLength(1);
  });

  it('gives up after the last attempt with the reason on the timeline', async () => {
    configure({});
    mock.holdRefresh = true;
    const id = await approvedRequest('album', LIDARR.albumMbid);
    await runJob(h.app, 'requests.submit', { requestId: id }, 6);
    expect(requestRow(h.app, id).status).toBe('FAILED');
    expect((await notes(id)).at(-1)).toMatch(
      /Lidarr did not accept the request after 6 attempts: .*has not imported/,
    );
  });

  it('a track goes through its album; with trackPolicy skip it falls back to Manual', async () => {
    configure({});
    const id = await approvedRequest('track', TRACKS[0]);
    // The FakeMetadata parent of TRACKS[0] is ALBUM, which this Lidarr does not know.
    meta.recordings.set(
      TRACKS[0],
      recording(TRACKS[0], 'Airbag', meta.groups.get(LIDARR.albumMbid) ?? null),
    );
    h.app.hearer.database.db
      .update(requests)
      .set({ parentMbid: LIDARR.albumMbid })
      .where(eq(requests.id, id))
      .run();
    await runJob(h.app, 'requests.submit', { requestId: id });
    expect(requestRow(h.app, id)).toMatchObject({ status: 'PROCESSING', providerId: 'lidarr' });
    expect(mock.commands[0]?.name).toBe('AlbumSearch');

    configure({ trackPolicy: 'skip' });
    mock.log.length = 0;
    const second = await approvedRequest('track', TRACKS[1]);
    await runJob(h.app, 'requests.submit', { requestId: second });
    expect(requestRow(h.app, second)).toMatchObject({
      status: 'AWAITING_UPLOAD',
      providerId: 'manual',
    });
    expect(mock.log).toHaveLength(0);
  });

  it('a rejected API key fails the request at once; retry works after fixing the key', async () => {
    configure({ apiKey: 'wrong' });
    const id = await approvedRequest('album', LIDARR.albumMbid);
    await runJob(h.app, 'requests.submit', { requestId: id });
    expect(requestRow(h.app, id).status).toBe('FAILED');
    expect((await notes(id)).at(-1)).toBe('Lidarr: Lidarr rejected the API key');
    configure({});
    expect((await api(admin, 'POST', `/requests/${id}/retry`)).statusCode).toBe(200);
    await runJob(h.app, 'requests.submit', { requestId: id });
    expect(requestRow(h.app, id).status).toBe('PROCESSING');
  });

  it('a Lidarr track on no album falls back to Manual', async () => {
    configure({});
    meta.recordings.set(ID(300), recording(ID(300), 'Loose', null));
    const id = await approvedRequest('track', ID(300));
    await runJob(h.app, 'requests.submit', { requestId: id });
    expect(requestRow(h.app, id)).toMatchObject({
      status: 'AWAITING_UPLOAD',
      providerId: 'manual',
    });
  });

  it('cancelling a Lidarr request unmonitors the album and says so', async () => {
    configure({});
    mock.seedArtist(false, true);
    const id = await approvedRequest('album', LIDARR.albumMbid);
    await runJob(h.app, 'requests.submit', { requestId: id });
    expect(mock.albums.find((a) => a.id === 41)?.monitored).toBe(true);
    const res = await api(admin, 'POST', `/requests/${id}/cancel`);
    expect(res.statusCode).toBe(200);
    expect(mock.albums.find((a) => a.id === 41)?.monitored).toBe(false);
  });

  it('cancel still works when Lidarr is gone, and the timeline records that', async () => {
    configure({});
    mock.seedArtist(false, true);
    const id = await approvedRequest('album', LIDARR.albumMbid);
    await runJob(h.app, 'requests.submit', { requestId: id });
    await mock.stop();
    const res = await api(admin, 'POST', `/requests/${id}/cancel`);
    expect(res.statusCode).toBe(200);
    expect((await notes(id)).at(-1)).toContain('could not withdraw it from Lidarr');
    mock = new LidarrMock();
    await mock.start();
  });
});

describe('requests.poll', () => {
  async function processing() {
    configure({});
    mock.seedArtist(true, true);
    const user = await userWith('listener', Permission.REQUEST_ALBUM);
    const { id } = (
      await api(user, 'POST', '/requests', { type: 'album', mbid: LIDARR.albumMbid })
    ).json<RequestDto>();
    h.app.hearer.requests.transition(id, 'APPROVED');
    await runJob(h.app, 'requests.submit', { requestId: id });
    return id;
  }
  const poll = () => runJob(h.app, 'requests.poll', {});
  const failFirstCommand = (message?: string) => {
    const command = mock.commands[0];
    if (!command) throw new Error('no command yet');
    command.status = 'failed';
    if (message) command.message = message;
  };
  const lidarrNotes = async (id: string) =>
    (await notes(id)).filter((n) => n?.startsWith('Lidarr: '));

  it('is registered', () => {
    expect(h.app.hearer.jobs.registry.has('requests.poll')).toBe(true);
  });

  it('records progress, deduplicated, and a new note only when the detail changes', async () => {
    const id = await processing();
    await poll(); // the AlbumSearch command has completed, queue empty
    await poll();
    expect(await lidarrNotes(id)).toEqual([
      'Lidarr: The Lidarr search finished and nothing is downloading',
    ]);
    mock.queue = queueFixture();
    await poll();
    await poll();
    expect(await lidarrNotes(id)).toEqual([
      'Lidarr: The Lidarr search finished and nothing is downloading',
      'Lidarr: Downloading 1 item (75%)',
    ]);
    // Going back to an earlier state is news again.
    mock.queue = [];
    await poll();
    expect((await lidarrNotes(id)).at(-1)).toBe(
      'Lidarr: The Lidarr search finished and nothing is downloading',
    );
    expect(requestRow(h.app, id).status).toBe('PROCESSING');
  });

  it('a failed search command moves the request to FAILED with the reason', async () => {
    const id = await processing();
    failFirstCommand('No indexers available');
    await poll();
    expect(requestRow(h.app, id).status).toBe('FAILED');
    expect((await notes(id)).at(-1)).toBe(
      'Lidarr: The Lidarr search failed: No indexers available',
    );
  });

  it('skips requests whose provider has no poll, and survives a provider outage', async () => {
    const id = await processing();
    configure({}, true);
    const manual = await userWith('m', Permission.REQUEST_ALBUM);
    mock.holdRefresh = false;
    meta.addAlbum(ID(555), 'Other');
    const other = (
      await api(manual, 'POST', '/requests', { type: 'album', mbid: ID(555) })
    ).json<RequestDto>().id;
    h.app.hearer.requests.transition(other, 'APPROVED');
    h.app.hearer.requests.transition(other, 'PROCESSING', {
      patch: { providerId: 'manual', providerRef: 'manual:x' },
    });
    await mock.stop();
    await poll(); // Lidarr down: logged, nothing thrown, nothing changed
    expect(requestRow(h.app, id).status).toBe('PROCESSING');
    expect(requestRow(h.app, other).status).toBe('PROCESSING');
    mock = new LidarrMock();
    await mock.start();
  });

  it('only looks at PROCESSING requests', async () => {
    const id = await processing();
    h.app.hearer.requests.transition(id, 'PARTIALLY_AVAILABLE');
    mock.log.length = 0;
    await poll();
    expect(mock.log).toHaveLength(0);
  });

  it('ignores a request cancelled while it was being polled', async () => {
    const id = await processing();
    failFirstCommand();
    const original = h.app.hearer.requests.processing.bind(h.app.hearer.requests);
    h.app.hearer.requests.processing = () => {
      const rows = original();
      h.app.hearer.requests.transition(id, 'CANCELLED');
      return rows;
    };
    await poll();
    expect(requestRow(h.app, id).status).toBe('CANCELLED');
  });
});
