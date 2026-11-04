import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { sendJson, type MockService } from './http.ts';

/** What Cloudflare-style edges allow: bodies above this are refused with 413. */
export const PROXY_BODY_LIMIT_BYTES = 100 * 1000 * 1000;

export interface ProxyMock extends MockService {
  readonly stats: { rejected: number; dropped: number; forwarded: number; maxBodyBytes: number };
  /**
   * Control: `POST /__proxy/drop-once?after=<bytes>` arms a single connection drop in the middle
   * of the next request body that is at least `after` bytes long (default 1 MB).
   */
  armDropOnce: (afterBytes?: number) => void;
}

/**
 * A tiny streaming reverse proxy that behaves like an edge with a request body cap: a request
 * whose Content-Length (or streamed size) exceeds 100 MB is answered 413. It never buffers
 * bodies. It can be told to cut the connection once, halfway through a request body, to prove
 * that resumable uploads recover.
 */
export async function startProxy(target: { port: number }): Promise<ProxyMock> {
  const stats = { rejected: 0, dropped: 0, forwarded: 0, maxBodyBytes: 0 };
  let dropAfter: number | undefined;

  // Not `listen()` from http.ts: that buffers whole bodies, which a proxy must not do.
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://proxy.invalid');
    if (url.pathname === '/__proxy/drop-once' && req.method === 'POST') {
      dropAfter = Number(url.searchParams.get('after') ?? '1000000');
      sendJson(res, 204);
      req.resume();
      return;
    }
    if (url.pathname === '/__proxy/stats') {
      sendJson(res, 200, stats);
      req.resume();
      return;
    }
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > PROXY_BODY_LIMIT_BYTES) {
      stats.rejected++;
      res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
      res.end('413 Request Entity Too Large (proxy body limit)');
      req.destroy();
      return;
    }
    stats.maxBodyBytes = Math.max(stats.maxBodyBytes, declared);
    const headers: IncomingHttpHeaders = { ...req.headers };
    const upstream = httpRequest(
      { host: '127.0.0.1', port: target.port, method: req.method, path: req.url, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        stats.forwarded++;
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    let seen = 0;
    // Only the first request that is big enough for the armed drop is cut.
    const cutAt =
      dropAfter !== undefined && declared >= dropAfter ? Math.floor(declared / 2) : undefined;
    if (cutAt !== undefined) dropAfter = undefined;
    req.on('data', (chunk: Buffer) => {
      seen += chunk.length;
      if (cutAt !== undefined && seen >= cutAt) {
        stats.dropped++;
        upstream.destroy();
        req.socket.destroy();
      }
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    port,
    stats,
    armDropOnce: (after = 1_000_000) => {
      dropAfter = after;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
