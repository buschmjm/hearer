import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidMediaError, parseProbeOutput } from '../src/lib/ffprobe.ts';
import { PathEscapeError, assertInside, sanitizeFileName } from '../src/lib/paths.ts';
import { validateProbe } from '../src/jobs/uploadProbe.ts';

const fullwidthDots = String.fromCodePoint(0xff0e, 0xff0e);
const fullwidthSlash = String.fromCodePoint(0xff0f);
const fullwidthBackslash = String.fromCodePoint(0xff3c);
const rtlOverride = String.fromCodePoint(0x202e);
const zeroWidth = String.fromCodePoint(0x200b);

describe('sanitizeFileName', () => {
  const cases: [label: string, input: string, expected: string][] = [
    ['plain name is untouched', 'Song Title.flac', 'Song Title.flac'],
    ['unicode name is untouched', 'Björk – Jóga (Live).flac', 'Björk – Jóga (Live).flac'],
    ['unix traversal keeps the last segment', '../../etc/passwd', 'passwd'],
    ['windows traversal keeps the last segment', '..\\..\\windows\\system32\\evil.wav', 'evil.wav'],
    ['traversal with nothing after it', '..\\..\\', FALLBACK()],
    ['only dots', '..', FALLBACK()],
    ['single dot', '.', FALLBACK()],
    ['absolute path', '/etc/shadow', 'shadow'],
    ['drive letter path', 'C:\\Users\\me\\song.mp3', 'song.mp3'],
    [
      'url-encoded traversal stays a literal, harmless name',
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    ],
    [
      'fullwidth dots and slash are normalised then stripped',
      `${fullwidthDots}${fullwidthSlash}${fullwidthDots}${fullwidthSlash}secret.flac`,
      'secret.flac',
    ],
    ['fullwidth backslash', `${fullwidthDots}${fullwidthBackslash}x.wav`, 'x.wav'],
    ['dots inside a name collapse', 'a..b...c.mp3', 'a.b.c.mp3'],
    ['NUL byte removed', 'evil\0.mp3', 'evil.mp3'],
    ['NUL before extension cannot truncate', 'song.mp3\0.exe', 'song.mp3.exe'],
    ['control characters removed', 'a\u0001b\u001fc\u007fd\u0085e.flac', 'abcde.flac'],
    ['newlines removed', 'line1\nline2\r.mp3', 'line1line2.mp3'],
    ['bidi override and zero width removed', `fi${rtlOverride}cod.mp3${zeroWidth}`, 'ficod.mp3'],
    ['leading dots removed', '...hidden.flac', 'hidden.flac'],
    ['leading spaces removed', '   spaced.flac', 'spaced.flac'],
    ['trailing dots and spaces removed', 'trail. . .', 'trail'],
    ['space before the extension is dropped', 'name .flac', 'name.flac'],
    ['reserved characters replaced', 'a<b>c:d"e|f?g*h.mp3', 'a_b_c_d_e_f_g_h.mp3'],
    ['empty string', '', FALLBACK()],
    ['whitespace only', '   \t ', FALLBACK()],
    ['only reserved characters are kept as underscores', '???', '___'],
    ['CON', 'CON', '_CON'],
    ['con with extension, lower case', 'con.wav', '_con.wav'],
    ['PRN', 'PRN.txt', '_PRN.txt'],
    ['AUX mixed case', 'aUx.flac', '_aUx.flac'],
    ['NUL', 'NUL', '_NUL'],
    ['COM1', 'COM1.mp3', '_COM1.mp3'],
    ['COM9', 'com9', '_com9'],
    ['LPT1', 'LPT1.wav', '_LPT1.wav'],
    ['LPT9', 'lpt9.flac', '_lpt9.flac'],
    ['device name with a second extension', 'con.tar.gz', '_con.tar.gz'],
    ['superscript digit device name', 'COM\u00b9.mp3', '_COM1.mp3'],
    ['device name inside a longer name is fine', 'console.mp3', 'console.mp3'],
    ['COM0 is not reserved', 'COM0.mp3', 'COM0.mp3'],
    ['nested path with reserved final name', 'music/CON.flac', '_CON.flac'],
  ];

  it.each(cases)('%s', (_label, input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });

  it('is idempotent', () => {
    for (const [, input] of cases) {
      const once = sanitizeFileName(input);
      expect(sanitizeFileName(once)).toBe(once);
    }
  });

  it('never yields a separator, NUL, a leading dot or a double dot', () => {
    const nasty = [
      '../a',
      'a/../b',
      '....//....//x',
      '\\..\\..\\x',
      '.\\.\\.',
      'x/.',
      'a\u2028b',
      fullwidthDots,
    ];
    for (const input of nasty) {
      const out = sanitizeFileName(input);
      expect(out).not.toMatch(/[/\\\0]/u);
      expect(out.startsWith('.')).toBe(false);
      expect(out).not.toContain('..');
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it('limits the length to 200 UTF-8 bytes and keeps the extension', () => {
    const out = sanitizeFileName(`${'a'.repeat(500)}.flac`);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(200);
    expect(out.endsWith('.flac')).toBe(true);
    expect(out).toBe(`${'a'.repeat(195)}.flac`);
  });

  it('does not split a multi-byte character when truncating', () => {
    const out = sanitizeFileName(`${'é'.repeat(300)}.mp3`); // 2 bytes each
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(200);
    expect(out.endsWith('.mp3')).toBe(true);
    expect(out).not.toContain('\ufffd');
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
    const astral = sanitizeFileName(`${'\u{1d11e}'.repeat(100)}.wav`); // 4 bytes each
    expect(Buffer.byteLength(astral)).toBeLessThanOrEqual(200);
    expect(astral.endsWith('.wav')).toBe(true);
    expect(astral).not.toContain('\ufffd');
  });

  it('truncates a name with no extension and respects a custom limit', () => {
    expect(sanitizeFileName('b'.repeat(300))).toBe('b'.repeat(200));
    expect(sanitizeFileName('abcdefghij.flac', 10)).toBe('abcde.flac');
  });

  it('does not leave a trailing dot after truncation', () => {
    const out = sanitizeFileName(`${'a'.repeat(194)}.${'b'.repeat(10)}`, 195);
    expect(out.endsWith('.')).toBe(false);
  });

  it('keeps an extension-only name usable', () => {
    expect(sanitizeFileName('.mp3')).toBe('mp3');
  });
});

function FALLBACK(): string {
  return 'untitled';
}

describe('assertInside', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'hearer-paths-'));
    root = join(base, 'staging');
    outside = join(base, 'staging-evil');
    mkdirSync(root);
    mkdirSync(outside);
    mkdirSync(join(root, 'sub'));
  });
  afterEach(() => {
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('accepts existing and not-yet-existing paths below the root', () => {
    expect(assertInside(root, join(root, 'sub'))).toContain(`${sep}staging${sep}sub`);
    expect(assertInside(root, join(root, 'new', 'deep', 'file.flac'))).toContain('file.flac');
    expect(assertInside(root, 'relative/file.flac')).toContain('file.flac');
  });

  it('rejects traversal', () => {
    for (const candidate of [
      '../x',
      '../../etc/passwd',
      'sub/../../x',
      join(root, '..', 'x'),
      '/etc/passwd',
    ]) {
      expect(() => assertInside(root, candidate), candidate).toThrow(PathEscapeError);
    }
  });

  it('rejects a sibling that merely shares the prefix', () => {
    expect(() => assertInside(root, join(outside, 'f.flac'))).toThrow(PathEscapeError);
    expect(() => assertInside(root, `${root}-evil/f.flac`)).toThrow(PathEscapeError);
  });

  it('rejects the root itself unless allowed', () => {
    expect(() => assertInside(root, root)).toThrow(PathEscapeError);
    expect(() => assertInside(root, '.')).toThrow(PathEscapeError);
    expect(assertInside(root, root, { allowRoot: true })).toBeTruthy();
  });

  it('rejects NUL bytes', () => {
    expect(() => assertInside(root, 'a\0b')).toThrow(PathEscapeError);
  });

  it('rejects a symlinked directory that points outside, even for a new file below it', () => {
    symlinkSync(outside, join(root, 'link'));
    expect(() => assertInside(root, join(root, 'link', 'new.flac'))).toThrow(PathEscapeError);
    expect(() => assertInside(root, 'link')).toThrow(PathEscapeError);
  });

  it('rejects a symlinked file that points outside', () => {
    writeFileSync(join(outside, 'secret'), 'x');
    symlinkSync(join(outside, 'secret'), join(root, 'looks-fine.flac'));
    expect(() => assertInside(root, 'looks-fine.flac')).toThrow(PathEscapeError);
  });

  it('accepts a symlink that stays inside', () => {
    symlinkSync(join(root, 'sub'), join(root, 'alias'));
    expect(assertInside(root, 'alias/file.flac')).toContain(`${sep}sub${sep}file.flac`);
  });

  it('works when the root is itself reached through a symlink', () => {
    const viaLink = join(root, '..', 'rootlink');
    symlinkSync(root, viaLink);
    expect(assertInside(viaLink, join(viaLink, 'sub', 'x.flac'))).toContain('x.flac');
    expect(() => assertInside(viaLink, '../staging-evil/x')).toThrow(PathEscapeError);
  });
});

describe('probe parsing and validation', () => {
  const flacProbe = JSON.stringify({
    streams: [
      {
        index: 0,
        codec_type: 'audio',
        codec_name: 'flac',
        channels: 2,
        sample_rate: '44100',
        bits_per_raw_sample: '16',
      },
    ],
    format: { format_name: 'flac', duration: '3.000000', bit_rate: '640000' },
  });

  it('parses ffprobe JSON', () => {
    const parsed = parseProbeOutput(flacProbe);
    expect(parsed).toMatchObject({ formatName: 'flac', durationSeconds: 3, bitRate: 640000 });
    expect(parsed.streams[0]).toMatchObject({
      codecName: 'flac',
      channels: 2,
      sampleRate: 44100,
      bitsPerSample: 16,
    });
  });

  it('accepts a matching file', () => {
    const v = validateProbe(parseProbeOutput(flacProbe), 'flac');
    expect(v).toMatchObject({
      format: 'flac',
      codec: 'flac',
      durationMs: 3000,
      sampleRate: 44100,
      bitrate: 640000,
    });
    expect(v.probe).toMatchObject({ channels: 2, bitsPerSample: 16 });
  });

  it.each([
    [
      'no audio stream',
      {
        streams: [{ codec_type: 'video', codec_name: 'mjpeg' }],
        format: { format_name: 'flac', duration: '3' },
      },
      'flac',
      /no audio stream/,
    ],
    [
      'zero duration',
      {
        streams: [{ codec_type: 'audio', codec_name: 'flac' }],
        format: { format_name: 'flac', duration: '0.000000' },
      },
      'flac',
      /duration/,
    ],
    [
      'missing duration',
      { streams: [{ codec_type: 'audio', codec_name: 'flac' }], format: { format_name: 'flac' } },
      'flac',
      /duration/,
    ],
    [
      'container disagrees with the extension',
      {
        streams: [{ codec_type: 'audio', codec_name: 'flac' }],
        format: { format_name: 'flac', duration: '3' },
      },
      'mp3',
      /does not match \.mp3/,
    ],
    [
      'codec outside the allowlist',
      {
        streams: [{ codec_type: 'audio', codec_name: 'wmav2' }],
        format: { format_name: 'wav', duration: '3' },
      },
      'wav',
      /not accepted/,
    ],
    [
      'opus extension holding vorbis',
      {
        streams: [{ codec_type: 'audio', codec_name: 'vorbis' }],
        format: { format_name: 'ogg', duration: '3' },
      },
      'opus',
      /not accepted/,
    ],
    [
      'unknown extension',
      {
        streams: [{ codec_type: 'audio', codec_name: 'flac' }],
        format: { format_name: 'flac', duration: '3' },
      },
      'txt',
      /not a supported/,
    ],
  ])('rejects %s', (_label, probe, ext, message) => {
    expect(() => validateProbe(parseProbeOutput(JSON.stringify(probe)), ext)).toThrow(
      InvalidMediaError,
    );
    expect(() => validateProbe(parseProbeOutput(JSON.stringify(probe)), ext)).toThrow(message);
  });

  it('maps containers: m4a/aac, ogg/vorbis, ogg-opus, aif to aiff', () => {
    const mk = (format: string, codec: string) =>
      parseProbeOutput(
        JSON.stringify({
          streams: [{ codec_type: 'audio', codec_name: codec }],
          format: { format_name: format, duration: '1' },
        }),
      );
    expect(validateProbe(mk('mov,mp4,m4a,3gp,3g2,mj2', 'aac'), 'm4a').format).toBe('m4a');
    expect(validateProbe(mk('mov,mp4,m4a,3gp,3g2,mj2', 'alac'), 'm4a').format).toBe('m4a');
    expect(validateProbe(mk('ogg', 'vorbis'), 'ogg').format).toBe('ogg');
    expect(validateProbe(mk('ogg', 'opus'), 'opus').format).toBe('opus');
    expect(validateProbe(mk('aiff', 'pcm_s16be'), 'aif').format).toBe('aiff');
  });
});
