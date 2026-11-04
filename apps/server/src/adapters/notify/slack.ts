import { z } from 'zod';
import { sendJson, truncate, type NotificationAgent, type NotificationMessage } from './types.ts';

export const slackConfigSchema = z.object({
  webhookUrl: z
    .url({ protocol: /^https?$/ })
    .describe('Incoming webhook URL (api.slack.com/messaging/webhooks).'),
});
export type SlackConfig = z.infer<typeof slackConfigSchema>;

/** Slack mrkdwn treats & < > as control characters. */
export const slackEscape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const EMOJI: Record<string, string> = {
  'request.created': ':hourglass_flowing_sand:',
  'request.approved': ':white_check_mark:',
  'request.declined': ':no_entry_sign:',
  'request.available': ':tada:',
  'request.partially_available': ':musical_note:',
  'request.failed': ':x:',
  'upload.needs_review': ':mag:',
  'upload.duplicate': ':busts_in_silhouette:',
  'upload.imported': ':inbox_tray:',
  'upload.failed': ':x:',
  test: ':test_tube:',
};

/** Block Kit message: header, section (cover as accessory), fields, context, link button. */
export function slackPayload(message: NotificationMessage): Record<string, unknown> {
  const header = truncate(`${EMOJI[message.event] ?? ''} ${message.title}`.trim(), 150);
  const section: Record<string, unknown> = {
    type: 'section',
    text: { type: 'mrkdwn', text: truncate(slackEscape(message.body) || ' ', 3000) },
  };
  if (message.imageUrl) {
    section.accessory = {
      type: 'image',
      image_url: message.imageUrl,
      alt_text: truncate(message.subject?.title ?? message.title, 2000),
    };
  }
  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: true } },
    section,
  ];
  const fields = message.fields
    .filter((f) => f.name.trim() && f.value.trim())
    .slice(0, 10)
    .map((f) => ({
      type: 'mrkdwn',
      text: truncate(`*${slackEscape(f.name)}*\n${slackEscape(f.value)}`, 2000),
    }));
  if (fields.length > 0) blocks.push({ type: 'section', fields });
  const context = [message.actor ? `By ${message.actor}` : null, message.appTitle]
    .filter((v): v is string => Boolean(v))
    .map((text) => ({ type: 'mrkdwn', text: truncate(slackEscape(text), 2000) }));
  blocks.push({ type: 'context', elements: context });
  if (message.url) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open in Hearer' },
          url: message.url,
        },
      ],
    });
  }
  return { text: truncate(`${message.title}: ${message.body}`, 3000), blocks };
}

export const slackAgent: NotificationAgent<SlackConfig> = {
  id: 'slack',
  label: 'Slack',
  description: 'Posts a Block Kit message to a Slack channel through an incoming webhook.',
  configSchema: slackConfigSchema,
  secrets: ['webhookUrl'],
  async send(message, config, ctx) {
    await sendJson(ctx, 'Slack', config.webhookUrl, slackPayload(message));
  },
};
