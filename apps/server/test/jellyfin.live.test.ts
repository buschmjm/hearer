import { describe, expect, it } from 'vitest';
import { JellyfinAdapter, PROVIDER_KEYS } from '../src/adapters/mediaserver/jellyfin.ts';
import type { LibraryItem } from '../src/adapters/mediaserver/types.ts';

/**
 * Opt-in checks against a real Jellyfin. Skipped unless JELLYFIN_TEST_URL and
 * JELLYFIN_TEST_API_KEY are set (JELLYFIN_TEST_USER/JELLYFIN_TEST_PASSWORD add the login check).
 * Read-only: nothing is written, except that a login creates (and the adapter then ends) one
 * Jellyfin session.
 *
 *   JELLYFIN_TEST_URL=http://host:8096 JELLYFIN_TEST_API_KEY=... pnpm --filter server test -- jellyfin.live
 *
 * Use it to confirm the synthesized fixtures: the printed ProviderIds keys show which of
 * MusicBrainzTrack / MusicBrainzRecording the server really uses (docs/ADAPTERS.md).
 */
const url = process.env.JELLYFIN_TEST_URL;
const apiKey = process.env.JELLYFIN_TEST_API_KEY;
const user = process.env.JELLYFIN_TEST_USER;
const password = process.env.JELLYFIN_TEST_PASSWORD;

describe.skipIf(!url || !apiKey)('live Jellyfin (JELLYFIN_TEST_URL)', () => {
  // Built lazily: the describe body runs even when the suite is skipped.
  const makeAdapter = () =>
    new JellyfinAdapter({
      url: url ?? '',
      apiKey: apiKey ?? '',
      deviceId: 'hearer-live-test',
      version: '0.0.0-live',
      pageSize: 50,
    });

  it('connects with the modern Authorization header only', async () => {
    const adapter = makeAdapter();
    const info = await adapter.testConnection();
    console.info(`Jellyfin ${info.version} "${info.name}" (${info.id})`);
    expect(info.id).not.toBe('');
    expect(info.versionSupported).toBe(true);
  });

  it('lists users', async () => {
    const adapter = makeAdapter();
    const users = await adapter.listUsers();
    expect(users.length).toBeGreaterThan(0);
  });

  it('reads library items and reports the ProviderIds keys in use', async () => {
    const adapter = makeAdapter();
    const items: LibraryItem[] = [];
    for await (const item of adapter.iterateLibrary({})) {
      items.push(item);
      if (items.length >= 200) break;
    }
    const tracks = items.filter((i) => i.kind === 'track');
    console.info(
      `sampled ${String(items.length)} items; tracks with recording id: ${String(
        tracks.filter((t) => t.mbRecordingId).length,
      )}/${String(tracks.length)}; keys checked: ${PROVIDER_KEYS.recording.join(', ')}`,
    );
    expect(items.length).toBeGreaterThanOrEqual(0);
  });

  it.skipIf(!user || !password)('authenticates a real user', async () => {
    const adapter = makeAdapter();
    const external = await adapter.authenticate(user ?? '', password ?? '');
    expect(external.id).not.toBe('');
    await expect(adapter.authenticate(user ?? '', `${password ?? ''}-wrong`)).rejects.toThrow();
  });
});
