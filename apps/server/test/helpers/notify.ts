import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NotificationMessage } from '@hearer/shared';
import type { AgentContext } from '../../src/adapters/notify/types.ts';

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  /** The raw body exactly as received. */
  raw: string;
  json: unknown;
}

/** A real local HTTP server (port 0) that records requests and answers with a scripted status. */
export class HttpMock {
  server!: Server;
  url = '';
  requests: Recorded[] = [];
  /** Statuses to answer with, one per request; the last one repeats. */
  statuses: number[] = [200];
  delayMs = 0;

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const json = ((): unknown => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })();
        const index = this.requests.length;
        this.requests.push({
          method: req.method ?? '',
          path: req.url ?? '',
          headers: req.headers,
          raw,
          json,
        });
        const status = this.statuses[Math.min(index, this.statuses.length - 1)] ?? 200;
        setTimeout(() => {
          res.writeHead(status, { 'content-type': 'text/plain' });
          res.end(status < 300 ? 'ok' : `mock says ${String(status)}`);
        }, this.delayMs);
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}

export const ctx = (overrides: Partial<AgentContext> = {}): AgentContext => ({
  fetch,
  timeoutMs: 5000,
  userAgent: 'Hearer/test',
  ...overrides,
});

export function message(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    event: 'request.created',
    title: 'New request awaiting approval',
    body: 'alice requested the album "OK Computer" by Radiohead.',
    url: 'https://hearer.example/requests/r1',
    imageUrl: 'https://img.example/cover.jpg',
    fields: [
      { name: 'Type', value: 'album' },
      { name: 'Requested by', value: 'alice' },
    ],
    actor: 'alice',
    subject: {
      kind: 'request',
      id: 'r1',
      title: 'OK Computer',
      artist: 'Radiohead',
      type: 'album',
      status: 'PENDING',
    },
    appTitle: 'Hearer',
    timestamp: '2026-01-01T00:00:00.000Z',
    data: { requestId: 'r1', status: 'PENDING' },
    ...overrides,
  };
}
