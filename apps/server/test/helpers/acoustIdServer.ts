import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface AcoustIdRequest {
  params: URLSearchParams;
  headers: IncomingMessage['headers'];
  method: string;
  path: string;
  at: number;
}

export interface AcoustIdReply {
  status?: number;
  headers?: Record<string, string>;
  /** Object (serialised) or raw string. */
  body: unknown;
}

/** A local stand-in for api.acoustid.org. `respond` decides every answer. */
export class AcoustIdMock {
  readonly requests: AcoustIdRequest[] = [];
  respond: (request: AcoustIdRequest) => AcoustIdReply = () => ({
    body: { status: 'ok', results: [] },
  });
  readonly #server: Server;

  private constructor() {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const request: AcoustIdRequest = {
          params: new URLSearchParams(Buffer.concat(chunks).toString('utf8')),
          headers: req.headers,
          method: req.method ?? '',
          path: req.url ?? '',
          at: Date.now(),
        };
        this.requests.push(request);
        const reply = this.respond(request);
        res.writeHead(reply.status ?? 200, {
          'content-type': 'application/json',
          ...reply.headers,
        });
        res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
      });
    });
  }

  static async start(): Promise<AcoustIdMock> {
    const mock = new AcoustIdMock();
    await new Promise<void>((resolve) => mock.#server.listen(0, '127.0.0.1', resolve));
    return mock;
  }

  /** Value for `metadata.acoustIdBaseUrl`. */
  get baseUrl(): string {
    return `http://127.0.0.1:${String((this.#server.address() as AddressInfo).port)}/v2`;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }
}

/** An AcoustID success body for one fingerprint hit on the given recordings. */
export function acoustIdOk(
  recordings: { id: string; title?: string; artist?: string; duration?: number; rg?: string }[],
  score = 0.98,
): unknown {
  return {
    status: 'ok',
    results: [
      {
        id: 'acoustid-track-1',
        score,
        recordings: recordings.map((r) => ({
          id: r.id,
          title: r.title ?? 'Paranoid Android',
          duration: r.duration ?? 384,
          artists: [{ id: 'a74b1b7f-71a5-4011-9441-d0b5e4122711', name: r.artist ?? 'Radiohead' }],
          releasegroups: r.rg
            ? [
                {
                  id: r.rg,
                  title: 'OK Computer',
                  type: 'Album',
                  releases: [
                    {
                      id: '1834eae1-741b-3c03-9ca5-0df3decb43ea',
                      title: 'OK Computer',
                      date: { year: 1997, month: 5, day: 21 },
                      track_count: 12,
                      mediums: [
                        { position: 1, track_count: 12, tracks: [{ id: 't1', position: 2 }] },
                      ],
                    },
                  ],
                },
              ]
            : [],
        })),
      },
    ],
  };
}
