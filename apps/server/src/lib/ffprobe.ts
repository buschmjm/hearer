import { execFile } from 'node:child_process';

/** The input is not readable media (corrupt, not audio, wrong container). Safe to show the user. */
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}

/** ffprobe could not run (missing binary, timeout, too much output). Retrying may help. */
export class FfprobeUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message);
    this.name = 'FfprobeUnavailableError';
    if (options) this.cause = options.cause;
  }
}

export interface ProbeStream {
  index: number;
  codecType: string;
  codecName: string;
  channels: number | null;
  sampleRate: number | null;
  bitsPerSample: number | null;
  bitRate: number | null;
  durationSeconds: number | null;
}

export interface ProbeResult {
  /** ffprobe `format_name`, a comma-separated list of demuxer aliases. */
  formatName: string;
  durationSeconds: number | null;
  bitRate: number | null;
  streams: ProbeStream[];
}

export interface FfprobeOptions {
  /** Executable to run. Default `ffprobe` from PATH. */
  binary?: string;
  timeoutMs?: number;
}

export const FFPROBE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const num = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

interface RawStream {
  index?: unknown;
  codec_type?: unknown;
  codec_name?: unknown;
  channels?: unknown;
  sample_rate?: unknown;
  bits_per_sample?: unknown;
  bits_per_raw_sample?: unknown;
  bit_rate?: unknown;
  duration?: unknown;
}
interface RawProbe {
  format?: { format_name?: unknown; duration?: unknown; bit_rate?: unknown };
  streams?: RawStream[];
}

/** Map ffprobe's JSON onto the fields Hearer uses. Exported for tests. */
export function parseProbeOutput(json: string): ProbeResult {
  let raw: RawProbe;
  try {
    raw = JSON.parse(json) as RawProbe;
  } catch (err) {
    throw new FfprobeUnavailableError('ffprobe printed output that is not JSON', { cause: err });
  }
  const streams = (raw.streams ?? []).map((s): ProbeStream => ({
    index: num(s.index) ?? 0,
    codecType: typeof s.codec_type === 'string' ? s.codec_type : 'unknown',
    codecName: typeof s.codec_name === 'string' ? s.codec_name : 'unknown',
    channels: num(s.channels),
    sampleRate: num(s.sample_rate),
    bitsPerSample: num(s.bits_per_raw_sample) ?? num(s.bits_per_sample),
    bitRate: num(s.bit_rate),
    durationSeconds: num(s.duration),
  }));
  return {
    formatName: typeof raw.format?.format_name === 'string' ? raw.format.format_name : '',
    durationSeconds: num(raw.format?.duration),
    bitRate: num(raw.format?.bit_rate),
    streams,
  };
}

/**
 * Run ffprobe on one file (argument array, no shell, hard timeout) and return its JSON.
 * A non-zero exit means ffprobe understood nothing about the file: `InvalidMediaError`.
 * A missing binary, a timeout or runaway output is `FfprobeUnavailableError`.
 * `path` must be absolute so it can never be read as an option.
 */
export function ffprobe(path: string, options: FfprobeOptions = {}): Promise<ProbeResult> {
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(path)) {
    return Promise.reject(new TypeError('ffprobe path must be absolute'));
  }
  const args = [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-i',
    path,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      options.binary ?? 'ffprobe',
      args,
      {
        timeout: options.timeoutMs ?? FFPROBE_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (error) {
          const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          if (e.code === 'ENOENT' || e.code === 'EACCES') {
            reject(new FfprobeUnavailableError('ffprobe is not installed or not executable'));
          } else if (
            e.killed === true ||
            typeof e.signal === 'string' ||
            e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ) {
            reject(new FfprobeUnavailableError('ffprobe timed out or produced too much output'));
          } else {
            const detail = stderr.trim().split('\n')[0] ?? '';
            reject(
              new InvalidMediaError(`not a readable media file${detail ? `: ${detail}` : ''}`),
            );
          }
          return;
        }
        try {
          resolve(parseProbeOutput(stdout));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
    );
  });
}
