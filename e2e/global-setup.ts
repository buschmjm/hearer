import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, existsSync } from 'node:fs';
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
  startWebhookReceiver,
  type MockService,
} from './mocks/index.ts';
import { REPO_ROOT, writeRuntime, type Runtime } from './support/runtime.ts';

const exec = promisify(execFile);

const ACOUSTID_KEY = 'e2e-acoustid-key';
const HEALTH_TIMEOUT_MS = 45_000;

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

async function waitForHealth(baseUrl: string, child: ChildProcess, logPath: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Hearer exited with code ${String(child.exitCode)} before it was healthy; see ${logPath}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Hearer did not become healthy within ${String(HEALTH_TIMEOUT_MS / 1000)}s; see ${logPath}`,
  );
}

/**
 * Starts the whole stack for the run: mock Jellyfin, MusicBrainz + Cover Art Archive, AcoustID
 * and a webhook receiver (all in this process), then the built server (`pnpm e2e` builds first)
 * as a child process with temp data, music and staging directories. Returns the teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const serverEntry = join(REPO_ROOT, 'apps', 'server', 'dist', 'index.js');
  const staticDir = join(REPO_ROOT, 'apps', 'web', 'dist');
  for (const required of [serverEntry, join(staticDir, 'index.html')]) {
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
  let server: ChildProcess | undefined;

  const teardown = async (): Promise<void> => {
    if (server?.exitCode === null && server.pid !== undefined) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      const timer = setTimeout(() => server?.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
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

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const serverLog = join(root, 'server.log');
    await writeFile(serverLog, '');
    server = spawn(process.execPath, [serverEntry], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(port),
        BASE_URL: baseUrl,
        DATA_DIR: dataDir,
        MUSIC_DIR: musicDir,
        STAGING_DIR: stagingDir,
        STATIC_DIR: staticDir,
        LOG_LEVEL: 'info',
        LOG_FORMAT: 'json',
        // Specs sign in many times from one address.
        AUTH_RATE_LIMIT_MAX: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = createWriteStream(serverLog);
    server.stdout?.pipe(log);
    server.stderr?.pipe(log);
    // If this process dies without running teardown, do not leave the server behind.
    const child = server;
    process.once('exit', () => child.kill('SIGKILL'));

    await waitForHealth(baseUrl, server, serverLog);
    if (server.pid === undefined) throw new Error('Hearer has no pid');

    const runtime: Runtime = {
      baseUrl,
      serverPid: server.pid,
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
  } catch (err) {
    await teardown();
    throw err;
  }
  return teardown;
}
