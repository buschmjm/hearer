import {
  OK_COMPUTER,
  acoustIdHit,
  eventually,
  expect,
  generateAudio,
  libraryPathOf,
  listFiles,
  mocks,
  restartServer,
  signedInPage,
  taggedLike,
  test,
  type HearerApi,
} from './fixtures.ts';

/**
 * PLAN acceptance 8: killing the server in the middle of an import (SIGKILL, no graceful
 * shutdown) must neither duplicate nor lose the file, and the import must finish exactly once
 * after the restart. The server pauses at a named import step (`HEARER_TEST_IMPORT_PAUSE_*`,
 * honored only under NODE_ENV=test, which the harness uses).
 */
const CASES = [
  {
    // Work file tagged and the destination chosen, nothing moved yet.
    point: 'state-saved',
    track: OK_COMPUTER.tracks.noSurprises,
    libraryFileExistsWhilePaused: false,
  },
  {
    // The file is already in the library; the upload is not announced or marked imported yet.
    point: 'moved',
    track: OK_COMPUTER.tracks.lucky,
    libraryFileExistsWhilePaused: true,
  },
] as const;

interface UploadRow {
  id: string;
  originalName: string;
  status: string;
  libraryPath: string | null;
}

const uploadNamed = async (api: HearerApi, name: string): Promise<UploadRow | undefined> =>
  (await api.get<{ items: UploadRow[] }>('/uploads?all=1&limit=50')).items.find(
    (u) => u.originalName === name,
  );

for (const { point, track, libraryFileExistsWhilePaused } of CASES) {
  test(`restart during import (paused after "${point}"): finishes once, nothing duplicated or lost`, async ({
    api,
    browser,
    runtime,
    scratch,
  }) => {
    test.setTimeout(240_000);
    await api.ensureSetUp();
    await mocks.clearWebhooks();
    await mocks.setAcoustId({ recordings: [acoustIdHit(track)] });
    const name = `restart-${point}.flac`;
    const file = await generateAudio({
      path: scratch(name),
      frequency: 400 + track.position * 10,
      durationSeconds: track.seconds,
      tags: taggedLike(track),
    });
    const expected = libraryPathOf(track);
    const rescansBefore = (await mocks.jellyfinRescans()).length;

    // Restart the server so that it pauses at the chosen step (ten minutes is "forever" here).
    await restartServer({
      HEARER_TEST_IMPORT_PAUSE_MS: '600000',
      HEARER_TEST_IMPORT_PAUSE_AT: point,
    });
    await api.loginAsAdmin();

    // An administrator's confident match is approved automatically and goes straight to import.
    const admin = await signedInPage(
      browser,
      runtime,
      runtime.admin.username,
      runtime.admin.password,
    );
    await admin.page.goto('/upload');
    await admin.page.getByLabel('I have the right to store the music I upload.').check();
    await admin.page.getByLabel('Audio files').setInputFiles(file);

    const importing = await eventually(
      async () => {
        const upload = await uploadNamed(api, name);
        return upload?.status === 'IMPORTING' ? upload : undefined;
      },
      { what: 'the upload to reach IMPORTING', timeoutMs: 90_000 },
    );
    // Give the paused step a moment to be reached, then check where the file is.
    if (libraryFileExistsWhilePaused) {
      await eventually(async () => (await listFiles(runtime.musicDir)).includes(expected), {
        what: 'the file to be in the library already',
      });
    } else {
      expect(await listFiles(runtime.musicDir)).not.toContain(expected);
    }
    await admin.context.close();

    // Crash: SIGKILL, then start again on the same data directory, without the pause.
    await restartServer();
    await api.loginAsAdmin();

    const done = await eventually(
      async () => {
        const upload = await uploadNamed(api, name);
        if (upload?.status === 'FAILED') throw new Error('the import failed after the restart');
        return upload?.status === 'IMPORTED' ? upload : undefined;
      },
      { what: 'the import to finish after the restart', timeoutMs: 120_000 },
    );
    expect(done.id).toBe(importing.id);

    // Exactly one file, at the templated path, with no temp leftovers; staging is cleaned.
    const inLibrary = (await listFiles(runtime.musicDir)).filter((p) => p.includes(track.title));
    expect(inLibrary).toEqual([expected]);
    expect((await listFiles(runtime.musicDir)).filter((p) => p.includes('.hearer-tmp'))).toEqual(
      [],
    );
    await eventually(async () => (await listFiles(runtime.stagingDir)).length === 0, {
      what: 'staging to be empty',
    });
    // Announced exactly once: one upload.imported for it, and Jellyfin was told after the restart.
    const imported = (await mocks.webhooks()).filter(
      (h) =>
        (h.body as { event?: string }).event === 'upload.imported' &&
        JSON.stringify(h.body).includes(track.title),
    );
    expect(imported).toHaveLength(1);
    expect((await mocks.jellyfinRescans()).length).toBeGreaterThan(rescansBefore);
  });
}
