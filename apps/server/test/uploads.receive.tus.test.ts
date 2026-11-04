import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import type { UploadDto } from '@hearer/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '../src/db/schema.ts';
import {
  authHeaders,
  makeAudioFixtures,
  startUploadHarness,
  tusCreate,
  tusMetadata,
  tusUpload,
  waitFor,
  writeJunk,
  type AudioFixtures,
  type UploadHarness,
} from './helpers/uploads.ts';

const MIB = 1024 * 1024;
let audio: AudioFixtures;
let ctx: UploadHarness;

beforeAll(() => {
  audio = makeAudioFixtures();
});
afterAll(() => {
  audio.cleanup();
});
beforeEach(async () => {
  ctx = await startUploadHarness();
});
afterEach(async () => {
  await ctx.close();
});

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const tmpFiles = () => {
  const dir = join(ctx.h.stagingDir, 'tmp');
  return existsSync(dir) ? readdirSync(dir) : [];
};
const idOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);
const rowByTus = (url: string) => ctx.h.app.hearer.uploads.getByTusId(idOf(url));

const POST_PROBE = ['RECEIVED', 'ANALYZING', 'NEEDS_REVIEW', 'DUPLICATE', 'FAILED'];

async function settled(id: string, done: (u: UploadDto) => boolean) {
  return waitFor(() => {
    const dto = ctx.h.app.hearer.uploads.getDto(id);
    return dto && done(dto) ? dto : undefined;
  });
}

describe('receiving an upload', () => {
  it('accepts a multi-chunk upload, probes it, and stages the file with its sha256', async () => {
    const source = audio.files.wav;
    const size = statSync(source).size;
    const chunks: number[] = [];
    const { url, uploadId } = await tusUpload(ctx, ctx.alice, source, {
      filename: 'My Song.wav',
      chunkSize: 50_000,
      onChunkComplete: (chunkSize) => chunks.push(chunkSize),
    });
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(uploadId).toMatch(/^[0-9a-f-]{36}$/u);

    const dto = await settled(uploadId ?? '', (u) => u.sha256 !== null);
    expect(dto).toMatchObject({
      originalName: 'My Song.wav',
      size,
      uploaderId: ctx.aliceId,
      format: 'wav',
      codec: 'pcm_s16le',
      sampleRate: 44100,
      channels: 1,
      error: null,
      tusId: idOf(url),
    });
    expect(dto.durationMs).toBeGreaterThan(2900);
    expect(dto.durationMs).toBeLessThan(3100);
    expect(dto.sha256).toBe(sha256(source));

    const staged = join(ctx.h.stagingDir, dto.id, 'My Song.wav');
    expect(existsSync(staged)).toBe(true);
    expect(sha256(staged)).toBe(sha256(source));
    // The tus temp file and its .json sidecar are gone; nothing reached the library.
    expect(tmpFiles()).toEqual([]);
    expect(readdirSync(ctx.h.musicDir)).toEqual([]);
    // The staging path is recorded.
    expect(ctx.h.app.hearer.uploads.get(dto.id)?.stagingPath).toBe(staged);
  });

  it.each(['flac', 'mp3', 'ogg', 'opus', 'wav', 'aiff', 'm4a'] as const)(
    'accepts a real .%s file',
    async (ext) => {
      const { uploadId } = await tusUpload(ctx, ctx.alice, audio.files[ext], {
        filename: `track.${ext}`,
      });
      const dto = await settled(
        uploadId ?? '',
        (u) => u.status !== 'RECEIVING' && (u.sha256 !== null || u.status === 'REJECTED'),
      );
      expect(dto.error).toBeNull();
      // H-14's analyze job may already have picked the upload up.
      expect(POST_PROBE).toContain(dto.status);
      expect(dto.format).toBe(ext);
      expect(dto.durationMs).toBeGreaterThan(2500);
    },
  );

  it('accepts .aif as aiff', async () => {
    const { uploadId } = await tusUpload(ctx, ctx.alice, audio.files.aiff, { filename: 'x.AIF' });
    const dto = await settled(uploadId ?? '', (u) => u.sha256 !== null);
    expect(dto.format).toBe('aiff');
  });

  it('records the batch and target request', async () => {
    const batchId = '5a9bd1c2-6b7e-4a52-9a4e-0b8fd2b4f1aa';
    const { uploadId } = await tusUpload(ctx, ctx.alice, audio.files.flac, {
      filename: 'a.flac',
      metadata: { batchId },
    });
    const dto = await settled(uploadId ?? '', (u) => u.sha256 !== null);
    expect(dto.batchId).toBe(batchId);
  });

  it('works with an API key and no CSRF token', async () => {
    const { secret } = ctx.h.app.hearer.apiKeys.create(ctx.aliceId, 'tus');
    const { res, location } = await tusCreate(
      ctx,
      { cookie: '', csrf: '' },
      1000,
      { filename: 'k.flac' },
      { 'x-api-key': secret, cookie: '' },
    );
    expect(res.status).toBe(201);
    expect(location).toBeTruthy();
  });

  it('keeps a traversal file name inside the staging directory', async () => {
    const hostile = [
      '../../evil.wav',
      '..\\..\\evil2.wav',
      '\u{ff0e}\u{ff0e}\u{ff0f}evil3.wav',
      'CON.wav',
    ];
    const expected = ['evil.wav', 'evil2.wav', 'evil3.wav', '_CON.wav'];
    for (const [i, name] of hostile.entries()) {
      const { uploadId } = await tusUpload(ctx, ctx.alice, audio.files.wav, { filename: name });
      const dto = await settled(uploadId ?? '', (u) => u.sha256 !== null);
      const row = ctx.h.app.hearer.uploads.get(dto.id);
      expect(row?.originalName).toBe(name); // the original is kept for display only
      expect(row?.stagingPath).toBe(join(ctx.h.stagingDir, dto.id, expected[i] ?? ''));
      expect(existsSync(row?.stagingPath ?? '')).toBe(true);
    }
    const parent = join(ctx.h.stagingDir, '..');
    expect(readdirSync(parent).sort()).toEqual(
      ['data', 'music', 'staging'].filter((d) => existsSync(join(parent, d))).sort(),
    );
    expect(existsSync(join(parent, 'evil.wav'))).toBe(false);
  });
});

describe('resuming', () => {
  it('continues after the connection is cut mid-PATCH', async () => {
    const source = audio.files.bigWav;
    const body = readFileSync(source);
    const { res, location } = await tusCreate(ctx, ctx.alice, body.length, { filename: 'big.wav' });
    expect(res.status).toBe(201);
    const url = location ?? '';

    // Send about a fifth of the body, then drop the socket.
    const cut = Math.floor(body.length / 5);
    await new Promise<void>((resolve) => {
      const req = http.request(url, {
        method: 'PATCH',
        headers: {
          ...authHeaders(ctx.alice, 'PATCH'),
          'tus-resumable': '1.0.0',
          'content-type': 'application/offset+octet-stream',
          'upload-offset': '0',
          'content-length': String(body.length),
        },
      });
      req.on('error', () => undefined);
      req.write(body.subarray(0, cut), () => {
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 150);
      });
    });

    const head = () =>
      fetch(url, {
        method: 'HEAD',
        headers: { ...authHeaders(ctx.alice, 'HEAD'), 'tus-resumable': '1.0.0' },
      });
    const offset = await waitFor(async () => {
      const r = await head();
      const value = Number(r.headers.get('upload-offset'));
      return r.status === 200 && value > 0 ? value : undefined;
    });
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(body.length);
    expect((await head()).headers.get('upload-length')).toBe(String(body.length));
    expect(rowByTus(url)?.status).toBe('RECEIVING');

    // The real client resumes from the server's offset.
    const sent: number[] = [];
    const { uploadId } = await tusUpload(ctx, ctx.alice, source, {
      filename: 'big.wav',
      uploadUrl: url,
      chunkSize: 1 * MIB,
      onChunkComplete: (c) => sent.push(c),
    });
    expect(sent.reduce((a, b) => a + b, 0)).toBe(body.length - offset);
    const dto = await settled(uploadId ?? '', (u) => u.sha256 !== null);
    // H-14's analyze job may already have picked the upload up.
    expect(POST_PROBE).toContain(dto.status);
    expect(dto.sha256).toBe(sha256(source));
  });
});

describe('limits', () => {
  const patchHeaders = (extra: Record<string, string>) => ({
    ...authHeaders(ctx.alice, 'PATCH'),
    'tus-resumable': '1.0.0',
    'content-type': 'application/offset+octet-stream',
    'upload-offset': '0',
    ...extra,
  });

  /** Send only the headers of a PATCH that claims a huge body, and read the answer. */
  function claim(url: string, headers: Record<string, string>) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(url, { method: 'PATCH', headers: patchHeaders(headers) }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on('close', () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      });
      req.on('error', reject);
      req.flushHeaders();
    });
  }

  it('rejects a chunk whose Content-Length exceeds 50 MiB with 413 (no body is sent)', async () => {
    const { location } = await tusCreate(ctx, ctx.alice, 200 * MIB, { filename: 'huge.flac' });
    const answer = await claim(location ?? '', { 'content-length': String(50 * MIB + 1) });
    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: 'chunk_too_large' } });
  });

  it('rejects a PATCH without Content-Length (chunked encoding) with 411', async () => {
    const { location } = await tusCreate(ctx, ctx.alice, 1000, { filename: 'c.flac' });
    const answer = await claim(location ?? '', { 'transfer-encoding': 'chunked' });
    expect(answer.status).toBe(411);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: 'length_required' } });
  });

  it('applies the chunk limit to creation-with-upload as well', async () => {
    const answer = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        ctx.tusUrl,
        {
          method: 'POST',
          headers: {
            ...authHeaders(ctx.alice),
            'tus-resumable': '1.0.0',
            'upload-length': String(200 * MIB),
            'content-type': 'application/offset+octet-stream',
            'content-length': String(60 * MIB),
            'upload-metadata': tusMetadata({ filename: 'x.flac' }),
          },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(answer).toBe(413);
    expect(tmpFiles()).toEqual([]);
  });

  it('rejects a file larger than uploads.maxFileSizeMb with 413', async () => {
    ctx.h.app.hearer.settings.set('uploads', { maxFileSizeMb: 1 });
    const { res } = await tusCreate(ctx, ctx.alice, 2 * MIB, { filename: 'big.flac' });
    expect(res.status).toBe(413);
    expect(
      ctx.h.app.hearer.uploads.list({ id: ctx.aliceId } as never, { limit: 10, offset: 0 }).total,
    ).toBe(0);
    const fine = await tusCreate(ctx, ctx.alice, MIB, { filename: 'ok.flac' });
    expect(fine.res.status).toBe(201);
  });

  it('refuses deferred length, zero length and a missing length', async () => {
    const deferred = await fetch(ctx.tusUrl, {
      method: 'POST',
      headers: {
        ...authHeaders(ctx.alice),
        'tus-resumable': '1.0.0',
        'upload-defer-length': '1',
        'upload-metadata': tusMetadata({ filename: 'd.flac' }),
      },
    });
    expect(deferred.status).toBe(400);
    expect(JSON.parse(await deferred.text())).toMatchObject({ error: { code: 'length_required' } });
    expect((await tusCreate(ctx, ctx.alice, 0, { filename: 'z.flac' })).res.status).toBe(400);
    const none = await fetch(ctx.tusUrl, {
      method: 'POST',
      headers: { ...authHeaders(ctx.alice), 'tus-resumable': '1.0.0' },
    });
    expect(none.status).toBe(400);
  });

  it('refuses disallowed extensions and bad metadata with 400', async () => {
    for (const filename of ['song.exe', 'song', 'song.mp3.zip', '.mp3x', 'notes.txt']) {
      const { res } = await tusCreate(ctx, ctx.alice, 1000, { filename });
      expect(res.status, filename).toBe(400);
      expect(JSON.parse(await res.text()), filename).toMatchObject({
        error: { code: 'format_not_allowed' },
      });
    }
    const noName = await tusCreate(ctx, ctx.alice, 1000, {});
    expect(noName.res.status).toBe(400);
    expect(JSON.parse(await noName.res.text())).toMatchObject({
      error: { code: 'filename_required' },
    });
    const badBatch = await tusCreate(ctx, ctx.alice, 1000, { filename: 'a.flac', batchId: 'nope' });
    expect(badBatch.res.status).toBe(400);
    const badRequest = await tusCreate(ctx, ctx.alice, 1000, {
      filename: 'a.flac',
      targetRequestId: '5a9bd1c2-6b7e-4a52-9a4e-0b8fd2b4f1aa',
    });
    expect(badRequest.res.status).toBe(400);
    expect(tmpFiles()).toEqual([]);
  });

  it('does not let a batch id be shared across users', async () => {
    const batchId = '5a9bd1c2-6b7e-4a52-9a4e-0b8fd2b4f1aa';
    expect(
      (await tusCreate(ctx, ctx.alice, 1000, { filename: 'a.flac', batchId })).res.status,
    ).toBe(201);
    const other = await tusCreate(ctx, ctx.bob, 1000, { filename: 'b.flac', batchId });
    expect(other.res.status).toBe(400);
  });

  it('respects the per-user quota, counting in-flight uploads', async () => {
    ctx.h.app.hearer.database.db
      .update(users)
      .set({ uploadQuotaMb: 1, uploadQuotaDays: 7 })
      .where(eq(users.id, ctx.aliceId))
      .run();
    const first = await tusCreate(ctx, ctx.alice, 600_000, { filename: 'a.flac' }); // never sent: in flight
    expect(first.res.status).toBe(201);
    const second = await tusCreate(ctx, ctx.alice, 600_000, { filename: 'b.flac' });
    expect(second.res.status).toBe(403);
    expect(JSON.parse(await second.res.text())).toMatchObject({
      error: { code: 'quota_exceeded' },
    });
    // Within what is left.
    expect((await tusCreate(ctx, ctx.alice, 400_000, { filename: 'c.flac' })).res.status).toBe(201);
    // Another user is unaffected.
    expect((await tusCreate(ctx, ctx.bob, 600_000, { filename: 'd.flac' })).res.status).toBe(201);
    // Cancelling frees the quota.
    const cancel = await fetch(first.location ?? '', {
      method: 'DELETE',
      headers: { ...authHeaders(ctx.alice, 'DELETE'), 'tus-resumable': '1.0.0' },
    });
    expect(cancel.status).toBe(204);
    await waitFor(() => rowByTus(first.location ?? '')?.status === 'REJECTED');
    expect((await tusCreate(ctx, ctx.alice, 600_000, { filename: 'e.flac' })).res.status).toBe(201);
  });

  it('uses the general default quota, lets 0 mean unlimited, and exempts admins', async () => {
    ctx.h.app.hearer.settings.set('general', {
      ...ctx.h.app.hearer.settings.get('general'),
      defaultUploadQuota: { mb: 1, days: 7 },
    });
    expect((await tusCreate(ctx, ctx.bob, 900_000, { filename: 'a.flac' })).res.status).toBe(201);
    expect((await tusCreate(ctx, ctx.bob, 900_000, { filename: 'b.flac' })).res.status).toBe(403);
    // An admin is exempt from the same default.
    expect((await tusCreate(ctx, ctx.admin, 5 * MIB, { filename: 'a.flac' })).res.status).toBe(201);
    // A personal 0 means unlimited even when the default is not.
    ctx.h.app.hearer.database.db
      .update(users)
      .set({ uploadQuotaMb: 0 })
      .where(eq(users.id, ctx.aliceId))
      .run();
    expect((await tusCreate(ctx, ctx.alice, 5 * MIB, { filename: 'u.flac' })).res.status).toBe(201);
  });

  it('only counts uploads inside the quota window', async () => {
    ctx.h.app.hearer.database.db
      .update(users)
      .set({ uploadQuotaMb: 1, uploadQuotaDays: 1 })
      .where(eq(users.id, ctx.aliceId))
      .run();
    const first = await tusCreate(ctx, ctx.alice, 900_000, { filename: 'a.flac' });
    expect(first.res.status).toBe(201);
    expect((await tusCreate(ctx, ctx.alice, 900_000, { filename: 'b.flac' })).res.status).toBe(403);
    // Age the first upload out of the one-day window.
    ctx.h.app.hearer.database.sqlite
      .prepare('update uploads set created_at = created_at - ?, status = ? where uploader_id = ?')
      .run(2 * 86_400_000, 'IMPORTED', ctx.aliceId);
    expect((await tusCreate(ctx, ctx.alice, 900_000, { filename: 'c.flac' })).res.status).toBe(201);
  });
});

describe('validation of content', () => {
  const expectRejected = async (path: string, filename: string, message: RegExp) => {
    const { uploadId } = await tusUpload(ctx, ctx.alice, path, { filename });
    const dto = await settled(uploadId ?? '', (u) => u.status === 'REJECTED');
    expect(dto.error).toMatch(message);
    expect(dto.sha256).toBeNull();
    await waitFor(() => tmpFiles().length === 0);
    expect(existsSync(join(ctx.h.stagingDir, dto.id))).toBe(false);
  };

  it('rejects a text file renamed .mp3 and deletes it', async () => {
    await expectRejected(
      writeJunk(join(audio.dir, 'junk'), 'fake.mp3', 50_000),
      'fake.mp3',
      /readable media|not a/u,
    );
  });

  it('rejects a corrupt (truncated) audio file', async () => {
    const path = join(audio.dir, 'junk', 'trunc.flac');
    writeJunk(join(audio.dir, 'junk'), 'trunc.flac', 10);
    await expectRejected(path, 'trunc.flac', /readable media|not a/u);
  });

  it('rejects real audio whose content does not match the extension', async () => {
    await expectRejected(audio.files.flac, 'liar.mp3', /does not match \.mp3/u);
    await expectRejected(audio.files.wav, 'liar.flac', /does not match \.flac/u);
  });
});

describe('access control', () => {
  const tusHead = (
    url: string,
    creds: typeof ctx.alice | undefined,
    extra: Record<string, string> = {},
  ) =>
    fetch(url, {
      method: 'HEAD',
      headers: { ...(creds ? authHeaders(creds, 'HEAD') : {}), 'tus-resumable': '1.0.0', ...extra },
    });

  it('answers 401 anonymously on every tus method', async () => {
    const { location } = await tusCreate(ctx, ctx.alice, 1000, { filename: 'a.flac' });
    for (const method of ['POST', 'HEAD', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await fetch(location ?? ctx.tusUrl, {
        method,
        headers: { 'tus-resumable': '1.0.0' },
      });
      expect(res.status, method).toBe(401);
    }
    const create = await fetch(ctx.tusUrl, {
      method: 'POST',
      headers: { 'tus-resumable': '1.0.0', 'upload-length': '10' },
    });
    expect(create.status).toBe(401);
  });

  it('answers 403 to a user without the UPLOAD permission', async () => {
    const { addUser, login } = await import('./helpers/auth.ts');
    await addUser(ctx.h.app, 'viewer', 0);
    const viewer = await login(ctx.h.app, 'viewer');
    const { res } = await tusCreate(ctx, viewer, 1000, { filename: 'a.flac' });
    expect(res.status).toBe(403);
    expect((await tusHead(ctx.tusUrl, viewer)).status).toBe(403);
  });

  it("hides one user's upload from another (HEAD/PATCH/DELETE give 404)", async () => {
    const { location } = await tusCreate(ctx, ctx.alice, 1000, { filename: 'a.flac' });
    const url = location ?? '';
    expect((await tusHead(url, ctx.alice)).status).toBe(200);
    expect((await tusHead(url, ctx.bob)).status).toBe(404);
    const patch = await fetch(url, {
      method: 'PATCH',
      headers: {
        ...authHeaders(ctx.bob, 'PATCH'),
        'tus-resumable': '1.0.0',
        'content-type': 'application/offset+octet-stream',
        'upload-offset': '0',
      },
      body: Buffer.alloc(1000),
    });
    expect(patch.status).toBe(404);
    const del = await fetch(url, {
      method: 'DELETE',
      headers: { ...authHeaders(ctx.bob, 'DELETE'), 'tus-resumable': '1.0.0' },
    });
    expect(del.status).toBe(404);
    // Nothing happened to it, and an unknown id looks identical.
    expect(rowByTus(url)?.status).toBe('RECEIVING');
    expect(existsSync(join(ctx.h.stagingDir, 'tmp', idOf(url)))).toBe(true);
    expect((await tusHead(`${ctx.tusUrl}/${'0'.repeat(32)}`, ctx.bob)).status).toBe(404);
    // Even an admin may not drive someone else's tus upload (they can cancel through the JSON API).
    expect((await tusHead(url, ctx.admin)).status).toBe(404);
  });

  it('refuses path-like upload ids', async () => {
    for (const id of ['..', '%2e%2e', '..%2f..%2fetc%2fpasswd', '%00']) {
      const res = await tusHead(`${ctx.tusUrl}/${id}`, ctx.alice);
      expect([400, 404], id).toContain(res.status);
    }
  });

  it('enforces CSRF for cookie sessions on POST, PATCH and DELETE, but not HEAD/OPTIONS', async () => {
    const noCsrf = { cookie: ctx.alice.cookie };
    const create = await fetch(ctx.tusUrl, {
      method: 'POST',
      headers: {
        ...noCsrf,
        'tus-resumable': '1.0.0',
        'upload-length': '1000',
        'upload-metadata': tusMetadata({ filename: 'a.flac' }),
      },
    });
    expect(create.status).toBe(403);
    expect(JSON.parse(await create.text())).toMatchObject({ error: { code: 'csrf_invalid' } });
    const wrong = await fetch(ctx.tusUrl, {
      method: 'POST',
      headers: {
        ...noCsrf,
        'x-csrf-token': 'wrong',
        'tus-resumable': '1.0.0',
        'upload-length': '1000',
      },
    });
    expect(wrong.status).toBe(403);

    const { location } = await tusCreate(ctx, ctx.alice, 1000, { filename: 'a.flac' });
    const patch = await fetch(location ?? '', {
      method: 'PATCH',
      headers: {
        ...noCsrf,
        'tus-resumable': '1.0.0',
        'content-type': 'application/offset+octet-stream',
        'upload-offset': '0',
      },
      body: Buffer.alloc(1000),
    });
    expect(patch.status).toBe(403);
    expect(rowByTus(location ?? '')?.status).toBe('RECEIVING');
    const del = await fetch(location ?? '', {
      method: 'DELETE',
      headers: { ...noCsrf, 'tus-resumable': '1.0.0' },
    });
    expect(del.status).toBe(403);

    expect((await tusHead(location ?? '', { cookie: ctx.alice.cookie, csrf: '' })).status).toBe(
      200,
    );
    const options = await fetch(ctx.tusUrl, { method: 'OPTIONS', headers: noCsrf });
    expect(options.status).toBe(204);
    expect(options.headers.get('tus-version')).toBe('1.0.0');
    expect(options.headers.get('tus-max-size')).toBe(String(2048 * MIB));
    // No cross-origin access is granted.
    expect(options.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('cancelling', () => {
  it('a tus DELETE by the owner removes the partial file and rejects the row', async () => {
    const body = readFileSync(audio.files.wav);
    const { location } = await tusCreate(ctx, ctx.alice, body.length, { filename: 'a.wav' });
    const url = location ?? '';
    const patch = await fetch(url, {
      method: 'PATCH',
      headers: {
        ...authHeaders(ctx.alice, 'PATCH'),
        'tus-resumable': '1.0.0',
        'content-type': 'application/offset+octet-stream',
        'upload-offset': '0',
      },
      body: body.subarray(0, 1000),
    });
    expect(patch.status).toBe(204);
    expect(tmpFiles().length).toBe(2);
    const del = await fetch(url, {
      method: 'DELETE',
      headers: { ...authHeaders(ctx.alice, 'DELETE'), 'tus-resumable': '1.0.0' },
    });
    expect(del.status).toBe(204);
    expect(tmpFiles()).toEqual([]);
    const row = await waitFor(() => {
      const r = rowByTus(url);
      return r?.status === 'REJECTED' ? r : undefined;
    });
    expect(row.error).toBe('cancelled');
    // And the upload cannot be continued.
    const again = await fetch(url, {
      method: 'HEAD',
      headers: { ...authHeaders(ctx.alice, 'HEAD'), 'tus-resumable': '1.0.0' },
    });
    expect(again.status).toBe(404);
  });

  it('PATCH after the row stopped receiving is refused', async () => {
    const { location } = await tusCreate(ctx, ctx.alice, 1000, { filename: 'a.flac' });
    const row = rowByTus(location ?? '');
    ctx.h.app.hearer.database.sqlite
      .prepare("update uploads set status = 'IMPORTED' where id = ?")
      .run(row?.id);
    const patch = await fetch(location ?? '', {
      method: 'PATCH',
      headers: {
        ...authHeaders(ctx.alice, 'PATCH'),
        'tus-resumable': '1.0.0',
        'content-type': 'application/offset+octet-stream',
        'upload-offset': '0',
      },
      body: Buffer.alloc(1000),
    });
    expect(patch.status).toBe(404);
  });
});
