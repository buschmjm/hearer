/**
 * Text normalization for fuzzy library matching (library index `norm_key`, availability matcher,
 * and later the upload duplicate check). Both sides of a comparison (media server tags and
 * MusicBrainz) go through the same functions, so the output only has to be stable, not pretty.
 *
 * Pipeline (titles and artists):
 *   1. Lowercase, NFKD. Combining diacritics (U+0300-036F) are stripped only when they follow a
 *      Latin letter ("Beyoncé" = "beyonce"). Marks on other scripts are kept: Japanese
 *      dakuten (が vs か), Cyrillic й/ё, Devanagari and Hangul are never mangled. The result is
 *      recomposed to NFC. Full-width forms fold to ASCII through NFKD.
 *   2. A few Latin letters that do not decompose are folded: ø o, đ d, ł l, ß ss, æ ae, œ oe, ı i.
 *   3. Noise suffixes are removed (see below), repeatedly, anywhere in a bracket group and as a
 *      trailing " - xxx" segment.
 *   4. "&" becomes "and" ("Simon & Garfunkel" = "Simon and Garfunkel").
 *   5. Apostrophes and periods are deleted ("don't" = "dont", "R.E.M." = "rem"); every other
 *      character that is not a letter, digit or mark becomes a space; whitespace is collapsed.
 *   6. Artists only: a leading "the " is dropped ("The Beatles" = "Beatles") when something
 *      remains. Titles keep it, because "The Scientist" is not "Scientist" and media servers do
 *      not reorder titles the way they reorder artist sort names.
 *   7. If everything was stripped ("!!!", or a title that is only "(Remastered)"), fall back to
 *      the lowercased input without whitespace so distinct odd names do not all collapse to "".
 *
 * Noise (removed, same recording): "feat./ft./featuring/with X" credits, and bracket or
 * dash-suffix groups made only of: remaster(ed), deluxe, edition, expanded, anniversary,
 * reissue, bonus, track(s), version, mono, stereo, explicit, clean, digital, original, album,
 * super, special, collector's, legacy, plus years and bare numbers ("Remastered 2011",
 * "2011 Remaster", "Deluxe Edition", "Mono Version", "Explicit").
 *
 * Meaningful (kept, because they are different recordings): anything that contains live,
 * acoustic, remix/mix, demo, instrumental, cover, unplugged, session, sessions, karaoke,
 * a cappella, edit, radio, version-of-something-else such as "Single Version", "Part 2",
 * "Reprise", and any bracket text this list does not recognise ("(Intro)" stays "intro").
 * A group is removed only when EVERY word is noise; one meaningful word keeps the whole group.
 */

const FOLD: Readonly<Record<string, string>> = {
  ø: 'o',
  đ: 'd',
  ł: 'l',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ı: 'i',
  ð: 'd',
  þ: 'th',
};
const FOLD_RE = new RegExp(`[${Object.keys(FOLD).join('')}]`, 'g');

const NOISE_WORDS = new Set([
  'remaster',
  'remastered',
  'deluxe',
  'edition',
  'expanded',
  'anniversary',
  'reissue',
  'bonus',
  'track',
  'tracks',
  'version',
  'mono',
  'stereo',
  'explicit',
  'clean',
  'digital',
  'original',
  'album',
  'super',
  'special',
  'collectors',
  'legacy',
  'the',
  'and',
  'of',
]);

/** Presence of any of these keeps a group, even if it also contains noise words. */
const MEANINGFUL_RE =
  /\b(live|acoustic|remix|remixed|mix|demo|instrumental|cover|unplugged|session|sessions|karaoke|cappella|edit|radio|single|reprise|part|pt|vip|dub|rework|bootleg|medley|intro|outro|interlude|skit)\b/;

const FEAT_RE = /\b(?:feat|ft|featuring|with)\b\.?/;
const FEAT_TAIL_RE = /\s+(?:feat|ft|featuring)\b\.?\s.*$/i;
// "(...)" and "[...]" groups; nesting is not supported (and not needed for tags).
const BRACKET_RE = /\s*[([]([^()[\]]*)[)\]]/g;
// A trailing " - suffix" (spaced hyphen, en dash or em dash).
const DASH_SUFFIX_RE = /\s+[-–—]\s+([^-–—]*)$/;

function isLatin(ch: string): boolean {
  return /\p{Script=Latin}/u.test(ch);
}

/** Lowercase + NFKD, strip diacritics after Latin letters, fold special letters, back to NFC. */
function fold(input: string): string {
  const decomposed = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(FOLD_RE, (c) => FOLD[c] ?? c);
  let out = '';
  let base = '';
  for (const ch of decomposed) {
    const code = ch.codePointAt(0) ?? 0;
    const isCombining = code >= 0x300 && code <= 0x36f;
    if (isCombining && isLatin(base)) continue;
    out += ch;
    if (!/\p{M}/u.test(ch)) base = ch;
  }
  return out.normalize('NFC').toLowerCase();
}

/** The words of a candidate noise group (letters/digits only). */
function words(text: string): string[] {
  return text
    .replace(/['’ʼ`.]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Is this bracket or dash-suffix text only noise (safe to drop)? */
function isNoiseGroup(text: string): boolean {
  const lower = text.toLowerCase();
  if (FEAT_RE.test(lower) && /^\s*(?:feat|ft|featuring|with)\b/.test(lower)) return true;
  if (MEANINGFUL_RE.test(lower)) return false;
  const parts = words(lower);
  if (parts.length === 0) return false;
  let sawNoise = false;
  for (const part of parts) {
    if (/^\d+(?:st|nd|rd|th)?$/.test(part)) continue; // years, "24 bit", "25th"
    if (NOISE_WORDS.has(part)) {
      sawNoise = true;
      continue;
    }
    return false;
  }
  // Bare numbers alone ("(1999)") are not noise; at least one noise word must be present.
  return sawNoise;
}

function stripNoise(text: string): string {
  let current = text;
  for (let i = 0; i < 20; i++) {
    const before = current;
    current = current.replace(BRACKET_RE, (match, inner: string) =>
      isNoiseGroup(inner) ? '' : match,
    );
    const dash = DASH_SUFFIX_RE.exec(current);
    if (dash && isNoiseGroup(dash[1] ?? '')) current = current.slice(0, dash.index);
    if (current === before) break;
  }
  // Unbracketed credit: "Song feat. Someone".
  return current.replace(FEAT_TAIL_RE, '');
}

function squash(text: string): string {
  return text
    .replace(/&/g, ' and ')
    .replace(/['’ʼ`.]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(input: string, artist: boolean): string {
  const folded = fold(input.trim());
  let result = squash(stripNoise(folded));
  if (artist) {
    const trimmed = result.replace(/^the\s+/, '');
    if (trimmed !== '') result = trimmed;
  }
  if (result === '') {
    // Everything was punctuation or noise; keep a stable, distinguishing form.
    return folded.replace(/\s+/g, '');
  }
  return result;
}

/** Normalized track or album title. Empty string only for empty/blank input. */
export function normalizeTitle(title: string): string {
  return normalize(title, false);
}

/** Normalized artist name (as `normalizeTitle`, plus a leading "the " is dropped). */
export function normalizeArtist(artist: string): string {
  return normalize(artist, true);
}

/**
 * The fuzzy matching key `artist|title`. Null when either side normalizes to nothing, because a
 * key with a missing half would match unrelated rows.
 */
export function normKey(
  artist: string | null | undefined,
  title: string | null | undefined,
): string | null {
  const a = normalizeArtist(artist ?? '');
  const t = normalizeTitle(title ?? '');
  if (a === '' || t === '') return null;
  return `${a}|${t}`;
}
