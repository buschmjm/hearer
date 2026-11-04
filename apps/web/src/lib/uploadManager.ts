import { TUS_PATH } from '@hearer/shared';
import { Upload, type DetailedError } from 'tus-js-client';
import { getCsrfToken } from '../api/client.ts';
import { chunkSizeFor } from './uploadFiles.ts';

/** Where an item is in its life in the browser. What the server does afterwards is polled. */
export type ItemState =
  | 'queued'
  | 'uploading'
  | 'paused'
  /** Every byte arrived; `uploadId` is the Hearer upload. */
  | 'finished'
  | 'error'
  | 'cancelled';

export interface UploadItem {
  id: string;
  file: File;
  name: string;
  size: number;
  batchId: string;
  targetRequestId: string | null;
  state: ItemState;
  bytesUploaded: number;
  /** Bytes per second, smoothed. 0 until two progress events were seen. */
  speed: number;
  /** Seconds left at the current speed, or null while unknown. */
  eta: number | null;
  /** The tus upload continued an earlier, unfinished one (for instance before a page reload). */
  resumed: boolean;
  uploadId: string | null;
  error: string | null;
}

export interface AddOptions {
  targetRequestId?: string | null;
  /** One id per drop session; defaults to a fresh uuid. */
  batchId?: string;
}

export interface ManagerOptions {
  /** Files uploading at once. */
  concurrency?: number;
  csrfToken?: () => string | null;
  now?: () => number;
  /** Delays (ms) between automatic retries after a network error or a 5xx answer. */
  retryDelays?: number[];
}

/** Automatic resume after network trouble: quick at first, then patient. */
export const DEFAULT_RETRY_DELAYS = [0, 1000, 3000, 5000, 10_000, 20_000];

/** A readable message for a tus failure, preferring the server's error envelope. */
export function describeTusError(err: Error): string {
  const detailed = err as Partial<DetailedError>;
  const body = detailed.originalResponse?.getBody();
  if (body) {
    try {
      const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
      if (typeof message === 'string' && message !== '') return message;
    } catch {
      // not JSON; fall through
    }
  }
  const status = detailed.originalResponse?.getStatus();
  if (status === 413) return 'The server refused the file as too large.';
  if (status === 401 || status === 403) return 'You are not allowed to upload (sign in again?).';
  if (status === undefined && detailed.originalResponse === null) {
    return 'The connection was lost. Resume to try again.';
  }
  return err.message || 'The upload failed.';
}

type Listener = () => void;

/**
 * Runs uploads through tus-js-client with a small queue. Lives outside React so uploads keep
 * going while the person browses to another page; components subscribe through
 * `useSyncExternalStore`.
 */
export class UploadManager {
  readonly #concurrency: number;
  readonly #csrf: () => string | null;
  readonly #now: () => number;
  readonly #retryDelays: number[];
  readonly #uploads = new Map<string, Upload>();
  readonly #listeners = new Set<Listener>();
  readonly #lastSample = new Map<string, { at: number; bytes: number }>();
  #items: readonly UploadItem[] = [];
  #chunkSize = chunkSizeFor(50 * 1024 * 1024);
  #endpoint = TUS_PATH;
  #seq = 0;

  constructor(options: ManagerOptions = {}) {
    this.#concurrency = options.concurrency ?? 2;
    this.#csrf = options.csrfToken ?? getCsrfToken;
    this.#now = options.now ?? Date.now;
    this.#retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS;
  }

  /** Apply the server's limits (`GET /uploads/config`). */
  configure(config: { maxChunkSizeBytes: number; tusPath: string }): void {
    this.#chunkSize = chunkSizeFor(config.maxChunkSizeBytes);
    this.#endpoint = config.tusPath;
  }

  get chunkSize(): number {
    return this.#chunkSize;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly UploadItem[] => this.#items;

  /** Bytes of files still waiting to start (not yet counted against the quota by the server). */
  get queuedBytes(): number {
    return this.#items.filter((i) => i.state === 'queued').reduce((sum, i) => sum + i.size, 0);
  }

  add(files: readonly File[], options: AddOptions = {}): UploadItem[] {
    const batchId = options.batchId ?? crypto.randomUUID();
    const created = files.map((file): UploadItem => ({
      id: `u${String((this.#seq += 1))}`,
      file,
      name: file.name,
      size: file.size,
      batchId,
      targetRequestId: options.targetRequestId ?? null,
      state: 'queued',
      bytesUploaded: 0,
      speed: 0,
      eta: null,
      resumed: false,
      uploadId: null,
      error: null,
    }));
    this.#items = [...this.#items, ...created];
    this.#emit();
    this.#pump();
    return created;
  }

  pause(id: string): void {
    const item = this.#find(id);
    if (item?.state !== 'uploading') return;
    this.#patch(id, { state: 'paused', speed: 0, eta: null });
    void this.#uploads.get(id)?.abort(false);
    this.#pump();
  }

  resume(id: string): void {
    const item = this.#find(id);
    if (item?.state !== 'paused' && item?.state !== 'error') return;
    if (item.state === 'error') {
      // A failed tus upload is restarted from scratch; the stored url makes it continue.
      this.#uploads.delete(id);
    }
    this.#patch(id, { state: 'queued', error: null });
    this.#pump();
  }

  /** Stop and delete the upload on the server (tus DELETE), if it was created. */
  cancel(id: string): void {
    const item = this.#find(id);
    if (!item || item.state === 'finished' || item.state === 'cancelled') return;
    const upload = this.#uploads.get(id);
    this.#patch(id, { state: 'cancelled', speed: 0, eta: null });
    if (upload) {
      void upload.abort(true).catch(() => undefined);
      this.#uploads.delete(id);
    }
    this.#pump();
  }

  /** Drop finished, cancelled and failed rows from the list. */
  clearDone(): void {
    this.#items = this.#items.filter(
      (i) => i.state === 'queued' || i.state === 'uploading' || i.state === 'paused',
    );
    this.#emit();
  }

  // --- internals ----------------------------------------------------------------------------

  #find(id: string): UploadItem | undefined {
    return this.#items.find((i) => i.id === id);
  }

  #patch(id: string, patch: Partial<UploadItem>): void {
    this.#items = this.#items.map((i) => (i.id === id ? { ...i, ...patch } : i));
    this.#emit();
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  #pump(): void {
    let active = this.#items.filter((i) => i.state === 'uploading').length;
    for (const item of this.#items) {
      if (active >= this.#concurrency) break;
      if (item.state !== 'queued') continue;
      active += 1;
      this.#begin(item);
    }
  }

  #begin(item: UploadItem): void {
    this.#patch(item.id, { state: 'uploading' });
    this.#lastSample.set(item.id, { at: this.#now(), bytes: item.bytesUploaded });
    const existing = this.#uploads.get(item.id);
    if (existing) {
      existing.start();
      return;
    }
    const metadata: Record<string, string> = { filename: item.name, batchId: item.batchId };
    if (item.targetRequestId) metadata.targetRequestId = item.targetRequestId;
    const headers: Record<string, string> = {};
    const csrf = this.#csrf();
    if (csrf) headers['x-csrf-token'] = csrf;

    const upload = new Upload(item.file, {
      endpoint: this.#endpoint,
      chunkSize: this.#chunkSize,
      retryDelays: this.#retryDelays,
      metadata,
      headers,
      // Keep the url in storage so a reload (or "pause, close, come back") can continue.
      storeFingerprintForResuming: true,
      removeFingerprintOnSuccess: true,
      onProgress: (sent, total) => {
        this.#progress(item.id, sent, total);
      },
      onSuccess: (payload) => {
        const uploadId = payload.lastResponse.getHeader('X-Hearer-Upload-Id') ?? null;
        this.#uploads.delete(item.id);
        this.#patch(item.id, {
          state: 'finished',
          bytesUploaded: item.size,
          speed: 0,
          eta: null,
          uploadId,
        });
        this.#pump();
      },
      onError: (err) => {
        if (this.#find(item.id)?.state !== 'uploading') return;
        this.#patch(item.id, { state: 'error', error: describeTusError(err), speed: 0, eta: null });
        this.#pump();
      },
    });
    this.#uploads.set(item.id, upload);
    void upload
      .findPreviousUploads()
      .then((previous) => {
        const last = previous[0];
        if (last) {
          upload.resumeFromPreviousUpload(last);
          this.#patch(item.id, { resumed: true });
        }
      })
      .catch(() => undefined)
      .then(() => {
        // Paused or cancelled while looking: do not start.
        if (this.#find(item.id)?.state === 'uploading') upload.start();
      });
  }

  #progress(id: string, sent: number, total: number): void {
    const item = this.#find(id);
    if (item?.state !== 'uploading') return;
    const now = this.#now();
    const last = this.#lastSample.get(id) ?? { at: now, bytes: 0 };
    let speed = item.speed;
    const dt = (now - last.at) / 1000;
    if (dt >= 0.25) {
      const instant = Math.max(0, sent - last.bytes) / dt;
      speed = item.speed === 0 ? instant : item.speed * 0.6 + instant * 0.4;
      this.#lastSample.set(id, { at: now, bytes: sent });
    }
    const eta = speed > 0 ? (total - sent) / speed : null;
    this.#patch(id, { bytesUploaded: sent, speed, eta });
  }
}

/** The app-wide manager. */
export const uploadManager = new UploadManager();
