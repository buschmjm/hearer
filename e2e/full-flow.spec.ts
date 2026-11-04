import { join } from 'node:path';
import {
  OK_COMPUTER,
  acoustIdHit,
  eventually,
  expect,
  generateAudio,
  libraryPathOf,
  listFiles,
  mocks,
  probeTags,
  signedInPage,
  test,
  taggedLike,
  type ReceivedWebhook,
} from './fixtures.ts';

/**
 * PLAN H-22: wizard/set-up, a regular user requests an album and a track, an admin approves,
 * the user uploads two tracks that fulfil the album request, the files land in the library
 * with MusicBrainz tags, Jellyfin is told, and availability and webhooks follow.
 *
 * The fixture album has 12 tracks. Two uploads therefore make the ALBUM request
 * PARTIALLY_AVAILABLE (the correct outcome, and a real check of the partial logic), while the
 * separate TRACK request for "Paranoid Android" becomes AVAILABLE once the library sync sees it.
 */
const USER = { username: 'listener', password: 'listener-password-1' };

const eventsOf = (hooks: ReceivedWebhook[], event: string): ReceivedWebhook[] =>
  hooks.filter((h) => (h.body as { event?: string }).event === event);
const titlesOf = (hooks: ReceivedWebhook[]): string[] =>
  hooks.map(
    (h) =>
      (h.body as { message: { subject: { title: string } | null } }).message.subject?.title ?? '',
  );

test('request, approve, upload, import, available, webhooks', async ({
  browser,
  api,
  runtime,
  scratch,
}) => {
  test.setTimeout(240_000);
  await api.ensureSetUp();
  await mocks.clearWebhooks();
  // Any fingerprint resolves to both fixture tracks; the tags decide which one is the top match.
  await mocks.setAcoustId({
    recordings: [acoustIdHit(OK_COMPUTER.tracks.airbag), acoustIdHit(OK_COMPUTER.tracks.paranoid)],
  });

  // An administrator creates a regular user (default permissions: request, request album, upload).
  const admin = await signedInPage(
    browser,
    runtime,
    runtime.admin.username,
    runtime.admin.password,
  );
  await admin.page.goto('/admin/users');
  await admin.page.getByRole('button', { name: 'Create user' }).first().click();
  const dialog = admin.page.getByRole('dialog');
  await dialog.getByLabel('Username').fill(USER.username);
  await dialog.getByLabel('Password').fill(USER.password);
  await dialog.getByRole('button', { name: 'Create user' }).click();
  await expect(admin.page.getByText(USER.username).first()).toBeVisible();

  // The user finds the album through search and requests the album and one of its tracks.
  const user = await signedInPage(browser, runtime, USER.username, USER.password);
  await user.page.goto('/search');
  await user.page.getByRole('searchbox', { name: 'Search music' }).fill('OK Computer');
  await user.page.getByRole('link', { name: 'OK Computer' }).first().click();
  await expect(user.page).toHaveURL(/\/albums\//);
  // The cover comes from the configured cover art mirror; the CSP allows that origin.
  await expect
    .poll(() =>
      user.page
        .locator('img[src*="/caa/"]')
        .first()
        .evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth),
    )
    .toBeGreaterThan(0);
  await user.page.getByRole('button', { name: /^Request album: OK Computer/ }).click();
  await expect(user.page.getByText('Requested').first()).toBeVisible();
  await expect(user.page.getByRole('button', { name: /^Request album: OK Computer/ })).toBeHidden();
  const trackButton = user.page.getByRole('button', { name: /^Request track: Paranoid Android/ });
  await trackButton.click();
  await expect(trackButton).toBeHidden();

  // The button flips to "Requested" optimistically; wait for the server to have both.
  await api.waitForRequest('OK Computer', 'album', 'PENDING');
  await api.waitForRequest('Paranoid Android', 'track', 'PENDING');
  await user.page.goto('/requests');
  const albumRow = user.page.getByRole('row', { name: /OK Computer/ });
  await expect(albumRow).toContainText('Pending');
  await expect(user.page.getByRole('row', { name: /Paranoid Android/ })).toContainText('Pending');

  // The admin gets a webhook for each new request, then approves both in the queue.
  await eventually(async () => eventsOf(await mocks.webhooks(), 'request.created').length >= 2, {
    what: 'two request.created webhooks',
  });
  await admin.page.goto('/requests?tab=all');
  await admin.page.getByRole('button', { name: 'Approve OK Computer' }).click();
  await expect(admin.page.getByRole('button', { name: 'Approve OK Computer' })).toBeHidden();
  await admin.page.getByRole('button', { name: 'Approve Paranoid Android' }).click();
  await expect(admin.page.getByRole('button', { name: 'Approve Paranoid Android' })).toBeHidden();

  // Manual fulfillment: both wait for an upload.
  await api.waitForRequest('OK Computer', 'album', 'AWAITING_UPLOAD');
  await api.waitForRequest('Paranoid Android', 'track', 'AWAITING_UPLOAD');
  await eventually(async () => eventsOf(await mocks.webhooks(), 'request.approved').length >= 2, {
    what: 'two request.approved webhooks',
  });
  await user.page.reload();
  await expect(user.page.getByRole('row', { name: /OK Computer/ })).toContainText(
    'Awaiting upload',
  );

  // The user uploads two generated tracks (tagged like the fixture) for the album request.
  const files = [OK_COMPUTER.tracks.airbag, OK_COMPUTER.tracks.paranoid];
  const paths = await Promise.all(
    files.map((track, i) =>
      generateAudio({
        path: scratch(`flow-${String(track.position)}.flac`),
        frequency: 330 + i * 110,
        durationSeconds: track.seconds,
        tags: taggedLike(track),
      }),
    ),
  );
  await user.page.goto('/upload');
  await user.page.getByLabel('I have the right to store the music I upload.').check();
  await user.page
    .getByLabel('Fulfills request')
    .selectOption({ label: 'OK Computer - Radiohead (album)' });
  await user.page.getByLabel('Audio files').setInputFiles(paths);

  // Both files are analyzed and wait for review.
  const batchLink = user.page.getByRole('link', { name: /Review these 2 files together/ });
  await expect(batchLink).toBeVisible({ timeout: 60_000 });
  await expect(user.page.getByText('Needs review')).toHaveCount(2, { timeout: 60_000 });
  const batchHref = await batchLink.getAttribute('href');
  expect(batchHref).toMatch(/^\/uploads\/batch\//);

  // The admin approves the batch in the UI.
  await admin.page.goto(batchHref ?? '/uploads');
  await admin.page.getByRole('button', { name: 'Approve all' }).click();
  await expect(admin.page.getByText(/Approved 2 file\(s\)/)).toBeVisible();

  // Files land at the templated paths, tagged with MusicBrainz ids and a cover.
  const expected = files.map((t) => libraryPathOf(t)).sort();
  await eventually(
    async () => {
      const present = await listFiles(runtime.musicDir);
      return expected.every((p) => present.includes(p)) && present.length === expected.length;
    },
    { what: 'both files in the library', timeoutMs: 90_000 },
  );
  for (const track of files) {
    const { tags } = await probeTags(join(runtime.musicDir, libraryPathOf(track)));
    expect(tags.title).toBe(track.title);
    expect(tags.musicbrainz_trackid).toBe(track.recordingId);
    expect(tags.musicbrainz_albumid).toBe(OK_COMPUTER.releaseId);
    expect(tags.musicbrainz_releasegroupid).toBe(OK_COMPUTER.releaseGroupId);
    expect(tags.musicbrainz_artistid).toBe(OK_COMPUTER.artistId);
  }
  // Staging is cleaned up and Jellyfin was told about the new files.
  await eventually(async () => (await listFiles(runtime.stagingDir)).length === 0, {
    what: 'staging to be empty',
  });
  const rescans = await eventually(
    async () => {
      const calls = await mocks.jellyfinRescans();
      return calls.length >= 1 ? calls : undefined;
    },
    { what: 'a Jellyfin rescan call' },
  );
  expect(JSON.stringify(rescans)).toContain(runtime.musicDir);

  // After a library sync the track is AVAILABLE; the album (2 of 12 tracks) is partial.
  await api.syncLibrary();
  await api.waitForRequest('Paranoid Android', 'track', 'AVAILABLE');
  await api.waitForRequest('OK Computer', 'album', 'PARTIALLY_AVAILABLE');
  await user.page.goto('/requests');
  await expect(user.page.getByRole('row', { name: /Paranoid Android/ })).toContainText('Available');
  await expect(user.page.getByRole('row', { name: /OK Computer/ })).toContainText(
    'Partially available',
  );

  // Webhooks: the track became available, and the album partially so; uploads were reported.
  await eventually(
    async () => {
      const hooks = await mocks.webhooks();
      return (
        titlesOf(eventsOf(hooks, 'request.available')).includes('Paranoid Android') &&
        titlesOf(eventsOf(hooks, 'request.partially_available')).includes('OK Computer') &&
        eventsOf(hooks, 'upload.imported').length >= 2
      );
    },
    { what: 'request.available, request.partially_available and upload.imported webhooks' },
  );

  await admin.context.close();
  await user.context.close();
});
