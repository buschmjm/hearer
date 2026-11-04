import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';

/** Synthesized fixtures (see test/fixtures/jellyfin/README.md). */
export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'jellyfin', name), 'utf8'));

export const MOCK_API_KEY = 'test-api-key-0123456789';
export const MOCK_USERS = {
  alice: { password: 'alice-pass', fixture: 'authenticate-by-name.json' },
  jfadmin: { password: 'admin-pass', fixture: 'authenticate-admin.json' },
} as const;

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface MockBehavior {
  /** Status for POST /Library/Media/Updated (204 = works). */
  mediaUpdated: number;
  /** Version reported by /System/Info. */
  version: string;
  /** Delay every response by this many ms. */
  delayMs: number;
  /** Answer everything with this status (e.g. 500). */
  forceStatus: number | undefined;
}

export interface JellyfinMock {
  url: string;
  requests: RecordedRequest[];
  behavior: MockBehavior;
  close: () => Promise<void>;
}

/** A real local HTTP server that mimics the Jellyfin endpoints Hearer uses. */
export async function startJellyfinMock(): Promise<JellyfinMock> {
  const requests: RecordedRequest[] = [];
  const behavior: MockBehavior = {
    mediaUpdated: 204,
    version: '10.11.0',
    delayMs: 0,
    forceStatus: undefined,
  };
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const parsed = new URL(req.url ?? '/', 'http://mock');
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw ? (JSON.parse(raw) as unknown) : undefined;
      } catch {
        body = raw;
      }
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        path: parsed.pathname,
        query: parsed.searchParams,
        headers: req.headers,
        body,
      };
      requests.push(recorded);
      const send = (status: number, json?: unknown): boolean => {
        const finish = () => {
          if (json === undefined) {
            res.writeHead(status).end();
          } else {
            res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
          }
        };
        if (behavior.delayMs > 0) setTimeout(finish, behavior.delayMs);
        else finish();
        return true;
      };
      if (behavior.forceStatus !== undefined) return send(behavior.forceStatus);

      const auth = req.headers.authorization ?? '';
      const hasKey = auth.includes(`Token="${MOCK_API_KEY}"`);
      const route = `${recorded.method} ${recorded.path}`;
      switch (route) {
        case 'GET /System/Info': {
          if (!hasKey) return send(401);
          const info = fixture('system-info.json') as Record<string, unknown>;
          return send(200, { ...info, Version: behavior.version });
        }
        case 'POST /Users/AuthenticateByName': {
          const { Username, Pw } = (body ?? {}) as { Username?: string; Pw?: string };
          const known = Object.entries(MOCK_USERS).find(([name]) => name === Username)?.[1];
          if (!known || known.password !== Pw) return send(401);
          return send(200, fixture(known.fixture));
        }
        case 'POST /Sessions/Logout':
          return send(204);
        case 'GET /Users':
          return hasKey ? send(200, fixture('users.json')) : send(401);
        case 'GET /Items': {
          if (!hasKey) return send(401);
          const start = Number(parsed.searchParams.get('StartIndex') ?? '0');
          return send(200, fixture(start === 0 ? 'items-page-1.json' : 'items-page-2.json'));
        }
        case 'POST /Library/Media/Updated':
          return hasKey ? send(behavior.mediaUpdated) : send(401);
        case 'POST /Library/Refresh':
          return hasKey ? send(204) : send(401);
        default:
          return send(404);
      }
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      resolve();
    }),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    behavior,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** A URL where nothing listens (connection refused). */
export async function deadUrl(): Promise<string> {
  const mock = await startJellyfinMock();
  const { url } = mock;
  await mock.close();
  return url;
}
