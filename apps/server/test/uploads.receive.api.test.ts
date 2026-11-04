import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { UploadConfig, UploadDto, UploadListResponse } from '@hearer/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uploadExpireJob } from '../src/jobs/uploadProbe.ts';
import { addUser, call, login } from './helpers/auth.ts';
import {
  makeAudioFixtures,
  startUploadHarness,
  tusCreate,
  tusUpload,
  waitFor,
  type AudioFixtures,
  type UploadHarness,
} from './helpers/uploads.ts';

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

const api = (creds: typeof ctx.alice | undefined, method: 'GET' | 'DELETE', url: string) =>
  call(ctx.h.app, creds, method, `/api/v1${url}`);

async function received(creds: typeof ctx.alice, name = 'a.flac', batchId?: string) {
  const { uploadId } = await tusUpload(ctx, creds, audio.files.flac, {
    filename: name,
    ...(batchId ? { metadata: { batchId } } : {}),
  });
  await waitFor(() => ctx.h.app.hearer.uploads.get(uploadId ?? '')?.sha256);
  return uploadId ?? '';
}

describe('GET /uploads/config', () => {
  it('reports limits, formats and the remaining quota', async () => {
    const res = await api(ctx.alice, 'GET', '/uploads/config');
    expect(res.statusCode).toBe(200);
    const body = res.json<UploadConfig>();
    expect(body.maxChunkSizeBytes).toBe(50 * 1024 * 1024);
    expect(body.maxFileSizeMb).toBe(2048);
    expect(body.allowedFormats).toContain('flac');
    expect(body.tusPath).toBe('/api/v1/uploads/tus');
    expect(body.quota).toMatchObject({ unlimited: true, remainingBytes: null, usedBytes: 0 });

    ctx.h.app.hearer.settings.set('general', {
      ...ctx.h.app.hearer.settings.get('general'),
      defaultUploadQuota: { mb: 1, days: 7 },
    });
    await tusCreate(ctx, ctx.alice, 300_000, { filename: 'a.flac' });
    const after = (await api(ctx.alice, 'GET', '/uploads/config')).json<UploadConfig>();
    expect(after.quota).toMatchObject({
      limitMb: 1,
      days: 7,
      usedBytes: 300_000,
      remainingBytes: 1024 * 1024 - 300_000,
      unlimited: false,
    });
    const admin = (await api(ctx.admin, 'GET', '/uploads/config')).json<UploadConfig>();
    expect(admin.quota.unlimited).toBe(true);
  });
});

describe('listing and reading', () => {
  it('lists only own uploads, paginates and filters', async () => {
    const batch = '5a9bd1c2-6b7e-4a52-9a4e-0b8fd2b4f1aa';
    const a1 = await received(ctx.alice, 'a1.flac', batch);
    await received(ctx.alice, 'a2.flac');
    const b1 = await received(ctx.bob, 'b1.flac');

    const mine = (await api(ctx.alice, 'GET', '/uploads')).json<UploadListResponse>();
    expect(mine.total).toBe(2);
    expect(mine.items.map((i) => i.id)).not.toContain(b1);
    const page = (
      await api(ctx.alice, 'GET', '/uploads?limit=1&offset=1')
    ).json<UploadListResponse>();
    expect(page).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(page.items).toHaveLength(1);
    const byBatch = (
      await api(ctx.alice, 'GET', `/uploads?batchId=${batch}`)
    ).json<UploadListResponse>();
    expect(byBatch.items.map((i) => i.id)).toEqual([a1]);
    const byStatus = (
      await api(ctx.alice, 'GET', '/uploads?status=REJECTED')
    ).json<UploadListResponse>();
    expect(byStatus.total).toBe(0);
    expect((await api(ctx.alice, 'GET', '/uploads?status=BOGUS')).statusCode).toBe(400);
  });

  it('?all=1 needs MANAGE_UPLOADS', async () => {
    await received(ctx.alice);
    await received(ctx.bob);
    expect((await api(ctx.alice, 'GET', '/uploads?all=1')).statusCode).toBe(403);
    const all = (await api(ctx.admin, 'GET', '/uploads?all=1')).json<UploadListResponse>();
    expect(all.total).toBe(2);
    expect(all.items.map((i) => i.uploaderName).sort()).toEqual(['alice', 'bob']);
    // Without ?all, an admin sees only their own.
    expect((await api(ctx.admin, 'GET', '/uploads')).json<UploadListResponse>().total).toBe(0);
  });

  it('GET /uploads/:id is for the owner or a manager; others get 404', async () => {
    const id = await received(ctx.alice);
    const own = await api(ctx.alice, 'GET', `/uploads/${id}`);
    expect(own.statusCode).toBe(200);
    expect(own.json<UploadDto>()).toMatchObject({ id, status: 'RECEIVED', format: 'flac' });
    expect((await api(ctx.bob, 'GET', `/uploads/${id}`)).statusCode).toBe(404);
    expect((await api(ctx.admin, 'GET', `/uploads/${id}`)).statusCode).toBe(200);
    expect(
      (await api(ctx.alice, 'GET', '/uploads/5a9bd1c2-6b7e-4a52-9a4e-0b8fd2b4f1aa')).statusCode,
    ).toBe(404);
    expect((await api(ctx.alice, 'GET', '/uploads/not-a-uuid')).statusCode).toBe(400);
    expect((await api(undefined, 'GET', `/uploads/${id}`)).statusCode).toBe(401);
  });
});

describe('DELETE /uploads/:id (cancel)', () => {
  it('cancels a staged upload and removes its files', async () => {
    const id = await received(ctx.alice);
    const dir = join(ctx.h.stagingDir, id);
    expect(existsSync(dir)).toBe(true);
    const res = await api(ctx.alice, 'DELETE', `/uploads/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json<UploadDto>()).toMatchObject({ status: 'REJECTED', error: 'cancelled' });
    expect(existsSync(dir)).toBe(false);
    expect(ctx.h.app.hearer.uploads.get(id)?.stagingPath).toBeNull();
    // Already cancelled: no longer cancellable.
    expect((await api(ctx.alice, 'DELETE', `/uploads/${id}`)).statusCode).toBe(409);
  });

  it('cancels a half-received upload and clears the tus files', async () => {
    const { location } = await tusCreate(ctx, ctx.alice, 5000, { filename: 'a.flac' });
    const id = ctx.h.app.hearer.uploads.getByTusId(location?.split('/').pop() ?? '')?.id ?? '';
    expect(readdirSync(join(ctx.h.stagingDir, 'tmp'))).toHaveLength(2);
    expect((await api(ctx.alice, 'DELETE', `/uploads/${id}`)).statusCode).toBe(200);
    expect(readdirSync(join(ctx.h.stagingDir, 'tmp'))).toEqual([]);
  });

  it('is limited to the owner or a manager and refuses imported uploads', async () => {
    const id = await received(ctx.alice);
    expect((await api(ctx.bob, 'DELETE', `/uploads/${id}`)).statusCode).toBe(404);
    expect(ctx.h.app.hearer.uploads.get(id)?.status).toBe('RECEIVED');
    ctx.h.app.hearer.database.sqlite
      .prepare("update uploads set status = 'IMPORTING' where id = ?")
      .run(id);
    expect((await api(ctx.alice, 'DELETE', `/uploads/${id}`)).statusCode).toBe(409);
    ctx.h.app.hearer.database.sqlite
      .prepare("update uploads set status = 'NEEDS_REVIEW' where id = ?")
      .run(id);
    expect((await api(ctx.admin, 'DELETE', `/uploads/${id}`)).statusCode).toBe(200);
  });

  it('requires a CSRF token with a cookie session', async () => {
    const id = await received(ctx.alice);
    const res = await ctx.h.app.inject({
      method: 'DELETE',
      url: `/api/v1/uploads/${id}`,
      headers: { cookie: ctx.alice.cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses users without UPLOAD or MANAGE_UPLOADS', async () => {
    await addUser(ctx.h.app, 'viewer', 0);
    const viewer = await login(ctx.h.app, 'viewer');
    for (const url of [
      '/uploads',
      '/uploads/config',
      '/uploads/5a9bd1c2-6b7e-4a52-9a4e-0b8fd2b4f1aa',
    ]) {
      expect((await api(viewer, 'GET', url)).statusCode, url).toBe(403);
    }
  });
});

describe('upload.expire', () => {
  it('rejects RECEIVING uploads whose tus files went stale, and keeps active ones', async () => {
    const stale = await tusCreate(ctx, ctx.alice, 5000, { filename: 'old.flac' });
    const active = await tusCreate(ctx, ctx.alice, 5000, { filename: 'new.flac' });
    const sqlite = ctx.h.app.hearer.database.sqlite;
    const staleRow = ctx.h.app.hearer.uploads.getByTusId(stale.location?.split('/').pop() ?? '');
    const activeRow = ctx.h.app.hearer.uploads.getByTusId(active.location?.split('/').pop() ?? '');
    const old = Date.now() - 2 * 86_400_000;
    sqlite
      .prepare('update uploads set created_at = ? where id in (?, ?)')
      .run(old, staleRow?.id, activeRow?.id);
    // The stale one lost its tus files; the active one still has a fresh file.
    await ctx.h.app.hearer.uploads.removeFiles(staleRow ?? { id: '', tusId: null });
    const job = uploadExpireJob({
      uploads: ctx.h.app.hearer.uploads,
      db: ctx.h.app.hearer.database.db,
      log: ctx.h.app.log,
    });
    await job.handler({}, {} as never);
    expect(ctx.h.app.hearer.uploads.get(staleRow?.id ?? '')).toMatchObject({
      status: 'REJECTED',
      error: 'expired',
    });
    expect(ctx.h.app.hearer.uploads.get(activeRow?.id ?? '')?.status).toBe('RECEIVING');
  });
});
