import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listen, sendJson, type MockService } from './http.ts';

/** Fixtures recorded for the server tests; the E2E mock serves the very same files. */
const FIXTURES = join(
  import.meta.dirname,
  '..',
  '..',
  'apps',
  'server',
  'test',
  'fixtures',
  'musicbrainz',
);

/** Ids that appear in the fixtures (see the server's mbServer test helper). */
export const MB_IDS = {
  artist: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
  releaseGroup: 'b1392450-e666-3926-a536-22c65f834433',
  release: '1834eae1-741b-3c03-9ca5-0df3decb43ea',
  recording: '9f9cf187-d6f9-437f-9d98-d59cdbd52757',
} as const;

export interface MusicBrainzMock extends MockService {
  /** Value for `metadata.musicBrainzBaseUrl`. */
  readonly musicBrainzBaseUrl: string;
  /** Value for `metadata.coverArtBaseUrl`. */
  readonly coverArtBaseUrl: string;
  /** Paths requested so far (for assertions). */
  readonly requests: string[];
}

const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.json`), 'utf8');

/** Which fixture answers a WS/2 path, mirroring the endpoints Hearer calls. */
function fixtureFor(path: string, query: URLSearchParams): string | null {
  const [entity, id] = path.split('/');
  if (entity === 'artist') return id ? 'artist' : 'search-artist';
  if (entity === 'recording') return id ? 'recording' : 'search-recording';
  if (entity === 'release-group') {
    if (id) return 'release-group';
    return query.has('query') ? 'search-release-group' : 'artist-release-groups';
  }
  if (entity === 'release') return id ? 'release' : 'release-group-releases';
  return null;
}

/**
 * MusicBrainz WS/2 (fixtures) plus the Cover Art Archive (one generated JPEG for every cover) on
 * a single port: WS/2 lives under `/ws/2`, the archive under `/caa`.
 */
export async function startMusicBrainzMock(coverJpeg: Buffer): Promise<MusicBrainzMock> {
  const requests: string[] = [];
  const service = await listen((_req, res, url) => {
    requests.push(url.pathname);
    if (url.pathname.startsWith('/caa/')) {
      // /caa/<release-group|release>/<mbid>/front-<size>
      if (/^\/caa\/(?:release-group|release)\/[0-9a-f-]{36}\/front(?:-\d+)?$/u.test(url.pathname)) {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': coverJpeg.length });
        res.end(coverJpeg);
        return;
      }
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (url.pathname.startsWith('/ws/2/')) {
      const name = fixtureFor(url.pathname.slice('/ws/2/'.length), url.searchParams);
      if (name) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(fixture(name));
        return;
      }
    }
    sendJson(res, 404, { error: 'not found' });
  });
  return {
    ...service,
    musicBrainzBaseUrl: `${service.origin}/ws/2`,
    coverArtBaseUrl: `${service.origin}/caa`,
    requests,
  };
}
