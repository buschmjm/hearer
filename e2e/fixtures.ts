import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test as base, expect, type Page } from '@playwright/test';
import { SUBSCRIBABLE_NOTIFICATION_EVENTS } from '@hearer/shared';
import type { ReceivedWebhook } from './mocks/index.ts';
import { readRuntime, type Runtime } from './support/runtime.ts';

export { expect };
export { readRuntime, type Runtime };

const run = promisify(execFile);

// ---------------------------------------------------------------------------------------------
// Audio generation (CC0: synthesized tones, nothing copyrighted)
// ---------------------------------------------------------------------------------------------

export interface AudioSpec {
  /** Absolute output path; the extension picks the container (`.flac`, `.mp3`, `.ogg`, ...). */
  path: string;
  /** Tone frequency in Hz. Different tones give different fingerprints and checksums. */
  frequency?: number;
  durationSeconds?: number;
  /** Written as tags. Leave everything out for an untagged file. */
  tags?: {
    title?: string;
    artist?: string;
    albumArtist?: string;
    album?: string;
    track?: number;
    disc?: number;
    date?: string;
    [other: string]: string | number | undefined;
  };
}

/** Generate a sine-tone audio file with ffmpeg. Returns the path. */
export async function generateAudio(spec: AudioSpec): Promise<string> {
  await mkdir(dirname(spec.path), { recursive: true });
  const args = [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${String(spec.frequency ?? 440)}:duration=${String(spec.durationSeconds ?? 3)}`,
    '-map_metadata',
    '-1',
  ];
  const names: Record<string, string> = {
    albumArtist: 'album_artist',
    track: 'track',
    disc: 'disc',
  };
  for (const [key, value] of Object.entries(spec.tags ?? {})) {
    if (value !== undefined) args.push('-metadata', `${names[key] ?? key}=${String(value)}`);
  }
  args.push(spec.path);
  await run('ffmpeg', args);
  return spec.path;
}

// ---------------------------------------------------------------------------------------------
// API client for setup shortcuts and assertions
// ---------------------------------------------------------------------------------------------

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, method: string, path: string, body: unknown) {
    super(`${method} ${path} -> ${String(status)}: ${JSON.stringify(body)}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * A small client for `/api/v1` that keeps the session cookie and CSRF token, so specs can do
 * their set-up through the API and keep the browser for what they actually test.
 */
export class HearerApi {
  #cookie = '';
  #csrf = '';

  readonly runtime: Runtime;

  constructor(runtime: Runtime = readRuntime()) {
    this.runtime = runtime;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.#cookie) headers.cookie = this.#cookie;
    if (this.#csrf && method !== 'GET') headers['x-csrf-token'] = this.#csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${this.runtime.baseUrl}/api/v1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = response.headers.getSetCookie().map((c) => c.split(';')[0] ?? '');
    if (set.length > 0) this.#cookie = set.join('; ');
    const text = await response.text();
    const parsed: unknown = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) throw new ApiError(response.status, method, path, parsed);
    return parsed as T;
  }

  get = <T = unknown>(path: string): Promise<T> => this.request<T>('GET', path);
  post = <T = unknown>(path: string, body?: unknown): Promise<T> =>
    this.request<T>('POST', path, body);
  put = <T = unknown>(path: string, body?: unknown): Promise<T> =>
    this.request<T>('PUT', path, body);

  #adopt(session: { csrfToken: string }): void {
    this.#csrf = session.csrfToken;
  }

  async login(username: string, password: string): Promise<void> {
    this.#adopt(await this.post<{ csrfToken: string }>('/auth/login', { username, password }));
  }

  async loginAsAdmin(): Promise<void> {
    await this.login(this.runtime.admin.username, this.runtime.admin.password);
  }

  /** Create the first administrator and stay signed in as it. */
  async createAdmin(): Promise<void> {
    const { username, password } = this.runtime.admin;
    this.#adopt(await this.post<{ csrfToken: string }>('/setup/admin', { username, password }));
  }

  async setupComplete(): Promise<boolean> {
    return (await this.get<{ setupComplete: boolean }>('/setup/status')).setupComplete;
  }

  /**
   * Point the metadata providers at the mock services. Hearer talks to MusicBrainz, the Cover Art
   * Archive and AcoustID only through these URLs, so a spec can never reach the real services.
   * Needs an admin session.
   */
  async pointMetadataAtMocks(): Promise<void> {
    const { musicBrainz, acoustId } = this.runtime;
    await this.put('/settings/metadata', {
      musicBrainzBaseUrl: musicBrainz.baseUrl,
      coverArtBaseUrl: musicBrainz.coverArtBaseUrl,
      acoustIdApiKey: acoustId.apiKey,
      acoustIdBaseUrl: acoustId.baseUrl,
    });
  }

  /** Save the mock Jellyfin as the media server and allow Jellyfin sign-in. Needs an admin session. */
  async pointMediaServerAtMock(): Promise<void> {
    const { jellyfin } = this.runtime;
    await this.put('/settings/mediaServer', {
      type: 'jellyfin',
      url: jellyfin.url,
      apiKey: jellyfin.apiKey,
      serverId: jellyfin.serverId,
    });
    const auth = await this.get<Record<string, unknown>>('/settings/auth');
    await this.put('/settings/auth', { ...auth, jellyfinEnabled: true });
  }

  /** Add (or reuse) a webhook notification target for the receiver, subscribed to every event. */
  async addWebhookTarget(): Promise<string> {
    const name = 'E2E webhook';
    const { targets } = await this.get<{ targets: { id: string; name: string }[] }>(
      '/notifications/targets',
    );
    const existing = targets.find((t) => t.name === name);
    if (existing) return existing.id;
    const created = await this.post<{ id: string }>('/notifications/targets', {
      name,
      agent: 'webhook',
      config: { url: this.runtime.webhook.hookUrl },
      events: [...SUBSCRIBABLE_NOTIFICATION_EVENTS],
      enabled: true,
    });
    return created.id;
  }

  /**
   * Bring a fresh server to "set up and wired to the mocks" through the API (the same calls the
   * wizard makes), or just wire an already set-up one. Leaves the client signed in as the admin.
   */
  async ensureSetUp(): Promise<void> {
    if (await this.setupComplete()) {
      await this.loginAsAdmin();
    } else {
      await this.createAdmin();
      await this.put('/setup/general', { appTitle: 'Hearer' });
      await this.put('/setup/mediaServer', {
        type: 'jellyfin',
        url: this.runtime.jellyfin.url,
        apiKey: this.runtime.jellyfin.apiKey,
      });
      await this.put('/setup/library', {});
      await this.put('/setup/uploads', {});
      await this.post('/setup/complete');
    }
    await this.pointMetadataAtMocks();
    await this.pointMediaServerAtMock();
    await this.addWebhookTarget();
  }

  /** Queue a library sync and wait until the index reflects the music directory. */
  async syncLibrary(): Promise<void> {
    await this.post('/library/sync');
  }
}

// ---------------------------------------------------------------------------------------------
// Mock service helpers
// ---------------------------------------------------------------------------------------------

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok)
    throw new Error(`${init?.method ?? 'GET'} ${url} -> ${String(response.status)}`);
  return (await response.json()) as T;
}

export const mocks = {
  webhooks: (runtime: Runtime = readRuntime()): Promise<ReceivedWebhook[]> =>
    json(runtime.webhook.receivedUrl),
  clearWebhooks: async (runtime: Runtime = readRuntime()): Promise<void> => {
    await fetch(runtime.webhook.receivedUrl, { method: 'DELETE' });
  },
  jellyfinRescans: (
    runtime: Runtime = readRuntime(),
  ): Promise<{ method: string; path: string; body: unknown }[]> =>
    json(runtime.jellyfin.rescansUrl),
  /** Change what every AcoustID fingerprint resolves to (partial `AcoustIdConfig`). */
  setAcoustId: async (config: object, runtime: Runtime = readRuntime()): Promise<void> => {
    await fetch(runtime.acoustId.configUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    });
  },
};

/** Poll until `check` returns a value (not undefined/false), or fail after `timeoutMs`. */
export async function eventually<T>(
  check: () => Promise<T | undefined | false> | T | undefined | false,
  { timeoutMs = 20_000, intervalMs = 250, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------------------------
// UI helpers and Playwright fixtures
// ---------------------------------------------------------------------------------------------

/** Sign in through the login page's local form. */
export async function signInViaUi(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeHidden();
}

/** Sign out through the account menu. */
export async function signOutViaUi(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /^Account menu for / })
    .filter({ visible: true })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

export const test = base.extend<{
  runtime: Runtime;
  /** Fresh API client (not signed in). */
  api: HearerApi;
  /** Where generated audio for this test can be written. */
  scratch: (name: string) => string;
}>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take a destructured first argument
  runtime: async ({}, use) => {
    await use(readRuntime());
  },
  baseURL: async ({ runtime }, use) => {
    await use(runtime.baseUrl);
  },
  api: async ({ runtime }, use) => {
    await use(new HearerApi(runtime));
  },
  scratch: async ({ runtime }, use) => {
    await use((name) => join(runtime.scratchDir, name));
  },
});
