import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chunkSizeFor,
  collectDroppedFiles,
  validateFiles,
  formatBytes,
} from '../src/lib/uploadFiles.ts';
import { UploadManager, describeTusError } from '../src/lib/uploadManager.ts';

const tus = vi.hoisted(() => {
  interface Opts {
    endpoint?: string;
    chunkSize?: number;
    retryDelays?: number[];
    metadata?: Record<string, string>;
    headers?: Record<string, string>;
    onProgress?: (sent: number, total: number) => void;
    onSuccess?: (payload: {
      lastResponse: { getHeader: (n: string) => string | undefined };
    }) => void;
    onError?: (err: Error) => void;
  }
  class FakeUpload {
    static instances: FakeUpload[] = [];
    static previous: object[] = [];
    starts = 0;
    aborts: boolean[] = [];
    resumedFrom: object | null = null;
    constructor(
      public file: File,
      public options: Opts,
    ) {
      FakeUpload.instances.push(this);
    }
    findPreviousUploads() {
      return Promise.resolve(FakeUpload.previous);
    }
    resumeFromPreviousUpload(p: object) {
      this.resumedFrom = p;
    }
    start() {
      this.starts += 1;
    }
    abort(terminate?: boolean) {
      this.aborts.push(terminate === true);
      return Promise.resolve();
    }
    succeed(id = 'srv-1') {
      this.options.onSuccess?.({
        lastResponse: { getHeader: (n) => (n === 'X-Hearer-Upload-Id' ? id : undefined) },
      });
    }
  }
  return { FakeUpload };
});

vi.mock('tus-js-client', () => ({ Upload: tus.FakeUpload }));

const MIB = 1024 * 1024;
const file = (name: string, size = 1000): File => {
  const f = new File(['x'], name);
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const instances = () => tus.FakeUpload.instances;
const at = (i: number): InstanceType<typeof tus.FakeUpload> => {
  const found = instances()[i];
  if (!found) throw new Error(`no upload #${String(i)}`);
  return found;
};

beforeEach(() => {
  tus.FakeUpload.instances = [];
  tus.FakeUpload.previous = [];
});

function manager(now?: () => number) {
  const m = new UploadManager({ csrfToken: () => 'csrf-9', ...(now ? { now } : {}) });
  m.configure({ maxChunkSizeBytes: 50 * MIB, tusPath: '/api/v1/uploads/tus' });
  return m;
}

const config = (over: Record<string, unknown> = {}) => ({
  tusPath: '/api/v1/uploads/tus',
  maxChunkSizeBytes: 50 * MIB,
  maxFileSizeMb: 100,
  allowedFormats: ['flac', 'mp3', 'aiff'],
  quota: { limitMb: 0, days: 7, usedBytes: 0, remainingBytes: null, unlimited: true },
  ...over,
});

describe('chunk size', () => {
  it('stays below the server limit and never above 50 MiB', () => {
    expect(chunkSizeFor(50 * MIB)).toBeLessThan(50 * MIB);
    expect(chunkSizeFor(500 * MIB)).toBeLessThan(50 * MIB);
    expect(chunkSizeFor(10 * MIB)).toBe(9 * MIB);
    expect(chunkSizeFor(100)).toBe(MIB);
  });
});

describe('validateFiles', () => {
  it('rejects bad extensions, empty files, oversize files and files over the quota', () => {
    const cfg = config({
      maxFileSizeMb: 1,
      quota: { limitMb: 5, days: 7, usedBytes: 0, remainingBytes: 1500, unlimited: false },
    });
    const { accepted, rejected } = validateFiles(
      [
        file('a.flac', 1000),
        file('notes.txt', 10),
        file('noext', 10),
        file('empty.mp3', 0),
        file('huge.flac', 2 * MIB),
        file('b.mp3', 600),
        file('c.AIF', 100),
      ],
      cfg,
    );
    expect(accepted.map((f) => f.name)).toEqual(['a.flac', 'c.AIF']);
    const reasons = Object.fromEntries(rejected.map((r) => [r.file.name, r.reason]));
    expect(reasons['notes.txt']).toMatch(/\.txt/);
    expect(reasons.noext).toMatch(/without an extension/);
    expect(reasons['empty.mp3']).toMatch(/empty/);
    expect(reasons['huge.flac']).toMatch(/limit/);
    expect(reasons['b.mp3']).toMatch(/quota/);
  });

  it('counts files that are already queued against the quota', () => {
    const cfg = config({
      quota: { limitMb: 5, days: 7, usedBytes: 0, remainingBytes: 1000, unlimited: false },
    });
    expect(validateFiles([file('a.flac', 600)], cfg, 500).rejected).toHaveLength(1);
    expect(validateFiles([file('a.flac', 600)], cfg, 0).accepted).toHaveLength(1);
  });

  it('formats sizes', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});

describe('collectDroppedFiles', () => {
  it('falls back to dataTransfer.files when entries are unavailable', async () => {
    const f = file('x.flac');
    const files = await collectDroppedFiles(
      { items: [], files: [f] } as unknown as DataTransfer,
      () => true,
    );
    expect(files).toEqual([f]);
  });

  it('walks folders and keeps only accepted files inside them', async () => {
    const song = file('s.flac');
    const cover = file('cover.jpg');
    const fileEntry = (f: File) => ({
      isFile: true,
      isDirectory: false,
      file: (ok: (f: File) => void) => {
        ok(f);
      },
    });
    let read = false;
    const dir = {
      isFile: false,
      isDirectory: true,
      createReader: () => ({
        readEntries: (ok: (e: unknown[]) => void) => {
          ok(read ? [] : [fileEntry(song), fileEntry(cover)]);
          read = true;
        },
      }),
    };
    const dt = {
      files: [],
      items: [{ kind: 'file', webkitGetAsEntry: () => dir }],
    } as unknown as DataTransfer;
    const files = await collectDroppedFiles(dt, (f) => f.name.endsWith('.flac'));
    expect(files.map((f) => f.name)).toEqual(['s.flac']);
  });
});

describe('UploadManager', () => {
  it('starts tus with chunkSize, headers, metadata and retry delays', async () => {
    const m = manager();
    const [a, b] = m.add([file('a.flac'), file('b.flac')], { targetRequestId: 'req-1' });
    await flush();
    expect(instances()).toHaveLength(2);
    const opts = at(0).options;
    expect(opts.endpoint).toBe('/api/v1/uploads/tus');
    expect(opts.chunkSize).toBe(49 * MIB);
    expect(opts.chunkSize).toBeLessThanOrEqual(50 * MIB);
    expect(opts.headers).toEqual({ 'x-csrf-token': 'csrf-9' });
    expect(opts.retryDelays?.length).toBeGreaterThan(2);
    expect(opts.metadata?.filename).toBe('a.flac');
    expect(opts.metadata?.targetRequestId).toBe('req-1');
    // One drop = one batch id, shared by its files.
    expect(opts.metadata?.batchId).toBeTruthy();
    expect(at(1).options.metadata?.batchId).toBe(opts.metadata?.batchId);
    expect(a?.batchId).toBe(b?.batchId);
    expect(at(0).starts).toBe(1);
    // A second drop is a different batch.
    m.add([file('c.flac')]);
    expect(m.getSnapshot()[2]?.batchId).not.toBe(a?.batchId);
  });

  it('omits targetRequestId when none is chosen', async () => {
    const m = manager();
    m.add([file('a.flac')]);
    await flush();
    expect(at(0).options.metadata).not.toHaveProperty('targetRequestId');
  });

  it('uploads two files at a time and starts the next when one finishes', async () => {
    const m = manager();
    m.add([file('1.flac'), file('2.flac'), file('3.flac')]);
    await flush();
    expect(instances()).toHaveLength(2);
    expect(m.getSnapshot().map((i) => i.state)).toEqual(['uploading', 'uploading', 'queued']);
    at(0).succeed('srv-A');
    await flush();
    expect(instances()).toHaveLength(3);
    expect(m.getSnapshot()[0]).toMatchObject({ state: 'finished', uploadId: 'srv-A' });
    expect(m.getSnapshot()[2]?.state).toBe('uploading');
  });

  it('reports progress, speed and ETA', async () => {
    let t = 0;
    const m = manager(() => t);
    m.add([file('a.flac', 1000)]);
    await flush();
    t = 1000;
    at(0).options.onProgress?.(250, 1000);
    const item = m.getSnapshot()[0];
    expect(item?.bytesUploaded).toBe(250);
    expect(item?.speed).toBeCloseTo(250);
    expect(item?.eta).toBeCloseTo(3);
  });

  it('pauses (frees the slot), resumes and cancels with a tus DELETE', async () => {
    const m = manager();
    m.add([file('1.flac'), file('2.flac'), file('3.flac')]);
    await flush();
    const id = m.getSnapshot()[0]?.id ?? '';
    m.pause(id);
    expect(at(0).aborts).toEqual([false]);
    expect(m.getSnapshot()[0]?.state).toBe('paused');
    await flush();
    // The freed slot goes to the third file.
    expect(instances()).toHaveLength(3);
    m.resume(id);
    // No free slot yet: waits in the queue.
    expect(m.getSnapshot()[0]?.state).toBe('queued');
    const thirdId = m.getSnapshot()[2]?.id ?? '';
    m.cancel(thirdId);
    expect(at(2).aborts).toEqual([true]);
    expect(m.getSnapshot()[2]?.state).toBe('cancelled');
    // Resuming reuses the same tus upload object (start() again).
    expect(m.getSnapshot()[0]?.state).toBe('uploading');
    expect(at(0).starts).toBe(2);
    expect(instances()).toHaveLength(3);
  });

  it('cancels a queued file without touching tus', async () => {
    const m = manager();
    m.add([file('1.flac'), file('2.flac'), file('3.flac')]);
    await flush();
    m.cancel(m.getSnapshot()[2]?.id ?? '');
    expect(m.getSnapshot()[2]?.state).toBe('cancelled');
    expect(instances()).toHaveLength(2);
  });

  it('continues a previous unfinished upload of the same file', async () => {
    const previous = { urlStorageKey: 'k', uploadUrl: 'http://x/api/v1/uploads/tus/abc' };
    tus.FakeUpload.previous = [previous];
    const m = manager();
    m.add([file('a.flac')]);
    await flush();
    expect(at(0).resumedFrom).toBe(previous);
    expect(at(0).starts).toBe(1);
    expect(m.getSnapshot()[0]?.resumed).toBe(true);
  });

  it('starts fresh when there is nothing to resume', async () => {
    const m = manager();
    m.add([file('a.flac')]);
    await flush();
    expect(at(0).resumedFrom).toBeNull();
    expect(m.getSnapshot()[0]?.resumed).toBe(false);
  });

  it('shows the server message on failure and can retry', async () => {
    const m = manager();
    m.add([file('a.flac')]);
    await flush();
    const err = Object.assign(new Error('tus: unexpected response'), {
      originalResponse: {
        getStatus: () => 403,
        getBody: () => JSON.stringify({ error: { code: 'quota', message: 'Quota used up' } }),
      },
    });
    at(0).options.onError?.(err);
    expect(m.getSnapshot()[0]).toMatchObject({ state: 'error', error: 'Quota used up' });
    m.resume(m.getSnapshot()[0]?.id ?? '');
    await flush();
    expect(instances()).toHaveLength(2);
    expect(m.getSnapshot()[0]?.state).toBe('uploading');
  });

  it('clears finished and failed rows only', async () => {
    const m = manager();
    m.add([file('1.flac'), file('2.flac'), file('3.flac')]);
    await flush();
    at(0).succeed();
    m.cancel(m.getSnapshot()[1]?.id ?? '');
    m.clearDone();
    expect(m.getSnapshot().map((i) => i.name)).toEqual(['3.flac']);
  });

  it('maps tus errors to readable text', () => {
    expect(describeTusError(new Error('boom'))).toBe('boom');
    const big = Object.assign(new Error('x'), {
      originalResponse: { getStatus: () => 413, getBody: () => '' },
    });
    expect(describeTusError(big)).toMatch(/too large/);
    const offline = Object.assign(new Error('x'), { originalResponse: null });
    expect(describeTusError(offline)).toMatch(/connection/);
  });
});
