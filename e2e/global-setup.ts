import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  JELLYFIN_API_KEY,
  JELLYFIN_SERVER_ID,
  startAcoustIdMock,
  startJellyfinMock,
  startMusicBrainzMock,
  startProxy,
  startWebhookReceiver,
  type MockService,
} from './mocks/index.ts';
import { reloadRuntime, writeRuntime, type Runtime } from './support/runtime.ts';
import {
  SERVER_ENTRY,
  STATIC_DIR,
  spawnServer,
  stopProcess,
  waitForHealth,
} from './support/server.ts';

const exec = promisify(execFile);

const ACOUSTID_KEY = 'e2e-acoustid-key';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

/** A small solid-colour JPEG, used as the cover for every release. */
async function makeCover(path: string): Promise<Buffer> {
  await exec('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x2f5d8a:s=600x600:d=1',
    '-frames:v',
    '1',
    path,
  ]);
  return readFile(path);
}

/**
 * Starts the whole stack for the run: mock Jellyfin, MusicBrainz + Cover Art Archive, AcoustID
 * and a webhook receiver (all in this process), the built server (`pnpm e2e` builds first) with
 * temp data, music and staging directories, and a reverse proxy with a 100 MB body cap in front
 * of it. Browser and API helpers talk to the proxy. Returns the teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  for (const required of [SERVER_ENTRY, join(STATIC_DIR, 'index.html')]) {
    if (!existsSync(required)) {
      throw new Error(
        `${required} is missing. Run \`pnpm e2e\` (it builds the server and web app first).`,
      );
    }
  }

  const root = await mkdtemp(join(tmpdir(), 'hearer-e2e-'));
  const [dataDir, musicDir, stagingDir, scratchDir] = ['data', 'music', 'staging', 'scratch'].map(
    (n) => join(root, n),
  ) as [string, string, string, string];
  await Promise.all(
    [dataDir, musicDir, stagingDir, scratchDir].map((d) => mkdir(d, { recursive: true })),
  );

  const cover = await makeCover(join(scratchDir, 'cover.jpg'));
  const user = { username: 'e2e-jellyfin', password: 'jellyfin-pass-1' };
  const mocks: MockService[] = [];

  const teardown = async (): Promise<void> => {
    try {
      // The pid may have changed if a spec restarted the server.
      await stopProcess(reloadRuntime().serverPid);
    } catch {
      // no runtime file yet (setup failed early)
    }
    await Promise.all(mocks.map((m) => m.stop()));
    if (process.env.E2E_KEEP !== '1') await rm(root, { recursive: true, force: true });
  };

  try {
    const jellyfin = await startJellyfinMock({
      libraryDir: musicDir,
      users: [{ ...user, admin: false }],
    });
    const musicBrainz = await startMusicBrainzMock(cover);
    const acoustId = await startAcoustIdMock();
    const webhook = await startWebhookReceiver();
    mocks.push(jellyfin, musicBrainz, acoustId, webhook);

    const serverPort = await freePort();
    const directUrl = `http://127.0.0.1:${String(serverPort)}`;
    const proxy = await startProxy({ port: serverPort });
    mocks.push(proxy);

    const serverLog = join(root, 'server.log');
    await writeFile(serverLog, '');
    const serverEnv: Record<string, string> = {
      // `test` enables the import pause hook (restart spec); nothing else differs from production.
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(serverPort),
      BASE_URL: proxy.origin,
      DATA_DIR: dataDir,
      MUSIC_DIR: musicDir,
      STAGING_DIR: stagingDir,
      STATIC_DIR,
      LOG_LEVEL: 'info',
      LOG_FORMAT: 'json',
      // Specs sign in many times from one address.
      AUTH_RATE_LIMIT_MAX: '1000',
    };
    const pid = spawnServer(serverEnv, serverLog);

    const runtime: Runtime = {
      baseUrl: proxy.origin,
      directUrl,
      serverPid: pid,
      serverEnv,
      proxyDropOnceUrl: `${proxy.origin}/__proxy/drop-once`,
      dataDir,
      musicDir,
      stagingDir,
      scratchDir,
      serverLog,
      jellyfin: {
        url: jellyfin.origin,
        apiKey: JELLYFIN_API_KEY,
        serverId: JELLYFIN_SERVER_ID,
        user,
        rescansUrl: `${jellyfin.origin}/__mock/rescans`,
      },
      musicBrainz: {
        baseUrl: musicBrainz.musicBrainzBaseUrl,
        coverArtBaseUrl: musicBrainz.coverArtBaseUrl,
      },
      acoustId: {
        baseUrl: acoustId.acoustIdBaseUrl,
        apiKey: ACOUSTID_KEY,
        configUrl: `${acoustId.origin}/__mock/config`,
        lookupsUrl: `${acoustId.origin}/__mock/lookups`,
      },
      webhook: { hookUrl: webhook.hookUrl, receivedUrl: `${webhook.origin}/received` },
      admin: { username: 'e2e-admin', password: 'e2e-admin-password' },
    };
    writeRuntime(runtime);
    // The server is detached (specs restart it); do not leave it behind if this process dies.
    process.once('exit', () => {
      try {
        process.kill(reloadRuntime().serverPid, 'SIGKILL');
      } catch {
        // already gone
      }
    });
    await waitForHealth(directUrl, pid, serverLog);
  } catch (err) {
    await teardown();
    throw err;
  }
  return teardown;
}
