import { listen, sendJson, type MockService } from './http.ts';

export interface ReceivedWebhook {
  receivedAt: string;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON body, or the raw text when it was not JSON. */
  body: unknown;
}

export interface WebhookReceiver extends MockService {
  /** URL to configure as a notification target. */
  readonly hookUrl: string;
  readonly received: ReceivedWebhook[];
}

/**
 * Stores every POST to `/hook`. `GET /received` lists them, `DELETE /received` clears the list.
 * `?status=500` on the hook URL makes it fail, to exercise retries.
 */
export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  const received: ReceivedWebhook[] = [];
  const service = await listen((req, res, url, raw) => {
    if (url.pathname === '/received') {
      if (req.method === 'DELETE') {
        received.length = 0;
        sendJson(res, 204);
        return;
      }
      sendJson(res, 200, received);
      return;
    }
    if (url.pathname === '/hook' && req.method === 'POST') {
      const text = raw.toString('utf8');
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // keep the raw text
      }
      const status = Number(url.searchParams.get('status') ?? '204');
      if (status < 400) {
        received.push({
          receivedAt: new Date().toISOString(),
          method: req.method,
          path: url.pathname,
          headers: req.headers,
          body,
        });
      }
      sendJson(res, status);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });
  return { ...service, hookUrl: `${service.origin}/hook`, received };
}
