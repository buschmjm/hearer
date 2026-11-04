import { listen, sendJson, type MockService } from './http.ts';
import { MB_IDS } from './musicbrainz.ts';

export interface AcoustIdRecordingHit {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  durationSeconds: number;
  releaseGroupId: string;
  releaseGroupTitle: string;
  releaseId: string;
  year: number;
  /** 1-based position of the track on the release. */
  position: number;
  trackCount: number;
}

export interface AcoustIdConfig {
  /** Match score reported for the hit. */
  score: number;
  /** Recordings returned for any fingerprint; empty means "no match". */
  recordings: AcoustIdRecordingHit[];
}

export interface AcoustIdMock extends MockService {
  /** Value for `metadata.acoustIdBaseUrl`. */
  readonly acoustIdBaseUrl: string;
  config: AcoustIdConfig;
  /** Form bodies received, newest last. */
  readonly lookups: URLSearchParams[];
}

/** The default hit: "Paranoid Android" from the OK Computer fixtures. */
export const DEFAULT_ACOUSTID_HIT: AcoustIdRecordingHit = {
  id: MB_IDS.recording,
  title: 'Paranoid Android',
  artist: 'Radiohead',
  artistId: MB_IDS.artist,
  durationSeconds: 384,
  releaseGroupId: MB_IDS.releaseGroup,
  releaseGroupTitle: 'OK Computer',
  releaseId: MB_IDS.release,
  year: 1997,
  position: 2,
  trackCount: 12,
};

function body(config: AcoustIdConfig): unknown {
  if (config.recordings.length === 0) return { status: 'ok', results: [] };
  return {
    status: 'ok',
    results: [
      {
        id: 'e2e-acoustid-track',
        score: config.score,
        recordings: config.recordings.map((r) => ({
          id: r.id,
          title: r.title,
          duration: r.durationSeconds,
          artists: [{ id: r.artistId, name: r.artist }],
          releasegroups: [
            {
              id: r.releaseGroupId,
              title: r.releaseGroupTitle,
              type: 'Album',
              releases: [
                {
                  id: r.releaseId,
                  title: r.releaseGroupTitle,
                  date: { year: r.year },
                  track_count: r.trackCount,
                  mediums: [
                    {
                      position: 1,
                      track_count: r.trackCount,
                      tracks: [{ id: `${r.id}-track`, position: r.position }],
                    },
                  ],
                },
              ],
            },
          ],
        })),
      },
    ],
  };
}

/**
 * AcoustID web service double. Any fingerprint resolves to `config.recordings`. Change the
 * answer at runtime with `POST /__mock/config` (JSON, partial `AcoustIdConfig`).
 */
export async function startAcoustIdMock(
  initial: Partial<AcoustIdConfig> = {},
): Promise<AcoustIdMock> {
  const lookups: URLSearchParams[] = [];
  const state = { config: { score: 0.98, recordings: [DEFAULT_ACOUSTID_HIT], ...initial } };
  const service = await listen((req, res, url, raw) => {
    if (url.pathname === '/__mock/config' && req.method === 'POST') {
      state.config = { ...state.config, ...(JSON.parse(raw.toString('utf8')) as object) };
      sendJson(res, 204);
      return;
    }
    if (url.pathname === '/__mock/lookups') {
      sendJson(
        res,
        200,
        lookups.map((l) => Object.fromEntries(l)),
      );
      return;
    }
    if (url.pathname === '/v2/lookup' && req.method === 'POST') {
      lookups.push(new URLSearchParams(raw.toString('utf8')));
      sendJson(res, 200, body(state.config));
      return;
    }
    sendJson(res, 404, { status: 'error', error: { code: 2, message: 'not found' } });
  });
  return {
    ...service,
    acoustIdBaseUrl: `${service.origin}/v2`,
    get config() {
      return state.config;
    },
    set config(value: AcoustIdConfig) {
      state.config = value;
    },
    lookups,
  };
}
