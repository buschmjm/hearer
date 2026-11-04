import { MAX_UPLOAD_CHUNK_BYTES, type UploadConfig } from '@hearer/shared';

const MIB = 1024 * 1024;

/** Room left below the server's hard limit for headers and framing. */
export const CHUNK_SAFETY_MARGIN_BYTES = MIB;

/** The tus `chunkSize`: the server's limit, capped at 50 MiB, minus a safety margin. */
export function chunkSizeFor(maxChunkSizeBytes: number): number {
  const cap = Math.min(maxChunkSizeBytes, MAX_UPLOAD_CHUNK_BYTES);
  return Math.max(MIB, cap - CHUNK_SAFETY_MARGIN_BYTES);
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Extensions the server accepts (`aif` rides along with `aiff`, as on the server). */
export function allowedExtensions(config: Pick<UploadConfig, 'allowedFormats'>): Set<string> {
  const set = new Set(config.allowedFormats.map((f) => f.toLowerCase()));
  if (set.has('aiff')) set.add('aif');
  return set;
}

export interface RejectedFile {
  file: File;
  reason: string;
}

export interface ValidationResult {
  accepted: File[];
  rejected: RejectedFile[];
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit] ?? 'TB'}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${String(h)}h ${String(m)}m`;
  if (m > 0) return `${String(m)}m ${String(rest).padStart(2, '0')}s`;
  return `${String(rest)}s`;
}

/**
 * Check files against the server limits before any byte is sent: extension, size, empty files
 * and the remaining quota. `queuedBytes` is what earlier drops still have to send (the server
 * counts a file against the quota when its upload is created).
 */
export function validateFiles(
  files: readonly File[],
  config: UploadConfig,
  queuedBytes = 0,
): ValidationResult {
  const allowed = allowedExtensions(config);
  const maxBytes = config.maxFileSizeMb * MIB;
  let remaining = config.quota.unlimited ? null : (config.quota.remainingBytes ?? 0) - queuedBytes;
  const accepted: File[] = [];
  const rejected: RejectedFile[] = [];
  for (const file of files) {
    const ext = extensionOf(file.name);
    if (!allowed.has(ext)) {
      const list = [...allowed].sort().join(', ');
      rejected.push({
        file,
        reason: ext
          ? `".${ext}" files are not accepted (use ${list})`
          : `Files without an extension are not accepted (use ${list})`,
      });
    } else if (file.size === 0) {
      rejected.push({ file, reason: 'The file is empty' });
    } else if (file.size > maxBytes) {
      rejected.push({
        file,
        reason: `Larger than the ${formatBytes(maxBytes)} limit (${formatBytes(file.size)})`,
      });
    } else if (remaining !== null && file.size > remaining) {
      rejected.push({
        file,
        reason: `Over your upload quota (${formatBytes(Math.max(remaining, 0))} left)`,
      });
    } else {
      if (remaining !== null) remaining -= file.size;
      accepted.push(file);
    }
  }
  return { accepted, rejected };
}

// --- dropped folders ------------------------------------------------------------------------

interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  file?: (ok: (file: File) => void, fail: (err: unknown) => void) => void;
  createReader?: () => {
    readEntries: (ok: (entries: EntryLike[]) => void, fail: (err: unknown) => void) => void;
  };
}

async function walk(entry: EntryLike, out: File[], keep: (file: File) => boolean): Promise<void> {
  if (entry.isFile && entry.file) {
    const read = entry.file.bind(entry);
    const file = await new Promise<File>((ok, fail) => {
      read(ok, fail);
    });
    if (keep(file)) out.push(file);
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    // readEntries returns at most ~100 entries per call; read until it answers empty.
    for (;;) {
      const batch = await new Promise<EntryLike[]>((ok, fail) => {
        reader.readEntries(ok, fail);
      });
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, out, keep);
    }
  }
}

/**
 * Files from a drop event, descending into dropped folders. Inside folders only files with an
 * accepted extension are taken, so cover images and playlists do not clutter the list; files
 * dropped directly are all returned so the person sees why one is refused.
 */
export async function collectDroppedFiles(
  data: DataTransfer,
  folderFileFilter: (file: File) => boolean,
): Promise<File[]> {
  const items = Array.from((data.items as ArrayLike<DataTransferItem> | undefined) ?? []);
  const entries = items
    .map((item) =>
      item.kind === 'file' && typeof item.webkitGetAsEntry === 'function'
        ? (item.webkitGetAsEntry() as EntryLike | null)
        : null,
    )
    .filter((entry): entry is EntryLike => entry !== null);
  if (entries.length === 0) return Array.from(data.files);
  const out: File[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) await walk(entry, out, folderFileFilter);
    else await walk(entry, out, () => true);
  }
  return out;
}

/** "+1.2 s" / "-0.4 s" / "same length" between a candidate and the file. */
export function durationDelta(candidateMs: number | null, fileMs: number | null): string | null {
  if (candidateMs === null || fileMs === null) return null;
  const seconds = (candidateMs - fileMs) / 1000;
  if (Math.abs(seconds) < 0.05) return 'same length';
  return `${seconds > 0 ? '+' : '-'}${Math.abs(seconds).toFixed(1)} s`;
}
