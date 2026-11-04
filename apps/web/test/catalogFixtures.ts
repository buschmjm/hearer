import { Permission } from '@hearer/shared';

/** Builders for catalog API replies (shapes follow the shared DTO schemas). */
const none = { inLibrary: 'no', request: null } as const;

export const credit = (name: string, mbid: string | null = `artist-${name}`, joinPhrase = '') => ({
  mbid,
  name,
  joinPhrase,
});

export const albumSummary = (over: Record<string, unknown> = {}) => ({
  mbid: 'rg-ok',
  title: 'OK Computer',
  disambiguation: '',
  primaryType: 'Album',
  secondaryTypes: [],
  firstReleaseDate: '1997-05-21',
  artistCredit: [credit('Radiohead', 'artist-radiohead')],
  artistName: 'Radiohead',
  coverUrl: 'https://coverartarchive.org/release-group/rg-ok/front-250',
  score: 100,
  ...none,
  ...over,
});

export const artistSummary = (over: Record<string, unknown> = {}) => ({
  mbid: 'artist-radiohead',
  name: 'Radiohead',
  sortName: 'Radiohead',
  type: 'Group',
  country: 'GB',
  disambiguation: '',
  score: 100,
  ...none,
  ...over,
});

export const recordingSummary = (over: Record<string, unknown> = {}) => ({
  mbid: 'rec-paranoid',
  title: 'Paranoid Android',
  disambiguation: '',
  lengthMs: 387_000,
  artistCredit: [credit('Radiohead', 'artist-radiohead')],
  artistName: 'Radiohead',
  releaseGroup: {
    mbid: 'rg-ok',
    title: 'OK Computer',
    primaryType: 'Album',
    coverUrl: 'https://coverartarchive.org/release-group/rg-ok/front-250',
  },
  coverUrl: null,
  firstReleaseDate: '1997-05-21',
  score: 100,
  ...none,
  ...over,
});

export const trackRow = (over: Record<string, unknown> = {}) => ({
  mbid: 'rec-airbag',
  title: 'Airbag',
  discNumber: 1,
  position: 1,
  number: '1',
  lengthMs: 284_000,
  artistCredit: [credit('Radiohead', 'artist-radiohead')],
  artistName: 'Radiohead',
  isrcs: [],
  ...none,
  ...over,
});

export const albumDetail = (over: Record<string, unknown> = {}) => ({
  ...albumSummary(),
  releases: [],
  representativeRelease: {
    mbid: 'rel-1',
    title: 'OK Computer',
    date: '1997-05-21',
    country: 'GB',
    status: 'Official',
    format: 'CD',
    trackCount: 3,
  },
  tracks: [
    trackRow(),
    trackRow({ mbid: 'rec-paranoid', title: 'Paranoid Android', position: 2, number: '2' }),
    trackRow({ mbid: 'rec-lucky', title: 'Lucky', position: 3, number: '3', lengthMs: null }),
  ],
  ...over,
});

export const page = <T>(items: T[], total = items.length, offset = 0, limit = 20) => ({
  items,
  total,
  offset,
  limit,
});

export const searchReply = (
  type: 'artist' | 'album' | 'track',
  items: unknown[],
  total?: number,
) => ({
  json: { type, ...page(items, total) },
});

export const requestDto = (over: Record<string, unknown> = {}) => ({
  id: 'req-1',
  type: 'album',
  mbid: 'rg-ok',
  parentMbid: null,
  title: 'OK Computer',
  artistName: 'Radiohead',
  coverUrl: 'https://coverartarchive.org/release-group/rg-ok/front-250',
  status: 'PENDING',
  requestedBy: { id: 'u1', username: 'alice', displayName: 'Alice', avatar: null },
  decidedBy: null,
  decidedAt: null,
  declineReason: null,
  providerId: null,
  fulfilledByUploadId: null,
  createdAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-03T10:00:00.000Z',
  ...over,
});

export const REQUESTER = Permission.REQUEST | Permission.REQUEST_ALBUM | Permission.REQUEST_ARTIST;

export const quotaReply = (over: Record<string, unknown> = {}) => ({
  json: {
    limit: 5,
    days: 7,
    used: 2,
    remaining: 3,
    unlimited: false,
    resetsAt: '2026-11-08T10:00:00.000Z',
    ...over,
  },
});

/** Every URL the app fetched so far (the mock records `input` as a string). */
export const fetchedUrls = (fetchMock: { mock: { calls: unknown[][] } }): string[] =>
  fetchMock.mock.calls.map((c) => c[0] as string);
