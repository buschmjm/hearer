import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  DEFAULT_NAMING_TEMPLATE,
  DEFAULT_SINGLES_TEMPLATE,
  settingsDefault,
  validateNamingTemplate,
  type TagSet,
} from '@hearer/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256File } from '../src/lib/atomicMove.ts';
import { assertInside } from '../src/lib/paths.ts';
import {
  renderLibraryPath,
  resolveDestination,
  useSinglesTemplate,
  valuesFromTags,
  withCollisionSuffix,
} from '../src/lib/pathTemplate.ts';
import { SettingsService } from '../src/services/settings.ts';
import { SecretBox } from '../src/lib/secrets.ts';
import { openDatabase, MEMORY_DB } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const TAGS: TagSet = {
  title: 'Paranoid Android',
  artist: 'Radiohead',
  albumArtist: 'Radiohead',
  album: 'OK Computer',
  trackNumber: 2,
  trackTotal: 12,
  discNumber: 1,
  discTotal: 1,
  date: '1997-05-21',
  genre: 'Rock',
  mbRecordingId: ID,
  mbTrackId: null,
  mbReleaseId: ID,
  mbReleaseGroupId: ID,
  mbArtistId: ID,
  mbAlbumArtistId: ID,
};

const render = (patch: Partial<TagSet>, template = DEFAULT_NAMING_TEMPLATE, ext = 'flac') =>
  renderLibraryPath(template, valuesFromTags({ ...TAGS, ...patch }, ext));

describe('renderLibraryPath: the default templates', () => {
  it('renders an album track', () => {
    expect(render({})).toBe('Radiohead/OK Computer (1997)/02 - Paranoid Android.flac');
  });

  it('renders a single with the singles template', () => {
    expect(render({}, DEFAULT_SINGLES_TEMPLATE, 'mp3')).toBe(
      'Radiohead/Singles/Paranoid Android.mp3',
    );
  });

  it('adds the disc only for multi-disc releases', () => {
    expect(render({ discNumber: 2, discTotal: 1 })).toBe(
      'Radiohead/OK Computer (1997)/02 - Paranoid Android.flac',
    );
    expect(render({ discNumber: 2, discTotal: 2 })).toBe(
      'Radiohead/OK Computer (1997)/2-02 - Paranoid Android.flac',
    );
  });

  it('pads the track number as asked', () => {
    expect(render({ trackNumber: 7 })).toContain('/07 - ');
    expect(render({ trackNumber: 7 }, '{track} {title}.{ext}')).toBe('7 Paranoid Android.flac');
    expect(render({ trackNumber: 7 }, '{track:03} {title}.{ext}')).toBe(
      '007 Paranoid Android.flac',
    );
    expect(render({ trackNumber: 123 }, '{track:02} {title}.{ext}')).toBe(
      '123 Paranoid Android.flac',
    );
  });
});

describe('renderLibraryPath: variables', () => {
  const cases: [string, string, string][] = [
    [
      'albumartist falls back to the artist',
      '{albumartist}/{title}.{ext}',
      'Radiohead/Paranoid Android.flac',
    ],
    ['genre', '{genre}/{title}.{ext}', 'Rock/Paranoid Android.flac'],
    ['full date', '{date} {title}.{ext}', '1997-05-21 Paranoid Android.flac'],
    ['year from the date', '{year} {title}.{ext}', '1997 Paranoid Android.flac'],
    ['mbids', '{mbrecording}.{ext}', `${ID}.flac`],
    [
      'artist and album artist differ',
      '{albumartist} - {artist}/{title}.{ext}',
      'Radiohead - Radiohead/Paranoid Android.flac',
    ],
  ];
  for (const [name, template, expected] of cases) {
    it(name, () => {
      expect(render({}, template)).toBe(expected);
    });
  }

  it('uses the track artist when the album artist is blank', () => {
    const values = valuesFromTags({ ...TAGS, albumArtist: ' ' }, 'flac');
    values.albumartist = values.albumartist.trim() || values.artist;
    expect(renderLibraryPath('{albumartist}/{title}.{ext}', values)).toBe(
      'Radiohead/Paranoid Android.flac',
    );
  });

  it('drops empty brackets when the year is unknown', () => {
    expect(render({ date: null })).toBe('Radiohead/OK Computer/02 - Paranoid Android.flac');
  });

  it('lower-cases and cleans the extension', () => {
    expect(render({}, DEFAULT_NAMING_TEMPLATE, 'FLAC')).toMatch(/\.flac$/u);
    expect(render({}, DEFAULT_NAMING_TEMPLATE, '../x')).toMatch(/\.x$/u);
  });
});

describe('renderLibraryPath: hostile and awkward values', () => {
  const hostile: [string, Partial<TagSet>][] = [
    ['traversal in the title', { title: '../../../../etc/passwd' }],
    ['traversal in the artist', { artist: '../..', albumArtist: '../..' }],
    ['traversal in the album', { album: '..' }],
    ['backslash traversal', { title: '..\\..\\windows\\system32', album: '..\\..' }],
    ['absolute path', { title: '/etc/shadow', album: '/root' }],
    ['fullwidth dots and slashes', { title: '．．／．．／etc／passwd', album: '．．' }],
    ['NUL and control characters', { title: 'a\0b\u0007c‮d', artist: '\0' }],
    ['encoded-looking traversal', { title: '%2e%2e%2f%2e%2e%2fetc' }],
    ['only dots', { title: '...', album: '.', artist: '..', albumArtist: '..' }],
  ];
  for (const [name, patch] of hostile) {
    it(`${name} stays inside the library`, () => {
      for (const template of [DEFAULT_NAMING_TEMPLATE, DEFAULT_SINGLES_TEMPLATE]) {
        const path = render(patch, template);
        expect(path.startsWith('/')).toBe(false);
        expect(path.split('/')).not.toContain('..');
        expect(path.split('/')).not.toContain('.');
        expect(path).not.toContain('\0');
        expect(path).not.toContain('\\');
        expect(() => assertInside('/music', join('/music', path))).not.toThrow();
        // The template's own structure is intact: one segment per literal slash.
        expect(path.split('/').length).toBe(template.split('/').length);
      }
    });
  }

  it('turns a slash in a value into a single folder name', () => {
    expect(render({ artist: 'AC/DC', albumArtist: 'AC/DC' })).toBe(
      'AC_DC/OK Computer (1997)/02 - Paranoid Android.flac',
    );
  });

  it('flattens a traversal title into one harmless file name', () => {
    const path = render({ title: '../../../../etc/passwd' });
    expect(path).toBe('Radiohead/OK Computer (1997)/02 - ._._._._etc_passwd.flac');
  });

  it('prefixes Windows device names', () => {
    expect(render({ title: 'CON' })).toMatch(/\/02 - CON\.flac$/u);
    expect(render({ albumArtist: 'AUX', artist: 'AUX' })).toMatch(/^_AUX\//u);
    expect(render({ album: 'nul', date: null })).toMatch(/\/_nul\//u);
    expect(render({ albumArtist: 'COM1', artist: 'COM1' }, '{albumartist}/{title}.{ext}')).toMatch(
      /^_COM1\//u,
    );
  });

  it('removes reserved characters and keeps unicode', () => {
    expect(render({ title: 'Why? <Not> "this": *really* | yes' })).not.toMatch(/[<>:"|?*]/u);
    expect(render({ title: 'Sigur Rós – Hoppípolla ♥ 日本語' })).toContain(
      'Sigur Rós – Hoppípolla ♥ 日本語',
    );
  });

  it('falls back for empty values', () => {
    expect(render({ artist: '', albumArtist: '' })).toMatch(/^Unknown Artist\//u);
    expect(render({ album: '   ', date: null })).toContain('/Unknown Album/');
    expect(render({ title: '' })).toMatch(/\/02 -\.flac$/u);
    expect(render({ album: '..', date: null })).toContain('/Unknown Album/');
    expect(render({ artist: '..', albumArtist: '...' })).toMatch(/^Unknown Artist\//u);
  });

  it('truncates very long names without splitting characters and keeps the extension', () => {
    const long = '日'.repeat(400);
    const path = render({ title: long, album: long });
    for (const segment of path.split('/')) {
      expect(Buffer.byteLength(segment)).toBeLessThanOrEqual(200);
    }
    expect(path.endsWith('.flac')).toBe(true);
    expect(path).not.toContain('�');
  });

  it('keeps room for a collision suffix', () => {
    const path = render({ title: 'x'.repeat(500) });
    const name = path.split('/').at(-1) ?? '';
    expect(Buffer.byteLength(withCollisionSuffix(`/${name}`, 99))).toBeLessThanOrEqual(255);
  });

  it('drops empty literal segments and rejects an empty template', () => {
    expect(render({}, '/{artist}//{title}.{ext}')).toBe('Radiohead/Paranoid Android.flac');
    expect(() => renderLibraryPath('//', valuesFromTags(TAGS, 'flac'))).toThrow();
  });

  it('refuses an unknown variable at render time too', () => {
    expect(() => render({}, '{nope}/{title}.{ext}')).toThrow(/Unknown template variable/u);
  });
});

describe('useSinglesTemplate', () => {
  it('applies for a blank album or a Single release group only', () => {
    expect(useSinglesTemplate(TAGS, 'Album')).toBe(false);
    expect(useSinglesTemplate(TAGS, null)).toBe(false);
    expect(useSinglesTemplate(TAGS, 'Single')).toBe(true);
    expect(useSinglesTemplate(TAGS, 'single')).toBe(true);
    expect(useSinglesTemplate({ ...TAGS, album: '  ' }, 'Album')).toBe(true);
  });
});

describe('validateNamingTemplate and the settings schema', () => {
  it('accepts the defaults', () => {
    expect(validateNamingTemplate(DEFAULT_NAMING_TEMPLATE)).toEqual([]);
    expect(validateNamingTemplate(DEFAULT_SINGLES_TEMPLATE)).toEqual([]);
  });

  const bad: [string, RegExp][] = [
    ['{nope}/{title}.{ext}', /Unknown variable \{nope\}/u],
    ['{artist}/{title}', /\{ext\}/u],
    ['{artist}/{ext}', /\{title\}/u],
    ['/{title}.{ext}', /relative/u],
    ['../{title}.{ext}', /\.\./u],
    ['{artist}/../{title}.{ext}', /\.\./u],
    ['{artist}\\{title}.{ext}', /separator/u],
    ['{track:xx}{title}.{ext}', /Bad format/u],
    ['{title:02}.{ext}', /Bad format/u],
    ['{artist:?}{title}.{ext}', /Bad format/u],
    ['{title}.{ext}{', /Unbalanced/u],
    ['', /empty/u],
  ];
  for (const [template, message] of bad) {
    it(`rejects ${JSON.stringify(template)}`, () => {
      expect(validateNamingTemplate(template).join(' | ')).toMatch(message);
    });
  }

  it('is enforced when the settings are saved', () => {
    const { db } = openDatabase(MEMORY_DB);
    runMigrations(db);
    const settings = new SettingsService(db, new SecretBox(Buffer.alloc(32, 1)), {
      warn: () => undefined,
    });
    expect(() =>
      settings.set('library', {
        ...settingsDefault('library'),
        namingTemplate: '{bogus}/{title}.{ext}',
      }),
    ).toThrow();
    expect(() =>
      settings.set('library', {
        ...settingsDefault('library'),
        singlesTemplate: '../x/{title}.{ext}',
      }),
    ).toThrow();
    settings.set('library', {
      ...settingsDefault('library'),
      namingTemplate: '{artist} - {title}.{ext}',
    });
    expect(settings.get('library').namingTemplate).toBe('{artist} - {title}.{ext}');
  });
});

describe('resolveDestination', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hearer-dest-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const file = { size: 4, sha256: 'a'.repeat(64) };

  it('returns the rendered path when it is free', async () => {
    const r = await resolveDestination(root, 'A/B/01 - X.flac', file);
    expect(r).toEqual({ path: join(await realRoot(root), 'A/B/01 - X.flac'), identical: false });
  });

  it('suffixes (2), (3) while different files occupy the name', async () => {
    mkdirSync(join(root, 'A'));
    writeFileSync(join(root, 'A/X.flac'), 'one');
    writeFileSync(join(root, 'A/X (2).flac'), 'two!');
    const r = await resolveDestination(root, 'A/X.flac', file);
    expect(r.path.endsWith(`A${sep}X (3).flac`)).toBe(true);
    expect(r.identical).toBe(false);
  });

  it('recognises identical content as already imported', async () => {
    mkdirSync(join(root, 'A'));
    writeFileSync(join(root, 'A/X.flac'), 'data');
    const sha = await sha256File(join(root, 'A/X.flac'));
    const r = await resolveDestination(root, 'A/X.flac', { size: 4, sha256: sha });
    expect(r.identical).toBe(true);
    expect(r.path.endsWith('X.flac')).toBe(true);
  });

  it('finds identical content behind a different file', async () => {
    mkdirSync(join(root, 'A'));
    writeFileSync(join(root, 'A/X.flac'), 'other');
    writeFileSync(join(root, 'A/X (2).flac'), 'data');
    const sha = await sha256File(join(root, 'A/X (2).flac'));
    const r = await resolveDestination(root, 'A/X.flac', { size: 4, sha256: sha });
    expect(r).toMatchObject({ identical: true });
    expect(r.path.endsWith('X (2).flac')).toBe(true);
  });

  it('refuses a destination that escapes through a symlink', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'hearer-outside-'));
    try {
      symlinkSync(outside, join(root, 'Evil'));
      await expect(resolveDestination(root, 'Evil/X.flac', file)).rejects.toThrow(/escapes/u);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

async function realRoot(root: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(root);
}
