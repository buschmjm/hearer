import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

export const IDS = {
  artist: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
  releaseGroup: 'b1392450-e666-3926-a536-22c65f834433',
  release: '1834eae1-741b-3c03-9ca5-0df3decb43ea',
  recording: '9f9cf187-d6f9-437f-9d98-d59cdbd52757',
  /** First track of the fixture release ("Airbag"). */
  airbag: '4a7fea2e-545b-4c63-bc9a-9943cc3a29d7',
};

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'musicbrainz');
/** The element at `index`; fails the test when absent (no non-null assertions in tests). */
export function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an element at index ${String(index)}`);
  return item;
}

export const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.json`), 'utf8');

export interface Recorded {
  /** Path after /ws/2, e.g. "release-group/<id>". */
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  at: number;
}

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  delayMs?: number;
}

export type Override = (request: Recorded) => Reply | undefined;

/** Which fixture answers a request, mirroring the MusicBrainz WS/2 endpoints we call. */
function fixtureFor(path: string, query: URLSearchParams): string | null {
  const parts = path.split('/');
  const [entity, id] = parts;
  if (entity === 'artist') return id ? 'artist' : 'search-artist';
  if (entity === 'recording') return id ? 'recording' : 'search-recording';
  if (entity === 'release-group') {
    if (id) return 'release-group';
    return query.has('query') ? 'search-release-group' : 'artist-release-groups';
  }
  if (entity === 'release') return id ? 'release' : 'release-group-releases';
  return null;
}

/** A local stand-in for musicbrainz.org that serves the committed fixtures. */
export class FixtureServer {
  readonly requests: Recorded[] = [];
  /** Return a Reply to replace the fixture answer for a request. */
  override: Override | undefined;
  readonly #server: Server;

  private constructor() {
    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });
  }

  static async start(): Promise<FixtureServer> {
    const instance = new FixtureServer();
    await new Promise<void>((resolve) => instance.#server.listen(0, '127.0.0.1', resolve));
    return instance;
  }

  /** Base URL as configured in `metadata.musicBrainzBaseUrl`. */
  get baseUrl(): string {
    return `http://127.0.0.1:${String((this.#server.address() as AddressInfo).port)}/ws/2`;
  }

  /** Requests whose path starts with `prefix`. */
  to(prefix: string): Recorded[] {
    return this.requests.filter((r) => r.path.startsWith(prefix));
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const recorded: Recorded = {
      path: url.pathname.replace(/^\/ws\/2\//, ''),
      query: url.searchParams,
      headers: req.headers,
      at: Date.now(),
    };
    this.requests.push(recorded);
    const reply = this.override?.(recorded);
    const name = fixtureFor(recorded.path, recorded.query);
    const status = reply?.status ?? (name ? 200 : 404);
    const body = reply?.body ?? (reply?.status === undefined && name ? fixture(name) : '{}');
    if (reply?.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    res.writeHead(status, { 'content-type': 'application/json', ...reply?.headers });
    res.end(body);
  }
}
