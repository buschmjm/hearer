import type {
  ArtistBase,
  ArtistDetailBase,
  Page,
  RecordingBase,
  RecordingDetailBase,
  ReleaseGroupBase,
  ReleaseGroupDetailBase,
  ReleaseGroupType,
  ReleaseSummary,
  TrackBase,
} from '@hearer/shared';

export type {
  ArtistBase,
  ArtistDetailBase,
  Page,
  RecordingBase,
  RecordingDetailBase,
  ReleaseGroupBase,
  ReleaseGroupDetailBase,
  ReleaseGroupType,
  ReleaseSummary,
  TrackBase,
};

export interface PageRequest {
  offset: number;
  limit: number;
}

export interface RequestOptions {
  /** Abort waiting for the rate limiter and the network. */
  signal?: AbortSignal;
}

/** A release with its full tracklist (all media, in order). */
export interface ReleaseDetailBase extends ReleaseSummary {
  releaseGroupMbid: string | null;
  tracks: TrackBase[];
}

/** Why a metadata call failed. `not_found` and `unavailable` map to 404 and 502 in the API. */
export class MetadataError extends Error {
  readonly kind: 'not_found' | 'unavailable' | 'bad_response';

  constructor(kind: MetadataError['kind'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MetadataError';
    this.kind = kind;
  }
}

/**
 * A source of catalog metadata. MusicBrainz is the only implementation today; the interface
 * keeps room for a faster search source. Items carry no library or request badges; the API
 * adds those. All lookups key on MusicBrainz ids.
 */
export interface MetadataProvider {
  searchArtists(
    query: string,
    page: PageRequest,
    options?: RequestOptions,
  ): Promise<Page<ArtistBase>>;
  searchReleaseGroups(
    query: string,
    page: PageRequest,
    options?: RequestOptions,
  ): Promise<Page<ReleaseGroupBase>>;
  searchRecordings(
    query: string,
    page: PageRequest,
    options?: RequestOptions,
  ): Promise<Page<RecordingBase>>;

  getArtist(mbid: string, options?: RequestOptions): Promise<ArtistDetailBase>;
  /** An artist's release groups, optionally restricted to one primary type. */
  getArtistReleaseGroups(
    mbid: string,
    page: PageRequest & { type?: ReleaseGroupType | undefined },
    options?: RequestOptions,
  ): Promise<Page<ReleaseGroupBase>>;
  /**
   * A release group, its releases (first 100) and the tracklist of its representative release.
   * The heuristic (official, Digital Media/CD, most common track count, earliest) is documented
   * on `pickRepresentativeRelease` in musicbrainz.ts.
   */
  getReleaseGroup(mbid: string, options?: RequestOptions): Promise<ReleaseGroupDetailBase>;
  getRelease(mbid: string, options?: RequestOptions): Promise<ReleaseDetailBase>;
  /** A recording with artist credits, ISRCs, length and the release groups it appears on. */
  getRecording(mbid: string, options?: RequestOptions): Promise<RecordingDetailBase>;
}
