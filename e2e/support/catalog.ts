import type { AcoustIdRecordingHit } from '../mocks/index.ts';
import { DEFAULT_ACOUSTID_HIT, MB_IDS } from '../mocks/index.ts';

/** Tracks of the "OK Computer" release in the MusicBrainz fixtures (12 tracks in total). */
export const OK_COMPUTER = {
  artist: 'Radiohead',
  artistId: MB_IDS.artist,
  title: 'OK Computer',
  year: 1997,
  releaseGroupId: MB_IDS.releaseGroup,
  releaseId: MB_IDS.release,
  trackCount: 12,
  tracks: {
    airbag: {
      position: 1,
      title: 'Airbag',
      recordingId: '4a7fea2e-545b-4c63-bc9a-9943cc3a29d7',
      seconds: 284.4,
    },
    paranoid: {
      position: 2,
      title: 'Paranoid Android',
      recordingId: MB_IDS.recording,
      seconds: 383.5,
    },
    exitMusic: {
      position: 4,
      title: 'Exit Music (for a Film)',
      recordingId: '23c3c36b-9449-4484-9040-6ef2125999aa',
      seconds: 264.8,
    },
    letDown: {
      position: 5,
      title: 'Let Down',
      recordingId: '47b02a82-c3bf-4647-b894-dd1c8f608e7f',
      seconds: 299.3,
    },
    karmaPolice: {
      position: 6,
      title: 'Karma Police',
      recordingId: '9e2ad5bc-c6f9-40d2-a36f-3122ee2072a3',
      seconds: 261.6,
    },
    lucky: {
      position: 11,
      title: 'Lucky',
      recordingId: '79047824-f821-4b1a-9893-e0cea1c947dd',
      seconds: 259.6,
    },
    noSurprises: {
      position: 10,
      title: 'No Surprises',
      recordingId: '980a426e-623e-4ea5-98c7-008d037a0508',
      seconds: 228.5,
    },
  },
} as const;

type FixtureTrack = (typeof OK_COMPUTER.tracks)[keyof typeof OK_COMPUTER.tracks];

/** The AcoustID answer for one fixture track. */
export function acoustIdHit(track: FixtureTrack): AcoustIdRecordingHit {
  return {
    ...DEFAULT_ACOUSTID_HIT,
    id: track.recordingId,
    title: track.title,
    durationSeconds: Math.round(track.seconds),
    position: track.position,
  };
}

/** Tags for a generated file that is a correctly tagged copy of a fixture track. */
export function taggedLike(track: FixtureTrack): Record<string, string | number> {
  return {
    title: track.title,
    artist: OK_COMPUTER.artist,
    albumArtist: OK_COMPUTER.artist,
    album: OK_COMPUTER.title,
    track: track.position,
    date: String(OK_COMPUTER.year),
  };
}

/** Library path the default naming template gives a fixture track as FLAC. */
export const libraryPathOf = (track: FixtureTrack, ext = 'flac'): string =>
  `${OK_COMPUTER.artist}/${OK_COMPUTER.title} (${String(OK_COMPUTER.year)})/${String(track.position).padStart(2, '0')} - ${track.title}.${ext}`;
