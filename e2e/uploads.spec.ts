import { copyFile, readFile, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import {
  OK_COMPUTER,
  acoustIdHit,
  expect,
  generateAudio,
  libraryPathOf,
  listFiles,
  mocks,
  signedInPage,
  taggedLike,
  test,
  type Runtime,
} from './fixtures.ts';
import type { Page } from '@playwright/test';

const MIB = 1024 * 1024;

/** Tick the notice and drop files on the upload page. */
async function dropFiles(
  page: Page,
  files: string | { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await page.goto('/upload');
  await page.getByLabel('I have the right to store the music I upload.').check();
  await page.getByLabel('Audio files').setInputFiles(files);
}

async function proxyStats(runtime: Runtime): Promise<{
  rejected: number;
  dropped: number;
  forwarded: number;
  maxBodyBytes: number;
}> {
  return (await (await fetch(`${runtime.baseUrl}/__proxy/stats`)).json()) as {
    rejected: number;
    dropped: number;
    forwarded: number;
    maxBodyBytes: number;
  };
}

test.describe('uploads', () => {
  test.beforeEach(async ({ api }) => {
    await api.ensureSetUp();
  });

  test('re-uploading an imported file is flagged as a duplicate', async ({
    browser,
    runtime,
    scratch,
  }) => {
    test.setTimeout(150_000);
    const track = OK_COMPUTER.tracks.karmaPolice;
    await mocks.setAcoustId({ recordings: [acoustIdHit(track)] });
    const original = await generateAudio({
      path: scratch('karma.flac'),
      frequency: 523,
      durationSeconds: track.seconds,
      tags: taggedLike(track),
    });
    const admin = await signedInPage(
      browser,
      runtime,
      runtime.admin.username,
      runtime.admin.password,
    );

    await dropFiles(admin.page, original);
    // An administrator holds every permission, including auto-approve for uploads: a confident
    // match (score at or above the threshold) is imported without a review step.
    await expect(admin.page.getByText('In library')).toBeVisible({ timeout: 90_000 });
    await expect
      .poll(async () => (await listFiles(runtime.musicDir)).includes(libraryPathOf(track)))
      .toBe(true);

    // The very same bytes under another name: detected by checksum.
    const copy = join(runtime.scratchDir, 'karma-again.flac');
    await copyFile(original, copy);
    await dropFiles(admin.page, copy);
    await expect(admin.page.getByText('Duplicate', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await admin.page.getByRole('link', { name: 'Details' }).first().click();
    await expect(admin.page.getByText('This looks like a duplicate')).toBeVisible();
    // Nothing new was filed.
    expect(await listFiles(runtime.musicDir)).toContain(libraryPathOf(track));
    expect(
      (await listFiles(runtime.musicDir)).filter((p) => p.includes('Karma Police')),
    ).toHaveLength(1);
    await admin.context.close();
  });

  test('a hostile file name and title never write outside the library', async ({
    browser,
    runtime,
    scratch,
  }) => {
    test.setTimeout(150_000);
    const track = OK_COMPUTER.tracks.letDown;
    await mocks.setAcoustId({ recordings: [acoustIdHit(track)] });
    const file = await generateAudio({
      path: scratch('hostile-source.flac'),
      frequency: 611,
      durationSeconds: track.seconds,
      tags: { ...taggedLike(track), title: '../../../../etc/passwd' },
    });
    const admin = await signedInPage(
      browser,
      runtime,
      runtime.admin.username,
      runtime.admin.password,
    );
    const before = await listFiles(runtime.musicDir);

    // The browser sends the file under a traversal name.
    await dropFiles(admin.page, {
      name: '../../evil.flac',
      mimeType: 'audio/flac',
      buffer: await readFile(file),
    });
    await expect(admin.page.getByText('Needs review')).toBeVisible({ timeout: 60_000 });
    await admin.page.getByRole('link', { name: 'Review', exact: true }).first().click();
    // And the reviewer (or a hostile tag) puts a traversal string in the title.
    await admin.page.getByLabel('Title', { exact: true }).fill('../../../../etc/passwd');
    await admin.page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(admin.page.getByRole('heading', { name: 'In the library' })).toBeVisible({
      timeout: 60_000,
    });

    const added = (await listFiles(runtime.musicDir)).filter((p) => !before.includes(p));
    expect(added).toHaveLength(1);
    const [relative] = added;
    expect(relative).toBeDefined();
    // Still under the template's folders, with no parent-directory segment anywhere.
    expect(relative).toMatch(/^Radiohead\//);
    expect(relative?.split('/')).not.toContain('..');
    expect(relative).not.toContain('etc/passwd');
    // Nothing escaped next to the library or into the filesystem root of the run.
    const root = dirname(runtime.musicDir);
    expect(
      await listFiles(root).then((all) =>
        all.filter((p) => /evil|passwd/.test(p) && !p.startsWith('music/')),
      ),
    ).toEqual([]);
    await admin.context.close();
  });

  test('a ~130 MB WAV goes through a proxy with a 100 MB body cap, and resumes after a dropped connection', async ({
    api,
    browser,
    runtime,
    scratch,
  }) => {
    test.setTimeout(300_000);
    const track = OK_COMPUTER.tracks.exitMusic;
    await mocks.setAcoustId({ recordings: [acoustIdHit(track)] });
    // 44.1 kHz stereo 16-bit PCM is 176.4 kB/s: 740 s is about 130 MB.
    const wav = scratch('big.wav');
    await generateAudio({
      path: wav,
      frequency: 777,
      durationSeconds: 740,
      tags: taggedLike(track),
      extraArgs: ['-ac', '2', '-ar', '44100'],
    });
    const { size } = await stat(wav);
    expect(size).toBeGreaterThan(120 * 1000 * 1000);
    expect(size).toBeLessThan(150 * 1000 * 1000);

    // Control: the proxy really refuses a single body over 100 MB.
    const refused = await new Promise<number>((resolve, reject) => {
      const url = new URL(runtime.baseUrl);
      const req = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          method: 'POST',
          path: '/api/v1/uploads/tus',
          headers: {
            'content-length': String(101 * 1000 * 1000),
            'content-type': 'application/offset+octet-stream',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(refused).toBe(413);

    const before = await proxyStats(runtime);
    // Cut the connection once, in the middle of the next body of 10 MB or more.
    const armed = await fetch(`${runtime.proxyDropOnceUrl}?after=${String(10 * MIB)}`, {
      method: 'POST',
    });
    expect(armed.status).toBe(204);

    const admin = await signedInPage(
      browser,
      runtime,
      runtime.admin.username,
      runtime.admin.password,
    );
    await dropFiles(admin.page, wav);
    // The client retries and resumes; the file is received whole and analyzed.
    await expect(admin.page.getByText('Needs review')).toBeVisible({ timeout: 240_000 });

    const after = await proxyStats(runtime);
    expect(after.dropped - before.dropped).toBe(1);
    // Chunks stayed under 50 MiB, far below the cap, and nothing was refused after the control.
    expect(after.maxBodyBytes).toBeLessThan(50 * MIB);
    expect(after.maxBodyBytes).toBeGreaterThan(10 * MIB);
    expect(after.rejected - before.rejected).toBe(0);

    // The server holds the whole file, byte for byte in size.
    const uploads = await api.get<{ items: { originalName: string; size: number }[] }>(
      '/uploads?all=1&limit=50',
    );
    expect(uploads.items.find((u) => u.originalName === 'big.wav')?.size).toBe(size);
    await admin.context.close();
  });
});
