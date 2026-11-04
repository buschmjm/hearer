import { z } from 'zod';
import { sendJson, truncate, type NotificationAgent, type NotificationMessage } from './types.ts';

/** Discord's embed limits (https://discord.com/developers/docs/resources/message#embed-object-embed-limits). */
export const DISCORD_LIMITS = {
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  author: 256,
  total: 6000,
} as const;

export const discordConfigSchema = z.object({
  webhookUrl: z
    .url({ protocol: /^https?$/ })
    .refine((url) => /\/api\/(v\d+\/)?webhooks\/\d+\/[\w-]+/.test(url), 'not a Discord webhook URL')
    .describe('Channel settings > Integrations > Webhooks > Copy Webhook URL.'),
  username: z.string().trim().max(80).default('').describe('Overrides the webhook name.'),
  avatarUrl: z.union([z.literal(''), z.url()]).default(''),
});
export type DiscordConfig = z.infer<typeof discordConfigSchema>;

const COLORS: Record<string, number> = {
  'request.created': 0xf59e0b,
  'request.approved': 0x3b82f6,
  'request.declined': 0xef4444,
  'request.available': 0x22c55e,
  'request.partially_available': 0x84cc16,
  'request.failed': 0xef4444,
  'upload.needs_review': 0xf59e0b,
  'upload.duplicate': 0x9ca3af,
  'upload.imported': 0x22c55e,
  'upload.failed': 0xef4444,
  test: 0x8b5cf6,
};

/** The embed for a message, cut to Discord's limits (including the 6000 character total). */
export function discordEmbed(message: NotificationMessage): Record<string, unknown> {
  const L = DISCORD_LIMITS;
  const fields = message.fields
    .filter((f) => f.name.trim() && f.value.trim())
    .slice(0, L.fields)
    .map((f) => ({
      name: truncate(f.name, L.fieldName),
      value: truncate(f.value, L.fieldValue),
      inline: f.value.length <= 40,
    }));
  const embed: Record<string, unknown> = {
    title: truncate(message.title, L.title),
    description: truncate(message.body, L.description),
    color: COLORS[message.event] ?? 0x8b5cf6,
    timestamp: message.timestamp,
    footer: { text: truncate(message.appTitle, L.footer) },
    fields,
  };
  if (message.url) embed.url = message.url;
  if (message.imageUrl) embed.thumbnail = { url: message.imageUrl };
  if (message.actor) embed.author = { name: truncate(message.actor, L.author) };

  // Keep the whole embed under the 6000 character cap: drop fields from the end, then shrink the body.
  const size = (): number =>
    [embed.title, embed.description, message.appTitle, message.actor ?? '']
      .map((v) => (typeof v === 'string' ? Array.from(v).length : 0))
      .reduce((a, b) => a + b, 0) +
    fields.reduce((n, f) => n + Array.from(f.name).length + Array.from(f.value).length, 0);
  while (fields.length > 0 && size() > L.total) fields.pop();
  if (size() > L.total) {
    const over = size() - L.total;
    embed.description = truncate(
      message.body,
      Math.max(0, Array.from(message.body).length - over - 1),
    );
  }
  return embed;
}

export const discordAgent: NotificationAgent<DiscordConfig> = {
  id: 'discord',
  label: 'Discord',
  description: 'Posts an embed to a Discord channel through a webhook.',
  configSchema: discordConfigSchema,
  secrets: ['webhookUrl'],
  async send(message, config, ctx) {
    await sendJson(ctx, 'Discord', config.webhookUrl, {
      ...(config.username ? { username: config.username } : {}),
      ...(config.avatarUrl ? { avatar_url: config.avatarUrl } : {}),
      embeds: [discordEmbed(message)],
      // Never let a request title ping @everyone.
      allowed_mentions: { parse: [] },
    });
  },
};
