import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockService {
  /** Origin without a trailing slash, e.g. `http://127.0.0.1:41234`. */
  readonly origin: string;
  readonly port: number;
  stop: () => Promise<void>;
}

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer,
) => unknown;

/** Start an HTTP server on a free loopback port. Every request body is buffered for the handler. */
export async function listen(handler: Handler): Promise<MockService> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://mock.invalid');
      Promise.resolve(handler(req, res, url, Buffer.concat(chunks))).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(err instanceof Error ? err.message : 'mock failure');
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Answer with JSON (or an empty body). Returns true so handlers can `return sendJson(...)`. */
export function sendJson(res: ServerResponse, status: number, body?: unknown): true {
  if (body === undefined) res.writeHead(status).end();
  else res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  return true;
}
