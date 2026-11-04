import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const E2E_ROOT = join(import.meta.dirname, '..');
export const REPO_ROOT = join(E2E_ROOT, '..');
/** Written by global setup, read by specs. Git-ignored. */
export const RUNTIME_FILE = join(E2E_ROOT, '.run', 'runtime.json');

/** Everything a spec needs to know about the stack global setup started. */
export interface Runtime {
  /** Hearer origin, e.g. `http://127.0.0.1:41000`. */
  baseUrl: string;
  serverPid: number;
  /** Temp directories handed to the server (`DATA_DIR`, `MUSIC_DIR`, `STAGING_DIR`). */
  dataDir: string;
  musicDir: string;
  stagingDir: string;
  /** Scratch space for generated audio that specs upload. */
  scratchDir: string;
  /** Server log file (stdout and stderr). */
  serverLog: string;
  jellyfin: {
    url: string;
    apiKey: string;
    serverId: string;
    user: { username: string; password: string };
    /** `GET` it for the recorded `/Library/Media/Updated` calls. */
    rescansUrl: string;
  };
  musicBrainz: { baseUrl: string; coverArtBaseUrl: string };
  acoustId: {
    baseUrl: string;
    apiKey: string;
    /** `POST` partial config JSON here to change what every fingerprint resolves to. */
    configUrl: string;
    lookupsUrl: string;
  };
  webhook: { hookUrl: string; receivedUrl: string };
  /** The admin the API helpers create and the smoke spec's wizard uses. */
  admin: { username: string; password: string };
}

export function writeRuntime(runtime: Runtime): void {
  mkdirSync(dirname(RUNTIME_FILE), { recursive: true });
  writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2));
}

let cached: Runtime | undefined;

export function readRuntime(): Runtime {
  cached ??= JSON.parse(readFileSync(RUNTIME_FILE, 'utf8')) as Runtime;
  return cached;
}
