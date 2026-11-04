/**
 * Upload matching: turn a file's fingerprint hits and tags into ranked MusicBrainz candidates,
 * group the files of one album, and spot duplicates. The scoring contract is written up in
 * docs/MATCHING.md ("Upload matching"); the numbers below are pinned by test/uploads.analyze.*.
 */
import {
  tagSetSchema,
  type AlbumGroup,
  type DuplicateInfo,
  type ExistingTags,
  type MatchCandidate,
  type ScoreBreakdown,
  type TagSet,
} from '@hearer/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { AcoustIdRecording } from '../adapters/metadata/acoustid.ts';
import { coverArtUrl } from '../adapters/metadata/coverart.ts';
import {
  MetadataError,
  type MetadataProvider,
  type RecordingDetailBase,
  type ReleaseGroupDetailBase,
  type ReleaseSummary,
  type RequestOptions,
  type TrackBase,
} from '../adapters/metadata/types.ts';
import type { Db } from '../db/client.ts';
import { libraryItems, uploads } from '../db/schema.ts';
import { toTagDate } from '../lib/audioTags.ts';
import { normalizeArtist, normalizeTitle } from '../lib/normalize.ts';
import { FuzzyLibraryLookup } from './availability.ts';
import type { LibraryLookup } from './badges.ts';

// --- scoring --------------------------------------------------------------------------------------

/** Relative weights of the evidence. Missing evidence is left out and the rest renormalised. */
export const SCORE_WEIGHTS = {
  acoustId: 0.4,
  title: 0.15,
  artist: 0.15,
  album: 0.1,
  duration: 0.12,
  track: 0.08,
} as const;

/** A candidate with no fingerprint evidence (tags only) can reach at most this score. */
export const UNFINGERPRINTED_FACTOR = 0.95;
/** Duration difference with full credit, and where the credit reaches zero. */
export const DURATION_FULL_CREDIT_MS = 2_000;
export const DURATION_ZERO_CREDIT_MS = 15_000;
/** How many candidates get their MusicBrainz details fetched. */
export const MAX_CANDIDATES = 5;
/** Leads whose preliminary score is below this are not worth the lookups. */
const MIN_PRELIMINARY_SCORE = 0.2;
const MAX_RELEASE_GROUPS_PER_CANDIDATE = 20;
/** A candidate must score at least this to take part in album grouping. */
const MIN_GROUPING_SCORE = 0.3;
const RELEASES_TO_INSPECT = 3;

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const left = Array.from(a);
  const right = Array.from(b);
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (const [i, ca] of left.entries()) {
    const current = [i + 1];
    for (const [j, cb] of right.entries()) {
      current.push(
        Math.min(
          (current[j] ?? 0) + 1,
          (previous[j + 1] ?? 0) + 1,
          (previous[j] ?? 0) + (ca === cb ? 0 : 1),
        ),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

const ratio = (a: string, b: string): number => {
  const longest = Math.max(Array.from(a).length, Array.from(b).length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
};

/**
 * 0..1 similarity of two names after the library normalisation (so "Beyoncé", "(Remastered)"
 * and "feat." noise do not count). The better of the plain Levenshtein ratio and the ratio of
 * the sorted tokens, which forgives word order ("Yorke Thom" vs "Thom Yorke").
 */
export function similarity(a: string, b: string, kind: 'title' | 'artist' = 'title'): number {
  const norm = kind === 'artist' ? normalizeArtist : normalizeTitle;
  const left = norm(a);
  const right = norm(b);
  if (left === '' || right === '') return 0;
  if (left === right) return 1;
  const sorted = (text: string) => text.split(' ').sort().join(' ');
  return Math.max(ratio(left, right), ratio(sorted(left), sorted(right)));
}

/** 1 up to 2 s apart, falling linearly to 0 at 15 s. Null when either length is unknown. */
export function durationScore(aMs: number | null, bMs: number | null): number | null {
  if (aMs === null || bMs === null) return null;
  const delta = Math.abs(aMs - bMs);
  if (delta <= DURATION_FULL_CREDIT_MS) return 1;
  if (delta >= DURATION_ZERO_CREDIT_MS) return 0;
  return (DURATION_ZERO_CREDIT_MS - delta) / (DURATION_ZERO_CREDIT_MS - DURATION_FULL_CREDIT_MS);
}

/** Track (and disc, when both are tagged) number agreement; null when the file has no number. */
export function trackScore(
  tags: Pick<ExistingTags, 'trackNumber' | 'discNumber'>,
  trackNumber: number | null,
  discNumber: number | null,
): number | null {
  if (tags.trackNumber === null || trackNumber === null) return null;
  if (tags.trackNumber !== trackNumber) return 0;
  if (tags.discNumber !== null && discNumber !== null && tags.discNumber !== discNumber) return 0.5;
  return 1;
}

/** Weighted mean of the evidence that exists, scaled down when no fingerprint backs it. */
export function combineScore(breakdown: ScoreBreakdown): number {
  let total = 0;
  let weight = 0;
  for (const key of Object.keys(SCORE_WEIGHTS) as (keyof typeof SCORE_WEIGHTS)[]) {
    const value = breakdown[key];
    if (value === null) continue;
    total += SCORE_WEIGHTS[key] * value;
    weight += SCORE_WEIGHTS[key];
  }
  if (weight === 0) return 0;
  const mean = total / weight;
  const score = breakdown.acoustId === null ? mean * UNFINGERPRINTED_FACTOR : mean;
  return Math.round(Math.min(1, Math.max(0, score)) * 10_000) / 10_000;
}

export interface ScoreInput {
  tags: ExistingTags;
  fileDurationMs: number | null;
  title: string;
  /** Every spelling of the credit that may be compared with the file's artist tag. */
  artists: readonly string[];
  album: string | null;
  lengthMs: number | null;
  trackNumber: number | null;
  discNumber: number | null;
  acoustScore: number | null;
}

export function scoreCandidate(input: ScoreInput): { score: number; breakdown: ScoreBreakdown } {
  const { tags } = input;
  const tagArtists = [tags.artist, tags.albumArtist].filter((v): v is string => v !== null);
  const artistScore =
    tagArtists.length === 0 || input.artists.length === 0
      ? null
      : Math.max(
          ...tagArtists.flatMap((t) => input.artists.map((a) => similarity(t, a, 'artist'))),
        );
  const breakdown: ScoreBreakdown = {
    acoustId: input.acoustScore,
    title: tags.title === null ? null : similarity(tags.title, input.title),
    artist: artistScore,
    album: tags.album === null || input.album === null ? null : similarity(tags.album, input.album),
    duration: durationScore(input.fileDurationMs, input.lengthMs),
    track: trackScore(tags, input.trackNumber, input.discNumber),
  };
  return { score: combineScore(breakdown), breakdown };
}

// --- release choice -----------------------------------------------------------------------------

export interface ReleaseHints {
  /** Release ids named by the file's own tags (or the batch's majority). */
  releaseMbids: readonly string[];
  album: string | null;
  trackTotal: number | null;
  /** A release already chosen for the batch. */
  preferReleaseMbid?: string | undefined;
}

/**
 * Order the releases of a release group by how well they fit the file (best first):
 * a release the batch settled on (+20), one named by a tag (+10), the same album title (+3),
 * the same track count as the tags say (+2), Official status (+1), the group's representative
 * release (+0.5, the H-09 heuristic); date and id break ties so the order never depends on
 * the response order.
 */
export function rankReleases(
  group: Pick<ReleaseGroupDetailBase, 'releases' | 'representativeRelease'>,
  hints: ReleaseHints,
): ReleaseSummary[] {
  const album = hints.album === null ? null : normalizeTitle(hints.album);
  const points = (r: ReleaseSummary): number =>
    (r.mbid === hints.preferReleaseMbid ? 20 : 0) +
    (hints.releaseMbids.includes(r.mbid) ? 10 : 0) +
    (album !== null && normalizeTitle(r.title) === album ? 3 : 0) +
    (hints.trackTotal !== null && r.trackCount === hints.trackTotal ? 2 : 0) +
    (r.status?.toLowerCase() === 'official' ? 1 : 0) +
    (r.mbid === group.representativeRelease?.mbid ? 0.5 : 0);
  return [...group.releases].sort(
    (a, b) =>
      points(b) - points(a) ||
      (a.date ?? '9999').localeCompare(b.date ?? '9999') ||
      a.mbid.localeCompare(b.mbid),
  );
}

// --- candidates -----------------------------------------------------------------------------------

export interface FileFacts {
  durationMs: number | null;
  tags: ExistingTags;
}

interface Lead {
  mbid: string;
  title: string;
  artistName: string;
  lengthMs: number | null;
  acoustScore: number | null;
  acoustId: string | null;
  sources: Set<'acoustid' | 'tags'>;
  /** Release groups AcoustID listed for this recording. */
  releaseGroupHints: string[];
}

interface Resolved {
  group: ReleaseGroupDetailBase;
  release: ReleaseSummary;
  tracks: TrackBase[];
  /** The recording's place on the release; null when it was not found on any inspected release. */
  track: TrackBase | null;
}

interface AssembleInput {
  facts: FileFacts;
  resolved: Resolved;
  /** The track to describe (a synthetic one when the recording is not on the release). */
  track: TrackBase;
  recordingIsrcs: readonly string[];
  sources: readonly ('acoustid' | 'tags')[];
  acoustScore: number | null;
  acoustId: string | null;
  releaseGroupMbids: readonly string[];
  coverBaseUrl: string;
}

const firstCreditId = (credit: { mbid: string | null }[]): string | null =>
  credit.find((c) => c.mbid !== null)?.mbid ?? null;

/** Build one scored candidate and its proposed tags, or null when MusicBrainz data is too thin. */
export function assembleCandidate(input: AssembleInput): MatchCandidate | null {
  const { facts, resolved, track } = input;
  const { group, release, tracks } = resolved;
  const artistMbid = firstCreditId(track.artistCredit) ?? firstCreditId(group.artistCredit);
  const albumArtistMbid = firstCreditId(group.artistCredit) ?? artistMbid;
  if (artistMbid === null || albumArtistMbid === null) return null;

  const onDisc = tracks.filter((t) => t.discNumber === track.discNumber).length;
  const trackTotal = Math.max(onDisc, track.position, 1);
  const discTotal = Math.max(1, ...tracks.map((t) => t.discNumber), track.discNumber);
  const date =
    toTagDate(release.date) ?? toTagDate(group.firstReleaseDate) ?? facts.tags.date ?? null;
  const isrc = facts.tags.isrc ?? input.recordingIsrcs[0] ?? track.isrcs[0] ?? null;
  const tags: TagSet = {
    title: track.title,
    artist: track.artistName,
    albumArtist: group.artistName,
    album: release.title,
    trackNumber: track.position,
    trackTotal,
    discNumber: track.discNumber,
    discTotal,
    date,
    genre: facts.tags.genre,
    mbRecordingId: track.mbid,
    mbReleaseId: release.mbid,
    mbReleaseGroupId: group.mbid,
    mbArtistId: artistMbid,
    mbAlbumArtistId: albumArtistMbid,
    acoustId: input.acoustId,
    isrc,
    compilation: group.secondaryTypes.some((t) => t.toLowerCase() === 'compilation') ? true : null,
    coverSource: facts.tags.hasPicture
      ? { type: 'embedded' }
      : { type: 'caa', releaseMbid: release.mbid },
  };
  const parsed = tagSetSchema.safeParse(tags);
  if (!parsed.success) return null;
  const { score, breakdown } = scoreCandidate({
    tags: facts.tags,
    fileDurationMs: facts.durationMs,
    title: track.title,
    artists: [track.artistName, group.artistName],
    album: release.title,
    lengthMs: track.lengthMs,
    trackNumber: track.position,
    discNumber: track.discNumber,
    acoustScore: input.acoustScore,
  });
  const groups = [...new Set([group.mbid, ...input.releaseGroupMbids])].slice(
    0,
    MAX_RELEASE_GROUPS_PER_CANDIDATE,
  );
  return {
    id: `${track.mbid}@${release.mbid}`,
    recordingMbid: track.mbid,
    releaseMbid: release.mbid,
    releaseGroupMbid: group.mbid,
    releaseGroupMbids: groups,
    title: track.title,
    artist: track.artistName,
    album: release.title,
    date,
    trackNumber: track.position,
    trackTotal,
    discNumber: track.discNumber,
    discTotal,
    lengthMs: track.lengthMs,
    coverUrl: coverArtUrl(input.coverBaseUrl, 'release', release.mbid, 250),
    score,
    breakdown,
    sources: [...input.sources],
    tags: parsed.data,
  };
}

/** Best first; ties go to fingerprint-backed candidates, then to the recording id. */
export function sortCandidates(candidates: MatchCandidate[]): MatchCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.sources.includes('acoustid')) - Number(a.sources.includes('acoustid')) ||
      a.id.localeCompare(b.id),
  );
}

export interface GroupMember {
  uploadId: string;
  facts: FileFacts;
  candidates: MatchCandidate[];
}

export interface GroupOutcome {
  group: AlbumGroup | null;
  /** Re-ranked candidates for every member that was placed on the group's release. */
  updated: Map<string, MatchCandidate[]>;
}

export interface MatchingServiceOptions {
  metadata: MetadataProvider;
  /** The Cover Art Archive base URL, read per call (settings can change). */
  coverBaseUrl: () => string;
  maxCandidates?: number;
}

export class MatchingService {
  readonly #metadata: MetadataProvider;
  readonly #coverBaseUrl: () => string;
  readonly #maxCandidates: number;

  constructor(options: MatchingServiceOptions) {
    this.#metadata = options.metadata;
    this.#coverBaseUrl = options.coverBaseUrl;
    this.#maxCandidates = options.maxCandidates ?? MAX_CANDIDATES;
  }

  /**
   * Candidate recordings for a file: the AcoustID hits, the recording id in the file's own tags,
   * and a MusicBrainz search on artist + title. At most `maxCandidates` get full details (the
   * best by a preliminary score). Throws `MetadataError('unavailable')` when MusicBrainz is down,
   * so the job can retry.
   */
  async match(
    facts: FileFacts,
    acoust: readonly AcoustIdRecording[],
    options: RequestOptions = {},
  ): Promise<MatchCandidate[]> {
    const leads = await this.#collectLeads(facts, acoust, options);
    const ranked = leads
      .map((lead) => ({ lead, prelim: this.#preliminary(facts, lead) }))
      .filter((entry) => entry.prelim >= MIN_PRELIMINARY_SCORE)
      .sort((a, b) => b.prelim - a.prelim || a.lead.mbid.localeCompare(b.lead.mbid))
      .slice(0, this.#maxCandidates);

    const tagRelease = await this.#releaseGroupOfTaggedRelease(facts.tags, options);
    const candidates: MatchCandidate[] = [];
    for (const { lead } of ranked) {
      const built = await this.#buildFromLead(lead, facts, tagRelease, options);
      if (built) candidates.push(built);
    }
    return sortCandidates(candidates);
  }

  async #collectLeads(
    facts: FileFacts,
    acoust: readonly AcoustIdRecording[],
    options: RequestOptions,
  ): Promise<Lead[]> {
    const leads = new Map<string, Lead>();
    const lead = (mbid: string): Lead => {
      let entry = leads.get(mbid);
      if (!entry) {
        entry = {
          mbid,
          title: '',
          artistName: '',
          lengthMs: null,
          acoustScore: null,
          acoustId: null,
          sources: new Set(),
          releaseGroupHints: [],
        };
        leads.set(mbid, entry);
      }
      return entry;
    };
    for (const rec of acoust) {
      const entry = lead(rec.mbid);
      entry.sources.add('acoustid');
      entry.title = rec.title ?? entry.title;
      entry.artistName = rec.artists.map((a) => a.name).join(', ') || entry.artistName;
      entry.lengthMs = rec.durationMs ?? entry.lengthMs;
      entry.acoustScore = Math.max(entry.acoustScore ?? 0, rec.score);
      entry.acoustId = entry.acoustId ?? rec.acoustId;
      entry.releaseGroupHints = rec.releaseGroups.map((rg) => rg.mbid);
    }
    const { tags } = facts;
    if (tags.mbRecordingId !== null) lead(tags.mbRecordingId).sources.add('tags');
    if (tags.title !== null) {
      const query = [tags.artist ?? tags.albumArtist, tags.title].filter(Boolean).join(' ');
      const found = await this.#metadata.searchRecordings(query, { offset: 0, limit: 5 }, options);
      for (const rec of found.items) {
        const entry = lead(rec.mbid);
        entry.sources.add('tags');
        entry.title ||= rec.title;
        entry.artistName ||= rec.artistName;
        entry.lengthMs ??= rec.lengthMs;
      }
    }
    return [...leads.values()];
  }

  #preliminary(facts: FileFacts, lead: Lead): number {
    // Leads that only know their id (from a tag) have no name yet: give them the benefit of the doubt.
    if (lead.title === '') return 0.5;
    return scoreCandidate({
      tags: facts.tags,
      fileDurationMs: facts.durationMs,
      title: lead.title,
      artists: lead.artistName ? [lead.artistName] : [],
      album: null,
      lengthMs: lead.lengthMs,
      trackNumber: null,
      discNumber: null,
      acoustScore: lead.acoustScore,
    }).score;
  }

  async #releaseGroupOfTaggedRelease(
    tags: ExistingTags,
    options: RequestOptions,
  ): Promise<string | null> {
    if (tags.mbReleaseId === null) return null;
    try {
      return (await this.#metadata.getRelease(tags.mbReleaseId, options)).releaseGroupMbid;
    } catch (err) {
      if (err instanceof MetadataError && err.kind === 'not_found') return null;
      throw err;
    }
  }

  async #buildFromLead(
    lead: Lead,
    facts: FileFacts,
    tagReleaseGroup: string | null,
    options: RequestOptions,
  ): Promise<MatchCandidate | null> {
    let detail: RecordingDetailBase;
    try {
      detail = await this.#metadata.getRecording(lead.mbid, options);
    } catch (err) {
      if (err instanceof MetadataError && err.kind === 'not_found') return null;
      throw err;
    }
    const groups = this.#orderGroups(detail, lead, facts, tagReleaseGroup);
    if (groups.length === 0) return null;
    const hints = this.#hints(facts.tags);
    let fallback: Resolved | null = null;
    for (const rg of groups.slice(0, 2)) {
      const resolved = await this.resolve(rg, detail.mbid, detail.title, hints, options);
      if (!resolved) continue;
      if (resolved.track) {
        return this.#assemble(lead, detail, facts, resolved, resolved.track);
      }
      fallback ??= resolved;
    }
    if (!fallback) return null;
    // The recording is not on the inspected releases: keep the release, number from the tags.
    const synthetic: TrackBase = {
      mbid: detail.mbid,
      title: detail.title,
      discNumber: facts.tags.discNumber ?? 1,
      position: facts.tags.trackNumber ?? 1,
      number: null,
      lengthMs: detail.lengthMs,
      artistCredit: detail.artistCredit,
      artistName: detail.artistName,
      isrcs: detail.isrcs,
    };
    return this.#assemble(lead, detail, facts, fallback, synthetic);
  }

  #assemble(
    lead: Lead,
    detail: RecordingDetailBase,
    facts: FileFacts,
    resolved: Resolved,
    track: TrackBase,
  ): MatchCandidate | null {
    return assembleCandidate({
      facts,
      resolved,
      track,
      recordingIsrcs: detail.isrcs,
      sources: [...lead.sources].sort(),
      acoustScore: lead.acoustScore,
      acoustId: lead.acoustId,
      releaseGroupMbids: detail.releaseGroups.map((rg) => rg.mbid),
      coverBaseUrl: this.#coverBaseUrl(),
    });
  }

  /** The release group of the tagged release first, then a title match, then AcoustID's, then MusicBrainz's order. */
  #orderGroups(
    detail: RecordingDetailBase,
    lead: Lead,
    facts: FileFacts,
    tagReleaseGroup: string | null,
  ): string[] {
    const album = facts.tags.album === null ? null : normalizeTitle(facts.tags.album);
    const points = (rg: RecordingDetailBase['releaseGroups'][number]): number =>
      (rg.mbid === tagReleaseGroup ? 4 : 0) +
      (album !== null && normalizeTitle(rg.title) === album ? 2 : 0) +
      (lead.releaseGroupHints.includes(rg.mbid) ? 1 : 0);
    // Array.sort is stable, so equal points keep MusicBrainz's "home album first" order.
    return [...detail.releaseGroups].sort((a, b) => points(b) - points(a)).map((rg) => rg.mbid);
  }

  #hints(tags: ExistingTags, preferReleaseMbid?: string): ReleaseHints {
    return {
      releaseMbids: tags.mbReleaseId === null ? [] : [tags.mbReleaseId],
      album: tags.album,
      trackTotal: tags.trackTotal,
      preferReleaseMbid,
    };
  }

  /**
   * Find where a recording sits on a release group: rank the group's releases with the hints
   * and look through the tracklists of the best three. Returns null for an unknown group.
   */
  async resolve(
    groupMbid: string,
    recordingMbid: string,
    title: string,
    hints: ReleaseHints,
    options: RequestOptions = {},
  ): Promise<Resolved | null> {
    let group: ReleaseGroupDetailBase;
    try {
      group = await this.#metadata.getReleaseGroup(groupMbid, options);
    } catch (err) {
      if (err instanceof MetadataError && err.kind === 'not_found') return null;
      throw err;
    }
    const ranked = rankReleases(group, hints);
    for (const release of ranked.slice(0, RELEASES_TO_INSPECT)) {
      const tracks = await this.#tracksOf(group, release, options);
      const track = findTrack(tracks, recordingMbid, title);
      if (track) return { group, release, tracks, track };
    }
    const first = ranked[0] ?? group.representativeRelease;
    if (!first) return null;
    return {
      group,
      release: first,
      tracks: await this.#tracksOf(group, first, options),
      track: null,
    };
  }

  async #tracksOf(
    group: ReleaseGroupDetailBase,
    release: ReleaseSummary,
    options: RequestOptions,
  ): Promise<TrackBase[]> {
    if (release.mbid === group.representativeRelease?.mbid) return group.tracks;
    return (await this.#metadata.getRelease(release.mbid, options)).tracks;
  }

  // --- album grouping -----------------------------------------------------------------------------

  /**
   * Make the files of one batch agree on a release. The release group that appears among the
   * candidates of the most files (at least two) wins, ties going to the higher total score; the
   * release inside it is the one covering the most files (hints: tagged release ids, album title,
   * track count). Each file that appears on that release gets its candidate rebuilt there, with
   * consistent track and disc numbers. With fewer than two files sharing a group, nothing changes.
   */
  async group(
    members: readonly GroupMember[],
    options: RequestOptions = {},
  ): Promise<GroupOutcome> {
    const none: GroupOutcome = { group: null, updated: new Map() };
    if (members.length < 2) return none;

    const votes = new Map<string, { files: Set<string>; score: number }>();
    for (const member of members) {
      const best = new Map<string, number>();
      for (const c of member.candidates) {
        if (c.score < MIN_GROUPING_SCORE) continue;
        for (const rg of new Set([c.releaseGroupMbid, ...c.releaseGroupMbids])) {
          best.set(rg, Math.max(best.get(rg) ?? 0, c.score));
        }
      }
      for (const [rg, score] of best) {
        const entry = votes.get(rg) ?? { files: new Set<string>(), score: 0 };
        entry.files.add(member.uploadId);
        entry.score += score;
        votes.set(rg, entry);
      }
    }
    const winner = [...votes.entries()]
      .filter(([, v]) => v.files.size >= 2)
      .sort(
        ([ra, a], [rb, b]) =>
          b.files.size - a.files.size || b.score - a.score || ra.localeCompare(rb),
      )[0];
    if (!winner) return none;
    const [groupMbid, vote] = winner;
    const placed = members.filter((m) => vote.files.has(m.uploadId));

    let group: ReleaseGroupDetailBase;
    try {
      group = await this.#metadata.getReleaseGroup(groupMbid, options);
    } catch (err) {
      if (err instanceof MetadataError && err.kind === 'not_found') return none;
      throw err;
    }
    const taggedReleases = members.flatMap((m) =>
      m.facts.tags.mbReleaseId === null ? [] : [m.facts.tags.mbReleaseId],
    );
    const albumVotes = new Map<string, number>();
    for (const m of placed) {
      if (m.facts.tags.album !== null) {
        const key = normalizeTitle(m.facts.tags.album);
        albumVotes.set(key, (albumVotes.get(key) ?? 0) + 1);
      }
    }
    const album = [...albumVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const totals = placed.flatMap((m) =>
      m.facts.tags.trackTotal === null ? [] : [m.facts.tags.trackTotal],
    );
    const ranked = rankReleases(group, {
      releaseMbids: taggedReleases,
      album,
      trackTotal: totals[0] ?? placed.length,
    });

    // Pick the release whose tracklist holds the most files; ranking order breaks ties.
    let best: { release: ReleaseSummary; tracks: TrackBase[]; coverage: number } | null = null;
    for (const release of ranked.slice(0, RELEASES_TO_INSPECT)) {
      const tracks = await this.#tracksOf(group, release, options);
      const coverage = placed.filter((m) => findMemberTrack(m, tracks) !== null).length;
      if (best === null || coverage > best.coverage) best = { release, tracks, coverage };
    }
    if (best === null || best.coverage < 2) return none;

    const updated = new Map<string, MatchCandidate[]>();
    const trackMap: AlbumGroup['tracks'] = [];
    const resolved: Resolved = { group, release: best.release, tracks: best.tracks, track: null };
    for (const member of placed) {
      const hit = findMemberTrack(member, best.tracks);
      if (!hit) continue;
      const base = hit.candidate;
      const rebuilt = assembleCandidate({
        facts: member.facts,
        resolved,
        track: hit.track,
        recordingIsrcs: base.tags.isrc ? [base.tags.isrc] : [],
        sources: base.sources,
        acoustScore: base.breakdown.acoustId,
        acoustId: base.tags.acoustId ?? null,
        releaseGroupMbids: base.releaseGroupMbids,
        coverBaseUrl: this.#coverBaseUrl(),
      });
      if (!rebuilt) continue;
      const others = member.candidates.filter((c) => c.recordingMbid !== rebuilt.recordingMbid);
      updated.set(member.uploadId, sortCandidates([rebuilt, ...others]));
      trackMap.push({
        uploadId: member.uploadId,
        recordingMbid: rebuilt.recordingMbid,
        discNumber: rebuilt.discNumber,
        trackNumber: rebuilt.trackNumber,
      });
    }
    if (trackMap.length < 2) return none;
    const placedIds = new Set(trackMap.map((t) => t.uploadId));
    return {
      group: {
        releaseMbid: best.release.mbid,
        releaseGroupMbid: group.mbid,
        title: best.release.title,
        artist: group.artistName,
        trackTotal: best.tracks.length,
        tracks: trackMap,
        unmatchedUploadIds: members
          .filter((m) => !placedIds.has(m.uploadId))
          .map((m) => m.uploadId),
      },
      updated,
    };
  }
}

/** The track for a recording: the same recording id, else the same normalised title. */
export function findTrack(
  tracks: readonly TrackBase[],
  recordingMbid: string,
  title: string,
): TrackBase | null {
  const byId = tracks.find((t) => t.mbid === recordingMbid);
  if (byId) return byId;
  const wanted = normalizeTitle(title);
  if (wanted === '') return null;
  const byTitle = tracks.filter((t) => normalizeTitle(t.title) === wanted);
  return byTitle.length === 1 ? (byTitle[0] ?? null) : null;
}

/** Which track of a release a batch member is, and via which of its candidates. */
function findMemberTrack(
  member: GroupMember,
  tracks: readonly TrackBase[],
): { track: TrackBase; candidate: MatchCandidate } | null {
  for (const candidate of member.candidates) {
    const track = tracks.find((t) => t.mbid === candidate.recordingMbid);
    if (track) return { track, candidate };
  }
  const best = member.candidates[0];
  if (best) {
    const track = findTrack(tracks, '', best.title);
    if (track) return { track, candidate: best };
  }
  return null;
}

// --- duplicates ------------------------------------------------------------------------------------

/** Upload states in which a file with the same sha256 already counts as taken. */
const SHA_BLOCKING_STATUSES = [
  'RECEIVED',
  'ANALYZING',
  'NEEDS_REVIEW',
  'APPROVED',
  'IMPORTING',
  'IMPORTED',
] as const;

export interface DuplicateQuery {
  uploadId: string;
  sha256: string | null;
  createdAt: Date;
  /** The recording the file was matched to, if any. */
  recordingMbid: string | null;
  /** Every spelling of the artist credit worth trying. */
  artists: readonly string[];
  title: string | null;
  durationMs: number | null;
}

export class DuplicateChecker {
  readonly #db: Db;
  readonly #lookup: LibraryLookup;

  constructor(db: Db, lookup?: LibraryLookup) {
    this.#db = db;
    this.#lookup = lookup ?? new FuzzyLibraryLookup(db);
  }

  /**
   * (a) The same sha256 already imported, or in flight under another upload that got there
   * first (earlier creation time, then id, so two identical files in one batch never flag each
   * other).
   */
  bySha256(query: Pick<DuplicateQuery, 'uploadId' | 'sha256' | 'createdAt'>): DuplicateInfo | null {
    if (query.sha256 === null) return null;
    const rows = this.#db
      .select({ id: uploads.id, status: uploads.status, createdAt: uploads.createdAt })
      .from(uploads)
      .where(
        and(eq(uploads.sha256, query.sha256), inArray(uploads.status, [...SHA_BLOCKING_STATUSES])),
      )
      .all();
    for (const row of rows) {
      if (row.id === query.uploadId) continue;
      const earlier =
        row.createdAt.getTime() < query.createdAt.getTime() ||
        (row.createdAt.getTime() === query.createdAt.getTime() && row.id < query.uploadId);
      if (row.status === 'IMPORTED') {
        return {
          kind: 'sha256',
          message: 'This exact file has already been imported',
          uploadId: row.id,
        };
      }
      if (earlier) {
        return {
          kind: 'sha256',
          message: 'This exact file is already being processed as another upload',
          uploadId: row.id,
        };
      }
    }
    return null;
  }

  /** (b) the recording id is in the library index; (c) artist|title matches within 3 s. */
  byLibrary(
    query: Pick<DuplicateQuery, 'recordingMbid' | 'artists' | 'title' | 'durationMs'>,
  ): DuplicateInfo | null {
    if (query.recordingMbid !== null) {
      const row = this.#db
        .select({ id: libraryItems.serverItemId })
        .from(libraryItems)
        .where(
          and(eq(libraryItems.kind, 'track'), eq(libraryItems.mbRecordingId, query.recordingMbid)),
        )
        .limit(1)
        .get();
      if (row) {
        return {
          kind: 'recording',
          message: 'This recording is already in the library',
          libraryItemId: row.id,
        };
      }
    }
    if (query.artists.length > 0 && query.title !== null) {
      const key = query.recordingMbid ?? `file:${query.title}`;
      const status = this.#lookup
        .lookup({
          artists: [],
          albums: [],
          tracks: [key],
          hints: {
            tracks: new Map([
              [key, { artists: query.artists, title: query.title, durationMs: query.durationMs }],
            ]),
          },
        })
        .tracks.get(key);
      if (status === 'yes' || status === 'possible') {
        return {
          kind: 'fuzzy',
          message:
            'A track with the same artist and title and a similar length is already in the library',
        };
      }
    }
    return null;
  }
}
