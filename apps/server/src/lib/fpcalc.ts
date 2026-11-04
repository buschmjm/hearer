import { execFile } from 'node:child_process';

/** fpcalc is not installed or not executable. Analysis continues without a fingerprint. */
export class FpcalcUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FpcalcUnavailableError';
  }
}

/** fpcalc ran but produced no fingerprint (undecodable audio, timeout, odd output). */
export class FpcalcError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FpcalcError';
  }
}

export interface Fingerprint {
  /** Length of the audio in seconds, as fpcalc measured it (AcoustID wants whole seconds). */
  duration: number;
  /** Compressed Chromaprint string. */
  fingerprint: string;
}

export interface FpcalcOptions {
  /** Executable to run. Default `fpcalc` from PATH. */
  binary?: string;
  timeoutMs?: number;
  /** Seconds of audio to fingerprint. AcoustID needs at most 120. */
  lengthSeconds?: number;
}

export const FPCALC_TIMEOUT_MS = 60_000;
export const FPCALC_LENGTH_SECONDS = 120;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Parse fpcalc's `-json` output. Exported for tests. */
export function parseFpcalcOutput(stdout: string): Fingerprint {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (err) {
    throw new FpcalcError('fpcalc printed output that is not JSON', { cause: err });
  }
  const { duration, fingerprint } = (raw ?? {}) as { duration?: unknown; fingerprint?: unknown };
  if (typeof fingerprint !== 'string' || fingerprint === '') {
    throw new FpcalcError('fpcalc produced no fingerprint');
  }
  const seconds = typeof duration === 'string' ? Number(duration) : duration;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new FpcalcError('fpcalc reported no duration');
  }
  return { duration: seconds, fingerprint };
}

/**
 * Fingerprint one audio file: `fpcalc -json -length 120 <path>` (argument array, no shell, hard
 * timeout). `path` must be absolute so it can never be read as an option.
 */
export function fpcalc(path: string, options: FpcalcOptions = {}): Promise<Fingerprint> {
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(path)) {
    return Promise.reject(new TypeError('fpcalc path must be absolute'));
  }
  const args = ['-json', '-length', String(options.lengthSeconds ?? FPCALC_LENGTH_SECONDS), path];
  return new Promise((resolve, reject) => {
    execFile(
      options.binary ?? 'fpcalc',
      args,
      {
        timeout: options.timeoutMs ?? FPCALC_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (error) {
          const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          if (e.code === 'ENOENT' || e.code === 'EACCES') {
            reject(
              new FpcalcUnavailableError(
                'fpcalc (Chromaprint) is not installed or not executable',
                { cause: error },
              ),
            );
          } else if (e.killed === true || typeof e.signal === 'string') {
            reject(new FpcalcError('fpcalc timed out'));
          } else {
            const detail = stderr.trim().split('\n')[0] ?? '';
            reject(new FpcalcError(`fpcalc failed${detail ? `: ${detail}` : ''}`));
          }
          return;
        }
        try {
          resolve(parseFpcalcOutput(stdout));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
    );
  });
}
