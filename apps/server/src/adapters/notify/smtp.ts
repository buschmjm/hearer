import nodemailer from 'nodemailer';
import { z } from 'zod';
import { PermanentJobError } from '../../jobs/registry.ts';
import { truncate, type NotificationAgent, type NotificationMessage } from './types.ts';

const address = z.string().trim().max(320);

export const smtpConfigSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z
    .boolean()
    .default(false)
    .describe(
      'Implicit TLS (usually port 465). Off means plain, upgraded with STARTTLS if offered.',
    ),
  requireTLS: z.boolean().default(false).describe('Refuse to send unless STARTTLS succeeds.'),
  user: z.string().max(320).default(''),
  pass: z.string().max(500).default(''),
  from: address.min(3).describe('Sender, for example "Hearer <hearer@example.com>".'),
  to: address
    .min(3)
    .describe('Recipient(s), comma separated. Personal notifications replace this per user.'),
  userEmail: z
    .boolean()
    .default(false)
    .describe(
      'Also use this server to send users their own notifications (opt-in in their profile).',
    ),
});
export type SmtpConfig = z.infer<typeof smtpConfigSchema>;

const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ACCENT: Record<string, string> = {
  'request.created': '#d97706',
  'request.approved': '#2563eb',
  'request.declined': '#dc2626',
  'request.available': '#16a34a',
  'request.partially_available': '#65a30d',
  'request.failed': '#dc2626',
  'upload.needs_review': '#d97706',
  'upload.duplicate': '#6b7280',
  'upload.imported': '#16a34a',
  'upload.failed': '#dc2626',
  test: '#7c3aed',
};

/** Simple table-free, inline-styled email; works in clients that strip <style>. */
export function renderEmail(message: NotificationMessage): {
  subject: string;
  text: string;
  html: string;
} {
  const accent = ACCENT[message.event] ?? '#7c3aed';
  const fields = message.fields.filter((f) => f.name.trim() && f.value.trim());
  const subject = truncate(`[${message.appTitle}] ${message.title}`.replace(/[\r\n]+/g, ' '), 200);
  const text = [
    message.title,
    '',
    message.body,
    ...(fields.length ? ['', ...fields.map((f) => `${f.name}: ${f.value}`)] : []),
    ...(message.url ? ['', message.url] : []),
    '',
    `-- ${message.appTitle}`,
  ].join('\n');
  const cover = message.imageUrl
    ? `<img src="${esc(message.imageUrl)}" alt="" width="96" height="96" style="float:right;margin:0 0 12px 16px;border-radius:6px;object-fit:cover;">`
    : '';
  const rows = fields
    .map(
      (f) =>
        `<div style="margin:2px 0;"><span style="color:#6b7280;">${esc(f.name)}:</span> ${esc(f.value)}</div>`,
    )
    .join('');
  const button = message.url
    ? `<p style="margin:20px 0 0;"><a href="${esc(message.url)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:9px 16px;border-radius:6px;font-weight:600;">Open in ${esc(message.appTitle)}</a></p>`
    : '';
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111827;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;border-top:4px solid ${accent};padding:24px;">
${cover}<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;">${esc(message.title)}</h1>
<p style="margin:0 0 14px;line-height:1.5;">${esc(message.body).replace(/\n/g, '<br>')}</p>
<div style="font-size:14px;line-height:1.5;clear:both;">${rows}</div>
${button}
<p style="margin:24px 0 0;font-size:12px;color:#9ca3af;">${esc(message.appTitle)}</p>
</div></body></html>`;
  return { subject, text, html };
}

/** SMTP failures: 5xx replies and auth errors are permanent, connection problems and 4xx retry. */
function classify(err: unknown): Error {
  const e = err as { code?: unknown; responseCode?: unknown; message?: unknown };
  const detail = typeof e.message === 'string' ? e.message : String(err);
  const message = `SMTP: ${detail}`;
  const code = typeof e.code === 'string' ? e.code : '';
  const reply = typeof e.responseCode === 'number' ? e.responseCode : 0;
  // The server's reply code decides when there is one: 4xx is temporary, 5xx permanent.
  if (reply >= 400 && reply < 500) return new Error(message, { cause: err });
  if (reply >= 500 && reply < 600) return new PermanentJobError(message, { cause: err });
  if (code === 'EAUTH' || code === 'EENVELOPE' || code === 'EMESSAGE') {
    return new PermanentJobError(message, { cause: err });
  }
  return new Error(message, { cause: err });
}

export const smtpAgent: NotificationAgent<SmtpConfig> = {
  id: 'smtp',
  label: 'Email (SMTP)',
  description: 'Sends HTML and plain-text email through an SMTP server.',
  configSchema: smtpConfigSchema,
  secrets: ['pass'],
  async send(message, config, ctx) {
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: config.requireTLS,
      ...(config.user ? { auth: { user: config.user, pass: config.pass } } : {}),
      connectionTimeout: ctx.timeoutMs,
      greetingTimeout: ctx.timeoutMs,
      socketTimeout: ctx.timeoutMs,
    });
    const { subject, text, html } = renderEmail(message);
    try {
      await transport.sendMail({ from: config.from, to: config.to, subject, text, html });
    } catch (err) {
      throw classify(err);
    } finally {
      transport.close();
    }
  },
};
