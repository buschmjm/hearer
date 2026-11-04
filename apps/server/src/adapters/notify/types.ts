import { createHmac } from 'node:crypto';
import type { NotificationAgent as AgentId, NotificationMessage } from '@hearer/shared';
import { toJSONSchema, type ZodType } from 'zod';
import { PermanentJobError } from '../../jobs/registry.ts';

export type { NotificationMessage };

/** What an agent gets besides the message and its config. */
export interface AgentContext {
  fetch: typeof fetch;
  /** Aborted on shutdown or when the job times out. */
  signal?: AbortSignal | undefined;
  /** Per-request timeout. */
  timeoutMs: number;
  userAgent: string;
}

/**
 * A place notifications can go. `send` resolves when the destination accepted the message and
 * throws otherwise: a `PermanentJobError` when retrying cannot help (4xx, bad config), any other
 * error when it can (network, timeout, 429, 5xx).
 */
export interface NotificationAgent<C = unknown> {
  id: AgentId;
  label: string;
  description: string;
  /** Validates the config; also drives the settings form (rendered to JSON Schema). */
  configSchema: ZodType<C>;
  /** Names of config properties that hold secrets (encrypted at rest, masked in the API). */
  secrets: readonly string[];
  send: (message: NotificationMessage, config: C, ctx: AgentContext) => Promise<void>;
  /** Optional connectivity check that sends nothing visible; the default test sends a `test` message. */
  test?: (config: C, ctx: AgentContext) => Promise<void>;
}

/** An agent as the registry holds it: config arrives unvalidated and is parsed before use. */
export interface ErasedAgent {
  id: AgentId;
  label: string;
  description: string;
  configSchema: ZodType;
  secrets: readonly string[];
  /** Parses `raw` with the agent's schema; throws ZodError. */
  parseConfig: (raw: unknown) => unknown;
  /** Validates `raw` (an invalid config is a PermanentJobError) and sends. */
  send: (message: NotificationMessage, raw: unknown, ctx: AgentContext) => Promise<void>;
  /** Validates and runs the agent's own `test`, else sends the message. */
  test: (message: NotificationMessage, raw: unknown, ctx: AgentContext) => Promise<void>;
  /** JSON Schema of the config with `x-secret: true` on the secret properties. */
  jsonSchema: () => Record<string, unknown>;
  /** The config a brand-new target starts with. */
  defaults: () => Record<string, unknown>;
}

export function erase<C>(agent: NotificationAgent<C>): ErasedAgent {
  const parse = (raw: unknown): C => {
    const result = agent.configSchema.safeParse(raw);
    if (!result.success) {
      throw new PermanentJobError(
        `${agent.label}: invalid configuration (${result.error.issues
          .map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
          .join('; ')})`,
      );
    }
    return result.data;
  };
  return {
    id: agent.id,
    label: agent.label,
    description: agent.description,
    configSchema: agent.configSchema,
    secrets: agent.secrets,
    parseConfig: (raw) => agent.configSchema.parse(raw),
    send: async (message, raw, ctx) => {
      await agent.send(message, parse(raw), ctx);
    },
    test: async (message, raw, ctx) => {
      const config = parse(raw);
      await (agent.test ? agent.test(config, ctx) : agent.send(message, config, ctx));
    },
    jsonSchema: () => agentJsonSchema(agent),
    defaults: () => {
      const result = agent.configSchema.safeParse({});
      if (result.success) return result.data as Record<string, unknown>;
      // Required fields without defaults: start from the schema's own defaults only.
      const schema = toJSONSchema(agent.configSchema, { io: 'input', unrepresentable: 'any' });
      const props = (schema.properties ?? {}) as Record<string, { default?: unknown }>;
      return Object.fromEntries(
        Object.entries(props)
          .filter(([, p]) => p.default !== undefined)
          .map(([name, p]) => [name, p.default]),
      );
    },
  };
}

/** The agent's config as JSON Schema (input side, so defaults show as optional fields). */
export function agentJsonSchema(
  agent: Pick<NotificationAgent, 'configSchema' | 'secrets'>,
): Record<string, unknown> {
  const schema = toJSONSchema(agent.configSchema, { io: 'input', unrepresentable: 'any' });
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const marked = { ...properties };
  for (const name of agent.secrets) {
    if (marked[name]) marked[name] = { ...marked[name], 'x-secret': true };
  }
  return { ...schema, properties: marked };
}

const MAX_ERROR_BODY = 300;

function describeBody(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return `: ${flat.length > MAX_ERROR_BODY ? `${flat.slice(0, MAX_ERROR_BODY)}...` : flat}`;
}

/**
 * POST (or any method) with a timeout, treating non-2xx as an error. 429, 408 and 5xx are
 * retryable plain errors; any other non-2xx is a `PermanentJobError`. Error messages name the
 * agent and never include the URL (webhook URLs carry tokens).
 */
export async function sendHttp(
  ctx: AgentContext,
  label: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Response> {
  const signals = [AbortSignal.timeout(ctx.timeoutMs)];
  if (ctx.signal) signals.push(ctx.signal);
  let response: Response;
  try {
    response = await ctx.fetch(url, {
      method: init.method ?? 'POST',
      headers: { 'user-agent': ctx.userAgent, ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    const reason =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? `timed out after ${String(ctx.timeoutMs)} ms or was aborted`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(`${label}: request failed (${reason})`, { cause: err });
  }
  if (response.status >= 200 && response.status < 300) return response;
  const detail = describeBody(await response.text().catch(() => ''));
  const message = `${label}: HTTP ${String(response.status)}${detail}`;
  if (response.status === 429 || response.status === 408 || response.status >= 500) {
    throw new Error(message);
  }
  throw new PermanentJobError(message);
}

export const sendJson = (
  ctx: AgentContext,
  label: string,
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  sendHttp(ctx, label, url, {
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

/** `sha256=<hex>` HMAC over the raw body. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Cut `text` to at most `max` characters (counting code points), ending with an ellipsis. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars
    .slice(0, Math.max(0, max - 1))
    .join('')
    .trimEnd()}…`;
}
