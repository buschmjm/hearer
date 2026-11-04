import { describe, expect, it } from 'vitest';
import { normKey, normalizeArtist, normalizeTitle } from '../src/lib/normalize.ts';

describe('normalizeTitle', () => {
  const table: [string, string, string][] = [
    ['case', 'Paranoid ANDROID', 'paranoid android'],
    ['diacritics', 'Beyoncé – Déjà Vu', 'beyonce deja vu'],
    [
      'special letters',
      'Sigur Rós Ørnólfur Łódź Straße Æon',
      'sigur ros ornolfur lodz strasse aeon',
    ],
    ['apostrophes vanish', "Don't Stop Believin’", 'dont stop believin'],
    ['periods vanish', 'R.E.M. Mr. Brightside', 'rem mr brightside'],
    ['punctuation to space', 'Hello, World! (Intro)', 'hello world intro'],
    ['ampersand', 'Rock & Roll', 'rock and roll'],
    ['and kept', 'Rock and Roll', 'rock and roll'],
    ['leading the kept for titles', 'The Scientist', 'the scientist'],
    ['whitespace', '  lots   of\tspace \n', 'lots of space'],
    ['full width', 'ＡＢＣ　１２３', 'abc 123'],
    // noise suffixes
    ['feat paren', 'Song (feat. Someone Else)', 'song'],
    ['feat bracket', 'Song [feat Someone]', 'song'],
    ['ft', 'Song (ft. Someone)', 'song'],
    ['featuring', 'Song (Featuring Someone)', 'song'],
    ['with', 'Song (with Someone)', 'song'],
    ['bare feat', 'Song feat. Someone & Other', 'song'],
    ['bare ft', 'Song ft Someone', 'song'],
    ['remastered year', 'Song (Remastered 2011)', 'song'],
    ['remaster dash', 'Song - 2011 Remaster', 'song'],
    ['remastered dash', 'Song - Remastered 2009', 'song'],
    ['remaster bracket', 'Song [2011 Remaster]', 'song'],
    ['deluxe edition', 'Album (Deluxe Edition)', 'album'],
    ['super deluxe', 'Album (Super Deluxe Edition)', 'album'],
    ['anniversary', 'Album (25th Anniversary Edition)', 'album'],
    ['expanded', 'Album (Expanded Edition)', 'album'],
    ['mono version', 'Song - Mono Version', 'song'],
    ['stereo', 'Song (Stereo)', 'song'],
    ['explicit', 'Song (Explicit)', 'song'],
    ['clean', 'Song [Clean]', 'song'],
    ['bonus track version', 'Album (Bonus Track Version)', 'album'],
    ['album version', 'Song (Album Version)', 'song'],
    ['stacked suffixes', 'Song (Remastered) (Deluxe Edition) [feat. X]', 'song'],
    ['dash and bracket', 'Song (Live) - 2011 Remaster', 'song live'],
    // meaningful suffixes are kept
    ['live', 'Song (Live)', 'song live'],
    ['live at', 'Song - Live at Wembley', 'song live at wembley'],
    ['acoustic', 'Song (Acoustic)', 'song acoustic'],
    ['remix', 'Song (Radiohead Remix)', 'song radiohead remix'],
    ['demo', 'Song [Demo]', 'song demo'],
    ['instrumental', 'Song (Instrumental)', 'song instrumental'],
    ['live remaster is still live', 'Song (Remastered Live)', 'song remastered live'],
    ['single version kept', 'Song (Single Version)', 'song single version'],
    ['part kept', 'Song (Part 2)', 'song part 2'],
    ['unknown bracket kept', 'Song (Reprise)', 'song reprise'],
    ['bare year bracket kept', 'Song (1999)', 'song 1999'],
    ['hyphen inside word', 'Jay-Z Anti-Hero', 'jay z anti hero'],
    ['dash word not suffix', 'Song - Part II', 'song part ii'],
    // scripts
    ['cjk', '千と千尋の神隠し', '千と千尋の神隠し'],
    ['japanese dakuten kept', 'ガ', 'ガ'],
    ['dakuten differs from base', 'か', 'か'],
    ['cyrillic', 'Группа Крови', 'группа крови'],
    ['cyrillic short i kept', 'Йога', 'йога'],
    ['korean', '봄날', '봄날'],
    ['greek keeps its accents', 'Άλφα', 'άλφα'],
    ['cjk with noise', '夜に駆ける (Remastered 2020)', '夜に駆ける'],
    ['cjk punctuation', '「夜に駆ける」', '夜に駆ける'],
    // degenerate
    ['empty', '', ''],
    ['blank', '   ', ''],
    ['only punctuation falls back', '!!!', '!!!'],
    ['only noise falls back', '(Remastered)', '(remastered)'],
  ];
  it.each(table)('%s', (_name, input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });

  it('keeps the dakuten distinction (が is not か)', () => {
    expect(normalizeTitle('が')).not.toBe(normalizeTitle('か'));
  });

  it('keeps distinct recordings apart', () => {
    expect(normalizeTitle('Song (Live)')).not.toBe(normalizeTitle('Song'));
    expect(normalizeTitle('Song (Acoustic)')).not.toBe(normalizeTitle('Song (Demo)'));
    expect(normalizeTitle('Song (A Remix)')).not.toBe(normalizeTitle('Song'));
  });

  it('is idempotent', () => {
    for (const [, input] of table) {
      const once = normalizeTitle(input);
      expect(normalizeTitle(once)).toBe(once);
    }
  });
});

describe('normalizeArtist', () => {
  const table: [string, string, string][] = [
    ['leading the', 'The Beatles', 'beatles'],
    ['the only', 'The The', 'the'],
    ['just the', 'The', 'the'],
    ['the mid-name kept', 'Bob and The Band', 'bob and the band'],
    ['ampersand', 'Simon & Garfunkel', 'simon and garfunkel'],
    ['and', 'Simon and Garfunkel', 'simon and garfunkel'],
    ['feat tail', 'Artist feat. Guest', 'artist'],
    ['feat bracket', 'Artist (feat. Guest)', 'artist'],
    ['diacritics', 'Mötley Crüe', 'motley crue'],
    ['acdc', 'AC/DC', 'ac dc'],
    ['dots', 'R.E.M.', 'rem'],
    ['cjk', '宇多田ヒカル', '宇多田ヒカル'],
    ['cyrillic', 'Кино', 'кино'],
    ['symbols only', '???', '???'],
    ['empty', '', ''],
  ];
  it.each(table)('%s', (_name, input, expected) => {
    expect(normalizeArtist(input)).toBe(expected);
  });
});

describe('normKey', () => {
  it('joins artist and title', () => {
    expect(normKey('Radiohead', 'Paranoid Android (Remastered 2009)')).toBe(
      'radiohead|paranoid android',
    );
    expect(normKey('The Beatles', 'Let It Be')).toBe(normKey('Beatles', 'let it be'));
  });

  it('is null when either half is empty', () => {
    expect(normKey('', 'Title')).toBeNull();
    expect(normKey('Artist', '  ')).toBeNull();
    expect(normKey(null, 'Title')).toBeNull();
    expect(normKey('Artist', undefined)).toBeNull();
  });

  it('does not let the separator leak between halves', () => {
    expect(normKey('a|b', 'c')).not.toBe(normKey('a', 'b|c'));
  });
});
