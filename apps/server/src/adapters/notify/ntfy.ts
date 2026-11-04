import { z } from 'zod';
import { sendHttp, type NotificationAgent, type NotificationMessage } from './types.ts';

export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';

export const ntfyConfigSchema = z.object({
  serverUrl: z
    .url({ protocol: /^https?$/ })
    .default(DEFAULT_NTFY_SERVER)
    .describe('ntfy server. Leave the default to use the public ntfy.sh.'),
  topic: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'letters, digits, _ and - only (max 64)')
    .describe('Anyone who knows the topic can read it on a public server; make it hard to guess.'),
  token: z.string().max(500).default('').describe('Access token (Bearer). Takes precedence.'),
  username: z.string().max(200).default(''),
  password: z.string().max(500).default(''),
  priority: z.number().int().min(1).max(5).default(3).describe('1 = min, 3 = default, 5 = max.'),
  userTopics: z
    .boolean()
    .default(false)
    .describe(
      'Use this server and its credentials for the personal ntfy topics users set in their own notification settings.',
    ),
});
export type NtfyConfig = z.infer<typeof ntfyConfigSchema>;

const TAGS: Record<string, string> = {
  'request.created': 'hourglass_flowing_sand',
  'request.approved': 'white_check_mark',
  'request.declined': 'no_entry_sign',
  'request.available': 'tada',
  'request.partially_available': 'musical_note',
  'request.failed': 'x',
  'upload.needs_review': 'mag',
  'upload.duplicate': 'busts_in_silhouette',
  'upload.imported': 'inbox_tray',
  'upload.failed': 'x',
  test: 'test_tube',
};

/** Header values must be latin-1 for fetch; ntfy decodes RFC 2047 encoded words in headers. */
export function encodeHeader(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ');

  if (/^[\x20-\x7e]*$/.test(flat)) return flat;
  return `=?UTF-8?B?${Buffer.from(flat, 'utf8').toString('base64')}?=`;
}

export function ntfyHeaders(
  message: NotificationMessage,
  config: NtfyConfig,
): Record<string, string> {
  const headers: Record<string, string> = {
    Title: encodeHeader(message.title),
    Priority: String(
      message.event.endsWith('failed') ? Math.max(4, config.priority) : config.priority,
    ),
    Tags: TAGS[message.event] ?? 'bell',
    Markdown: 'no',
  };
  if (message.url) headers.Click = message.url;
  if (message.imageUrl) headers.Attach = message.imageUrl;
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  else if (config.username) {
    headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  }
  return headers;
}

export function ntfyBody(message: NotificationMessage): string {
  const lines = message.fields.map((f) => `${f.name}: ${f.value}`);
  return [message.body, ...lines].filter(Boolean).join('\n');
}

/** Publishes with the ntfy header API (https://docs.ntfy.sh/publish/). */
export const ntfyAgent: NotificationAgent<NtfyConfig> = {
  id: 'ntfy',
  label: 'ntfy',
  description: 'Push notifications through ntfy.sh or a self-hosted ntfy server.',
  configSchema: ntfyConfigSchema,
  secrets: ['token', 'password'],
  async send(message, config, ctx) {
    const base = config.serverUrl.replace(/\/+$/, '');
    await sendHttp(ctx, 'ntfy', `${base}/${config.topic}`, {
      headers: ntfyHeaders(message, config),
      body: ntfyBody(message),
    });
  },
};
