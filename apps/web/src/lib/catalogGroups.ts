import type { ReleaseGroupSummary } from '@hearer/shared';

export type AlbumGroupKey = 'Albums' | 'EPs' | 'Singles' | 'Other';
export const ALBUM_GROUP_ORDER: readonly AlbumGroupKey[] = ['Albums', 'EPs', 'Singles', 'Other'];

/** Group release groups by MusicBrainz primary type; newest first within a group. */
export function groupReleaseGroups(
  items: readonly ReleaseGroupSummary[],
): { key: AlbumGroupKey; items: ReleaseGroupSummary[] }[] {
  const buckets = new Map<AlbumGroupKey, ReleaseGroupSummary[]>();
  for (const item of items) {
    const primary = item.primaryType?.toLowerCase();
    const key: AlbumGroupKey =
      primary === 'album'
        ? 'Albums'
        : primary === 'ep'
          ? 'EPs'
          : primary === 'single'
            ? 'Singles'
            : 'Other';
    const list = buckets.get(key) ?? [];
    list.push(item);
    buckets.set(key, list);
  }
  return ALBUM_GROUP_ORDER.flatMap((key) => {
    const list = buckets.get(key);
    if (!list) return [];
    const sorted = [...list].sort((a, b) => {
      // Undated releases sink to the bottom; otherwise newest first.
      if (!a.firstReleaseDate && !b.firstReleaseDate) return a.title.localeCompare(b.title);
      if (!a.firstReleaseDate) return 1;
      if (!b.firstReleaseDate) return -1;
      return b.firstReleaseDate.localeCompare(a.firstReleaseDate);
    });
    return [{ key, items: sorted }];
  });
}
