import { z } from 'zod';
import { sendHttp, signBody, type NotificationAgent } from './types.ts';

/** Header names that would corrupt the request or the signature. */
const RESERVED_HEADERS = new Set(['content-type', 'content-length', 'host', 'x-hearer-signature']);

export const webhookConfigSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).describe('Webhook URL (for example an n8n Webhook node).'),
  headers: z
    .record(
      z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'invalid header name'),
      z
        .string()
        .max(2000)
        .regex(/^[^\r\n]*$/, 'no line breaks'),
    )
    .refine(
      (headers) => Object.keys(headers).every((name) => !RESERVED_HEADERS.has(name.toLowerCase())),
      'content-type, content-length, host and x-hearer-signature are set by Hearer',
    )
    .default({})
    .describe('Extra request headers. Do not put credentials here; use Authorization below.'),
  authorization: z
    .string()
    .max(2000)
    .regex(/^[^\r\n]*$/, 'no line breaks')
    .default('')
    .describe('Value of an Authorization header, for example "Bearer <token>".'),
  secret: z
    .string()
    .max(500)
    .default('')
    .describe('Signs the body: X-Hearer-Signature: sha256=<hmac of the raw body>.'),
  timeoutSeconds: z.number().int().min(1).max(60).default(10),
});
export type WebhookConfig = z.infer<typeof webhookConfigSchema>;

/**
 * Generic JSON webhook (n8n, Zapier, anything). Body: `{ event, message, data }` where `message`
 * is the rendered notification and `data` the raw event data (ids, statuses).
 */
export const webhookAgent: NotificationAgent<WebhookConfig> = {
  id: 'webhook',
  label: 'Webhook',
  description:
    'POSTs JSON to any URL, such as an n8n webhook. Optionally signed with an HMAC-SHA256 header.',
  configSchema: webhookConfigSchema,
  secrets: ['secret', 'authorization'],
  async send(message, config, ctx) {
    const { data, ...rendered } = message;
    const body = JSON.stringify({ event: message.event, message: rendered, data });
    const headers: Record<string, string> = {
      ...config.headers,
      'content-type': 'application/json',
      'x-hearer-event': message.event,
    };
    if (config.authorization) headers.authorization = config.authorization;
    if (config.secret) headers['x-hearer-signature'] = signBody(config.secret, body);
    const timeoutMs = Math.min(ctx.timeoutMs, config.timeoutSeconds * 1000);
    await sendHttp({ ...ctx, timeoutMs }, 'Webhook', config.url, {
      headers,
      body,
    });
  },
};
