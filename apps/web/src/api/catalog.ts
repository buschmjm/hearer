import {
  artistDetailSchema,
  pageSchema,
  recordingDetailSchema,
  releaseGroupDetailSchema,
  releaseGroupSummarySchema,
  searchResponseSchema,
  MAX_OFFSET,
  type SearchResponse,
  type SearchType,
} from '@hearer/shared';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { api } from './client.ts';

/** Every catalog query shares this prefix so a request mutation can refresh all the badges. */
export const catalogKeys = {
  all: ['catalog'] as const,
  search: (type: SearchType, q: string) => ['catalog', 'search', type, q] as const,
  artist: (mbid: string) => ['catalog', 'artist', mbid] as const,
  artistAlbums: (mbid: string) => ['catalog', 'artist', mbid, 'albums'] as const,
  album: (mbid: string) => ['catalog', 'album', mbid] as const,
  track: (mbid: string) => ['catalog', 'track', mbid] as const,
};

export const SEARCH_PAGE_SIZE = 20;
export const ARTIST_ALBUMS_PAGE_SIZE = 50;

function nextOffset(page: { offset: number; limit: number; total: number }): number | undefined {
  const next = page.offset + page.limit;
  return next < page.total && next <= MAX_OFFSET ? next : undefined;
}

export const searchQuery = (type: SearchType, q: string) =>
  infiniteQueryOptions({
    queryKey: catalogKeys.search(type, q),
    staleTime: 60_000,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }): Promise<SearchResponse> =>
      api('/search', {
        query: { q, type, offset: pageParam, limit: SEARCH_PAGE_SIZE },
        schema: searchResponseSchema,
        signal,
      }),
    getNextPageParam: nextOffset,
  });

export const artistQuery = (mbid: string) =>
  queryOptions({
    queryKey: catalogKeys.artist(mbid),
    queryFn: ({ signal }) => api(`/artists/${mbid}`, { schema: artistDetailSchema, signal }),
  });

export const artistAlbumsQuery = (mbid: string) =>
  infiniteQueryOptions({
    queryKey: catalogKeys.artistAlbums(mbid),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api(`/artists/${mbid}/albums`, {
        query: { offset: pageParam, limit: ARTIST_ALBUMS_PAGE_SIZE },
        schema: pageSchema(releaseGroupSummarySchema),
        signal,
      }),
    getNextPageParam: nextOffset,
  });

export const albumQuery = (mbid: string) =>
  queryOptions({
    queryKey: catalogKeys.album(mbid),
    queryFn: ({ signal }) => api(`/albums/${mbid}`, { schema: releaseGroupDetailSchema, signal }),
  });

export const trackQuery = (mbid: string) =>
  queryOptions({
    queryKey: catalogKeys.track(mbid),
    queryFn: ({ signal }) => api(`/tracks/${mbid}`, { schema: recordingDetailSchema, signal }),
  });
