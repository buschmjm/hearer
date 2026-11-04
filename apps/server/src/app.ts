import { randomUUID } from 'node:crypto';
import { APP_NAME, APP_VERSION } from '@hearer/shared';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type FastifyPluginCallbackZod,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { pino, type Logger } from 'pino';
import pretty from 'pino-pretty';
import type { Config } from './config.ts';
import { healthRoutes, type HealthDeps } from './routes/health.ts';

export const API_PREFIX = '/api/v1';

export interface AppDeps {
  version?: string;
  healthChecks?: HealthDeps['checks'];
  /** Extra route plugins registered under /api/v1 (feature batches, tests). */
  routes?: FastifyPluginCallbackZod[];
  /** Override the logger (tests). Defaults to one built from config. */
  logger?: Logger;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function createLogger(config: Pick<Config, 'logLevel' | 'logFormat'>): Logger {
  const options = {
    level: config.logLevel,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
  };
  return config.logFormat === 'pretty'
    ? pino(options, pretty({ colorize: true, sync: true }))
    : pino(options);
}

/** Fastify's types omit the numeric hop-count form, so express it as a function. */
function toTrustProxy(
  value: Config['trustProxy'],
): boolean | ((address: string, hop: number) => boolean) {
  return typeof value === 'number' ? (_address, hop) => hop < value : value;
}

function describeClientError(error: unknown): { status: number; code: string; message: string } {
  if (!(error instanceof Error)) return { status: 500, code: 'internal_error', message: '' };
  const { statusCode, code } = error as Error & { statusCode?: unknown; code?: unknown };
  return {
    status: typeof statusCode === 'number' ? statusCode : 500,
    code: typeof code === 'string' ? code.toLowerCase() : 'bad_request',
    message: error.message,
  };
}

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<FastifyInstance> {
  const version = deps.version ?? APP_VERSION;
  const serverOptions: FastifyServerOptions = {
    loggerInstance: deps.logger ?? createLogger(config),
    trustProxy: toTrustProxy(config.trustProxy),
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  };
  const app = Fastify(serverOptions).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  const sendError = (
    reply: { status: (code: number) => { send: (body: ApiErrorBody) => unknown } },
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) =>
    reply
      .status(status)
      .send({ error: { code, message, ...(details === undefined ? {} : { details }) } });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith(API_PREFIX) || request.url === '/api') {
      return sendError(reply, 404, 'not_found', `Route ${request.method} ${request.url} not found`);
    }
    return sendError(reply, 404, 'not_found', 'Not found');
  });

  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return sendError(
        reply,
        400,
        'validation_error',
        'Request validation failed',
        error.validation,
      );
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response serialization failed');
      return sendError(reply, 500, 'internal_error', 'Internal server error');
    }
    const { status, code, message } = describeClientError(error);
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      return sendError(reply, 500, 'internal_error', 'Internal server error');
    }
    return sendError(reply, status, code, message);
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: { title: `${APP_NAME} API`, version },
      servers: config.baseUrl ? [{ url: config.baseUrl }] : [],
    },
    transform: jsonSchemaTransform,
  });

  app.get(`${API_PREFIX}/openapi.json`, { schema: { hide: true } }, () => app.swagger());

  await app.register(
    healthRoutes({ version, ...(deps.healthChecks && { checks: deps.healthChecks }) }),
    {
      prefix: API_PREFIX,
    },
  );

  for (const plugin of deps.routes ?? []) {
    await app.register(plugin, { prefix: API_PREFIX });
  }

  return app;
}
