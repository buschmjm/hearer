import { createHmac } from 'node:crypto';
import type { NotificationEvent } from '@hearer/shared';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DISCORD_LIMITS, discordEmbed } from '../src/adapters/notify/discord.ts';
import { encodeHeader } from '../src/adapters/notify/ntfy.ts';
import { getAgent, listAgents } from '../src/adapters/notify/registry.ts';
import { renderEmail } from '../src/adapters/notify/smtp.ts';
import { truncate } from '../src/adapters/notify/types.ts';
import { PermanentJobError } from '../src/jobs/registry.ts';
import { HttpMock, ctx, message } from './helpers/notify.ts';

let mock: HttpMock;
beforeEach(async () => {
  mock = await new HttpMock().start();
});
afterEach(async () => {
  await mock.stop();
});

describe('registry and schemas', () => {
  it('lists the five agents with JSON schemas that mark secrets', () => {
    expect(listAgents().map((a) => a.id)).toEqual(['webhook', 'discord', 'slack', 'ntfy', 'smtp']);
    const secretsOf = (id: 'webhook' | 'discord' | 'slack' | 'ntfy' | 'smtp') => {
      const props = getAgent(id).jsonSchema().properties as Record<string, Record<string, unknown>>;
      return Object.keys(props).filter((name) => props[name]?.['x-secret'] === true);
    };
    expect(secretsOf('webhook')).toEqual(['authorization', 'secret']);
    expect(secretsOf('discord')).toEqual(['webhookUrl']);
    expect(secretsOf('slack')).toEqual(['webhookUrl']);
    expect(secretsOf('ntfy')).toEqual(['token', 'password']);
    expect(secretsOf('smtp')).toEqual(['pass']);
    expect(getAgent('ntfy').defaults()).toMatchObject({
      serverUrl: 'https://ntfy.sh',
      priority: 3,
    });
  });

  it('rejects invalid config as a permanent error', async () => {
    await expect(
      getAgent('webhook').send(message(), { url: 'not a url' }, ctx()),
    ).rejects.toBeInstanceOf(PermanentJobError);
    await expect(
      getAgent('discord').send(message(), { webhookUrl: 'https://example.com/x' }, ctx()),
    ).rejects.toThrow(/not a Discord webhook URL/);
  });
});

describe('webhook agent (n8n style)', () => {
  it('POSTs {event, message, data} with custom headers and a verifiable HMAC signature', async () => {
    await getAgent('webhook').send(
      message(),
      {
        url: `${mock.url}/webhook/abc`,
        headers: { 'X-Flow': 'hearer' },
        authorization: 'Bearer tok',
        secret: 's3cret',
      },
      ctx(),
    );
    const [req] = mock.requests;
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('/webhook/abc');
    expect(req?.headers['content-type']).toBe('application/json');
    expect(req?.headers['x-flow']).toBe('hearer');
    expect(req?.headers.authorization).toBe('Bearer tok');
    expect(req?.headers['x-hearer-event']).toBe('request.created');
    expect(req?.headers['user-agent']).toBe('Hearer/test');
    const body = req?.json as Record<string, unknown>;
    expect(body.event).toBe('request.created');
    expect(body.message).toMatchObject({
      title: 'New request awaiting approval',
      url: 'https://hearer.example/requests/r1',
      subject: { id: 'r1', title: 'OK Computer' },
    });
    expect(body.message).not.toHaveProperty('data');
    expect(body.data).toEqual({ requestId: 'r1', status: 'PENDING' });
    // The signature is over the raw bytes received.
    const expected = `sha256=${createHmac('sha256', 's3cret')
      .update(req?.raw ?? '')
      .digest('hex')}`;
    expect(req?.headers['x-hearer-signature']).toBe(expected);
  });

  it('sends no signature or authorization without a secret', async () => {
    await getAgent('webhook').send(message(), { url: mock.url }, ctx());
    expect(mock.requests[0]?.headers['x-hearer-signature']).toBeUndefined();
    expect(mock.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('refuses headers that would break the request', async () => {
    await expect(
      getAgent('webhook').send(
        message(),
        { url: mock.url, headers: { 'Content-Type': 'text/plain' } },
        ctx(),
      ),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it('times out slowly answering endpoints with a retryable error', async () => {
    mock.delayMs = 1500;
    const err = await getAgent('webhook')
      .send(message(), { url: mock.url }, ctx({ timeoutMs: 1000 }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentJobError);
    expect((err as Error).message).toMatch(/timed out/);
  });

  it('config timeoutSeconds bounds the call', async () => {
    mock.delayMs = 1800;
    const started = Date.now();
    await expect(
      getAgent('webhook').send(message(), { url: mock.url, timeoutSeconds: 1 }, ctx()),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(1700);
  });
});

describe('retryable vs permanent HTTP failures', () => {
  const classify = async (status: number): Promise<'ok' | 'retry' | 'permanent'> => {
    mock.requests = [];
    mock.statuses = [status];
    try {
      await getAgent('webhook').send(message(), { url: mock.url }, ctx());
      return 'ok';
    } catch (err) {
      return err instanceof PermanentJobError ? 'permanent' : 'retry';
    }
  };

  it('2xx ok, 429/408/5xx retry, other 4xx and 3xx permanent', async () => {
    expect(await classify(200)).toBe('ok');
    expect(await classify(204)).toBe('ok');
    for (const status of [429, 408, 500, 502, 503]) expect(await classify(status)).toBe('retry');
    for (const status of [400, 401, 403, 404, 410, 302]) {
      expect(await classify(status)).toBe('permanent');
    }
  });

  it('a refused connection is retryable and the error never leaks the URL', async () => {
    const dead = await new HttpMock().start();
    const url = `${dead.url}/hooks/very-secret-token`;
    await dead.stop();
    const err = await getAgent('discord')
      .send(message(), { webhookUrl: 'http://127.0.0.1:1/api/webhooks/1/tok' }, ctx())
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PermanentJobError);
    const err2 = await getAgent('webhook')
      .send(message(), { url }, ctx())
      .catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(Error);
    expect((err2 as Error).message).not.toContain('very-secret-token');
  });

  it('includes the response body in the error', async () => {
    mock.statuses = [404];
    await expect(getAgent('webhook').send(message(), { url: mock.url }, ctx())).rejects.toThrow(
      /Webhook: HTTP 404: mock says 404/,
    );
  });
});

describe('discord agent', () => {
  const hook = (): string => `${mock.url}/api/webhooks/123456/abc-DEF_ghi`;

  it('posts an embed with title, description, url, thumbnail, fields, color', async () => {
    await getAgent('discord').send(
      message(),
      { webhookUrl: hook(), username: 'Hearer Bot' },
      ctx(),
    );
    const req = mock.requests[0];
    expect(req?.path).toBe('/api/webhooks/123456/abc-DEF_ghi');
    const body = req?.json as {
      username: string;
      embeds: Record<string, unknown>[];
      allowed_mentions: unknown;
    };
    expect(body.username).toBe('Hearer Bot');
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0]).toMatchObject({
      title: 'New request awaiting approval',
      description: 'alice requested the album "OK Computer" by Radiohead.',
      url: 'https://hearer.example/requests/r1',
      thumbnail: { url: 'https://img.example/cover.jpg' },
      color: 0xf59e0b,
      author: { name: 'alice' },
      fields: [
        { name: 'Type', value: 'album', inline: true },
        { name: 'Requested by', value: 'alice', inline: true },
      ],
    });
  });

  it('uses different colors per event', () => {
    const color = (event: NotificationEvent) => discordEmbed(message({ event })).color;
    expect(color('request.available')).toBe(0x22c55e);
    expect(color('request.failed')).toBe(0xef4444);
    expect(color('request.available')).not.toBe(color('request.failed'));
  });

  it('truncates to the embed limits', () => {
    const long = 'x'.repeat(10_000);
    const embed = discordEmbed(
      message({
        title: long,
        body: long,
        fields: Array.from({ length: 40 }, (_, i) => ({
          name: long,
          value: `${long}${String(i)}`,
        })),
      }),
    );
    const fields = embed.fields as { name: string; value: string }[];
    expect((embed.title as string).length).toBeLessThanOrEqual(DISCORD_LIMITS.title);
    expect((embed.description as string).length).toBeLessThanOrEqual(DISCORD_LIMITS.description);
    expect(fields.length).toBeLessThanOrEqual(DISCORD_LIMITS.fields);
    for (const f of fields) {
      expect(f.name.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldName);
      expect(f.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldValue);
    }
    expect((embed.title as string).endsWith('…')).toBe(true);
    const total =
      (embed.title as string).length +
      (embed.description as string).length +
      fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(DISCORD_LIMITS.total);
  });

  it('skips empty fields and omits url/thumbnail when absent', () => {
    const embed = discordEmbed(
      message({ url: null, imageUrl: null, fields: [{ name: 'A', value: ' ' }], actor: null }),
    );
    expect(embed.fields).toEqual([]);
    expect(embed).not.toHaveProperty('url');
    expect(embed).not.toHaveProperty('thumbnail');
    expect(embed).not.toHaveProperty('author');
  });

  it('rejects a webhook url that is not a Discord one', async () => {
    await expect(
      getAgent('discord').send(message(), { webhookUrl: `${mock.url}/hook` }, ctx()),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });
});

describe('slack agent', () => {
  it('posts Block Kit: header, section with image accessory, fields, context, button', async () => {
    await getAgent('slack').send(message(), { webhookUrl: `${mock.url}/services/T/B/x` }, ctx());
    const req = mock.requests[0];
    expect(req?.path).toBe('/services/T/B/x');
    const body = req?.json as { text: string; blocks: Record<string, unknown>[] };
    expect(body.text).toContain('New request awaiting approval');
    expect(body.blocks.map((b) => b.type)).toEqual([
      'header',
      'section',
      'section',
      'context',
      'actions',
    ]);
    expect(body.blocks[0]).toMatchObject({
      type: 'header',
      text: { type: 'plain_text', text: ':hourglass_flowing_sand: New request awaiting approval' },
    });
    expect(body.blocks[1]).toMatchObject({
      type: 'section',
      text: { type: 'mrkdwn' },
      accessory: {
        type: 'image',
        image_url: 'https://img.example/cover.jpg',
        alt_text: 'OK Computer',
      },
    });
    expect(body.blocks[2]).toMatchObject({
      fields: [
        { type: 'mrkdwn', text: '*Type*\nalbum' },
        { type: 'mrkdwn', text: '*Requested by*\nalice' },
      ],
    });
    expect(body.blocks[3]).toMatchObject({
      elements: [{ text: 'By alice' }, { text: 'Hearer' }],
    });
    expect(body.blocks[4]).toMatchObject({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { text: 'Open in Hearer' },
          url: 'https://hearer.example/requests/r1',
        },
      ],
    });
  });

  it('escapes mrkdwn control characters and omits image/button when absent', async () => {
    await getAgent('slack').send(
      message({
        body: 'a <b> & c',
        url: null,
        imageUrl: null,
        fields: [],
        actor: null,
      }),
      { webhookUrl: `${mock.url}/s` },
      ctx(),
    );
    const blocks = (mock.requests[0]?.json as { blocks: Record<string, unknown>[] }).blocks;
    expect(blocks.map((b) => b.type)).toEqual(['header', 'section', 'context']);
    expect(blocks[1]).toMatchObject({ text: { text: 'a &lt;b&gt; &amp; c' } });
    expect(blocks[1]).not.toHaveProperty('accessory');
  });

  it('keeps the header under 150 characters and at most 10 fields', async () => {
    await getAgent('slack').send(
      message({
        title: 't'.repeat(400),
        fields: Array.from({ length: 15 }, (_, i) => ({ name: `n${String(i)}`, value: 'v' })),
      }),
      { webhookUrl: `${mock.url}/s` },
      ctx(),
    );
    const blocks = (
      mock.requests[0]?.json as { blocks: { text?: { text: string }; fields?: unknown[] }[] }
    ).blocks;
    expect(blocks[0]?.text?.text.length).toBeLessThanOrEqual(150);
    expect(blocks[2]?.fields).toHaveLength(10);
  });
});

describe('ntfy agent', () => {
  it('publishes with title/priority/tags/click/attach headers and a bearer token', async () => {
    await getAgent('ntfy').send(
      message(),
      { serverUrl: `${mock.url}/`, topic: 'music-alerts', token: 'tk_abc', priority: 2 },
      ctx(),
    );
    const req = mock.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('/music-alerts');
    expect(req?.headers.title).toBe('New request awaiting approval');
    expect(req?.headers.priority).toBe('2');
    expect(req?.headers.tags).toBe('hourglass_flowing_sand');
    expect(req?.headers.click).toBe('https://hearer.example/requests/r1');
    expect(req?.headers.attach).toBe('https://img.example/cover.jpg');
    expect(req?.headers.authorization).toBe('Bearer tk_abc');
    expect(req?.raw).toBe(
      'alice requested the album "OK Computer" by Radiohead.\nType: album\nRequested by: alice',
    );
  });

  it('uses basic auth for username/password and raises priority for failures', async () => {
    await getAgent('ntfy').send(
      message({ event: 'request.failed' }),
      { serverUrl: mock.url, topic: 't', username: 'u', password: 'p' },
      ctx(),
    );
    const req = mock.requests[0];
    expect(req?.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(req?.headers.priority).toBe('4');
    expect(req?.headers.tags).toBe('x');
  });

  it('encodes non-ASCII titles as RFC 2047 and omits click/attach when absent', async () => {
    await getAgent('ntfy').send(
      message({ title: 'Neue Anfrage — Björk', url: null, imageUrl: null }),
      { serverUrl: mock.url, topic: 't' },
      ctx(),
    );
    const req = mock.requests[0];
    expect(req?.headers.title).toBe(encodeHeader('Neue Anfrage — Björk'));
    expect(req?.headers.title).toMatch(/^=\?UTF-8\?B\?/);
    const decoded = Buffer.from(
      (req?.headers.title as string).replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''),
      'base64',
    ).toString('utf8');
    expect(decoded).toBe('Neue Anfrage — Björk');
    expect(req?.headers.click).toBeUndefined();
    expect(req?.headers.attach).toBeUndefined();
    expect(req?.headers.authorization).toBeUndefined();
  });

  it('defaults to ntfy.sh and validates the topic', () => {
    expect(getAgent('ntfy').defaults().serverUrl).toBe('https://ntfy.sh');
    expect(() => getAgent('ntfy').parseConfig({ topic: 'a/b' })).toThrow();
    expect(() => getAgent('ntfy').parseConfig({ topic: 'ok_topic-1' })).not.toThrow();
  });
});

describe('truncate', () => {
  it('counts code points and leaves short text alone', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('\u{1F3B5}'.repeat(10), 4)).toBe('\u{1F3B5}\u{1F3B5}\u{1F3B5}…');
  });
});

describe('smtp agent', () => {
  interface Mail {
    from: string;
    to: string[];
    data: string;
    user: string | null;
  }
  let smtp: SMTPServer;
  let port = 0;
  let mails: Mail[] = [];
  let rejectWith: { code: number; message: string } | null = null;

  beforeEach(async () => {
    mails = [];
    rejectWith = null;
    smtp = new SMTPServer({
      authOptional: true,
      allowInsecureAuth: true,
      disabledCommands: ['STARTTLS'],
      onAuth(auth, _session, callback) {
        if (auth.username === 'mailer' && auth.password === 'pw') {
          callback(null, { user: auth.username });
        } else {
          callback(new Error('Invalid login'));
        }
      },
      onMailFrom(_address, _session, callback) {
        if (rejectWith) {
          callback(Object.assign(new Error(rejectWith.message), { responseCode: rejectWith.code }));
        } else {
          callback();
        }
      },
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          mails.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
            to: session.envelope.rcptTo.map((r) => r.address),
            data: Buffer.concat(chunks).toString('utf8'),
            user: session.user ? String(session.user) : null,
          });
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
    port = (smtp.server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      smtp.close(() => {
        resolve();
      });
    });
  });

  const config = (extra: Record<string, unknown> = {}) => ({
    host: '127.0.0.1',
    port,
    from: 'Hearer <hearer@example.com>',
    to: 'admin@example.com, ops@example.com',
    ...extra,
  });

  it('delivers an HTML + text email to all recipients', async () => {
    await getAgent('smtp').send(message(), config(), ctx());
    expect(mails).toHaveLength(1);
    const mail = mails[0];
    expect(mail?.from).toBe('hearer@example.com');
    expect(mail?.to).toEqual(['admin@example.com', 'ops@example.com']);
    const data = mail?.data ?? '';
    expect(data).toMatch(/^Subject: \[Hearer\] New request awaiting approval$/m);
    expect(data).toMatch(/^From: Hearer <hearer@example.com>$/m);
    expect(data).toMatch(/multipart\/alternative/);
    expect(data).toMatch(/Content-Type: text\/plain/);
    expect(data).toMatch(/Content-Type: text\/html/);
    expect(data).toContain('Type: album');
    expect(data).toContain('https://hearer.example/requests/r1');
    expect(data).toContain('OK Computer');
  });

  it('authenticates when a user is set and treats a bad login as permanent', async () => {
    await getAgent('smtp').send(message(), config({ user: 'mailer', pass: 'pw' }), ctx());
    expect(mails[0]?.user).toBe('mailer');
    const err = await getAgent('smtp')
      .send(message(), config({ user: 'mailer', pass: 'wrong' }), ctx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentJobError);
    expect(mails).toHaveLength(1);
  });

  it('classifies 5xx replies as permanent, 4xx and connection errors as retryable', async () => {
    rejectWith = { code: 550, message: 'Mailbox unavailable' };
    await expect(getAgent('smtp').send(message(), config(), ctx())).rejects.toBeInstanceOf(
      PermanentJobError,
    );
    rejectWith = { code: 451, message: 'Try again later' };
    const temp = await getAgent('smtp')
      .send(message(), config(), ctx())
      .catch((e: unknown) => e);
    expect(temp).toBeInstanceOf(Error);
    expect(temp).not.toBeInstanceOf(PermanentJobError);
    const down = await getAgent('smtp')
      .send(message(), config({ port: 1 }), ctx({ timeoutMs: 2000 }))
      .catch((e: unknown) => e);
    expect(down).toBeInstanceOf(Error);
    expect(down).not.toBeInstanceOf(PermanentJobError);
  });

  it('requireTLS refuses to send in clear text', async () => {
    const err = await getAgent('smtp')
      .send(message(), config({ requireTLS: true }), ctx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(mails).toHaveLength(0);
  });

  it('renders escaped HTML, a subject without line breaks, and a plain-text part', () => {
    const rendered = renderEmail(
      message({
        title: 'Evil\r\nBcc: x',
        body: '<script>alert(1)</script> & "q"',
        url: null,
        imageUrl: null,
      }),
    );
    expect(rendered.subject).toBe('[Hearer] Evil Bcc: x');
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;');
    expect(rendered.html).not.toContain('<img');
    expect(rendered.html).not.toContain('Open in');
    expect(rendered.text).toContain('<script>alert(1)</script> & "q"');
    expect(rendered.html).toContain('style="');
  });
});
