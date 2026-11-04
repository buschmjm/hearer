import { randomBytes, randomUUID } from 'node:crypto';
import { APP_NAME, APP_VERSION } from '@hearer/shared';
import swagger from '@fastify/swagger';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
  type RouteOptions,
} from 'fastify';
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
import { openDatabase, pingDatabase, MEMORY_DB, type Database_ } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { JobRunner, type JobRunnerOptions } from './jobs/runner.ts';
import { MAINTENANCE_INTERVAL_MS, MAINTENANCE_JOB, maintenanceJob } from './jobs/maintenance.ts';
import { API_PREFIX } from './lib/constants.ts';
import { ApiKeyService } from './auth/apikeys.ts';
import { createAuthHelpers, registerAuth, type AuthHelpers } from './auth/plugin.ts';
import { SessionService, type SessionOptions } from './auth/sessions.ts';
import { HttpError } from './lib/http-error.ts';
import { SecretBox } from './lib/secrets.ts';
import { SettingsService } from './services/settings.ts';
import { UsersService } from './services/users.ts';
import { authRoutes } from './routes/auth.ts';
import { jellyfinAuthRoutes } from './auth/jellyfin.ts';
import { MediaServerRegistry } from './adapters/mediaserver/registry.ts';
import { oidcRoutes } from './routes/oidc.ts';
import { healthRoutes, type HealthDeps } from './routes/health.ts';
import { settingsRoutes } from './routes/settings.ts';
import { registerSetupGate, setupRoutes } from './routes/setup.ts';
import { userRoutes } from './routes/users.ts';
// H-09 metadata
import { MusicBrainzProvider, type MusicBrainzOptions } from './adapters/metadata/musicbrainz.ts';
import type { MetadataProvider } from './adapters/metadata/types.ts';
import { searchRoutes } from './routes/search.ts';
import { BadgeService, type LibraryLookup } from './services/badges.ts';

export { API_PREFIX };
const JOB_SHUTDOWN_GRACE_MS = 5_000;

declare module 'fastify' {
  interface FastifyInstance {
    /** Shared services; route plugins use these instead of opening their own handles. */
    hearer: {
      database: Database_;
      secrets: SecretBox;
      settings: SettingsService;
      jobs: JobRunner;
      users: UsersService;
      sessions: SessionService;
      apiKeys: ApiKeyService;
      auth: AuthHelpers;
      /** Media server adapter built from the stored `mediaServer` settings. */
      mediaServer: MediaServerRegistry;
      /** Catalog metadata (MusicBrainz by default). */
      metadata: MetadataProvider;
      /** Library and request badges for catalog items. */
      badges: BadgeService;
    };
  }
}

export interface AppDeps {
  version?: string;
  /**
   * An open, already-migrated database (index.ts passes the real one and closes it itself).
   * When omitted, buildApp creates a migrated in-memory database and closes it with the app.
   */
  db?: Database_;
  /** Encryption for secret settings. Defaults to HEARER_SECRET, else an ephemeral key. */
  secrets?: SecretBox;
  healthChecks?: HealthDeps['checks'];
  /** Extra route plugins registered under /api/v1 (feature batches, tests). */
  routes?: FastifyPluginCallbackZod[];
  /**
   * Start the job runner when the server is ready and stop it on close. Defaults to false so
   * tests build an idle app; index.ts passes true.
   */
  startJobs?: boolean;
  /** Job runner overrides (tests). */
  jobs?: Partial<
    Pick<JobRunnerOptions, 'workerId' | 'pollIntervalMs' | 'maxConcurrency' | 'staleLockMs'>
  >;
  /** Per-request timeout for media server calls in ms (tests shorten it). */
  mediaServerTimeoutMs?: number;
  /** Override the logger (tests). Defaults to one built from config. */
  logger?: Logger;
  /** Auth tuning (tests): session lifetime/clock and the login rate limit. */
  auth?: SessionOptions & { rateLimitMax?: number };
  /**
   * Called for every route as it is registered (including the built-in ones). Lets tests
   * enumerate the API surface, e.g. for the route-level permission matrix.
   */
  onRoute?: (route: RouteOptions) => void;
  /** Catalog metadata source. Defaults to MusicBrainz via the global rate limiter and mb_cache. */
  metadata?: MetadataProvider;
  /** MusicBrainz client tuning (tests): limiter, fetch, clock, retry backoff. */
  metadataOptions?: Partial<Omit<MusicBrainzOptions, 'db' | 'settings' | 'logger'>>;
  /** Library matching for badges. Defaults to exact MBID matches; H-10 supplies a fuzzy one. */
  libraryLookup?: LibraryLookup;
  /** Catalog requests per user per minute (tests). */
  searchRateLimitMax?: number;
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

function describeClientError(error: unknown): {
  status: number;
  code: string;
  message: string;
  details?: unknown;
} {
  if (!(error instanceof Error)) return { status: 500, code: 'internal_error', message: '' };
  if (error instanceof HttpError) {
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
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
  const { onRoute } = deps;
  if (onRoute) app.addHook('onRoute', onRoute);

  let database = deps.db;
  if (!database) {
    const owned = openDatabase(MEMORY_DB);
    runMigrations(owned.db);
    app.addHook('onClose', () => {
      owned.close();
    });
    database = owned;
  }
  const secrets = deps.secrets ?? new SecretBox(config.secret ?? randomBytes(32));
  const jobs = new JobRunner({ database, logger: app.log, ...deps.jobs });
  jobs.define(maintenanceJob({ database, stagingDir: config.stagingDir }));
  jobs.schedule({ type: MAINTENANCE_JOB, every: MAINTENANCE_INTERVAL_MS });
  const settings = new SettingsService(database.db, secrets, app.log);
  const sessions = new SessionService(database.db, deps.auth);
  const apiKeys = new ApiKeyService(database.db, deps.auth?.now);
  app.decorate('hearer', {
    database,
    secrets,
    settings,
    jobs,
    users: new UsersService(database.db, settings),
    sessions,
    apiKeys,
    auth: createAuthHelpers({ config, settings, sessions, rateLimitMax: deps.auth?.rateLimitMax }),
    mediaServer: new MediaServerRegistry(settings, secrets, version, deps.mediaServerTimeoutMs),
    metadata:
      deps.metadata ??
      new MusicBrainzProvider({
        db: database.db,
        settings,
        logger: app.log,
        version,
        ...deps.metadataOptions,
      }),
    badges: new BadgeService(database.db, deps.libraryLookup),
  });
  if (deps.startJobs) {
    app.addHook('onReady', () => {
      jobs.start();
    });
  }
  // Registered after the owned-database hook; onClose hooks run last-registered first, so the
  // runner is stopped before the database closes.
  app.addHook('onClose', async () => {
    await jobs.stop({ graceMs: JOB_SHUTDOWN_GRACE_MS });
  });
  const dbHandle = database;

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
    const { status, code, message, details } = describeClientError(error);
    if (status >= 500 && !(error instanceof HttpError)) {
      request.log.error({ err: error }, 'unhandled error');
      return sendError(reply, 500, 'internal_error', 'Internal server error');
    }
    return sendError(reply, status, code, message, details);
  });

  await registerAuth(app, {
    config,
    settings,
    sessions,
    apiKeys,
    helpers: app.hearer.auth,
  });
  registerSetupGate(app);

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
    healthRoutes({
      version,
      checks: {
        db: () => {
          pingDatabase(dbHandle);
          return { status: 'ok' as const };
        },
        ...deps.healthChecks,
      },
    }),
    { prefix: API_PREFIX },
  );

  await app.register(authRoutes, { prefix: API_PREFIX });
  // H-07: Jellyfin sign-in
  await app.register(jellyfinAuthRoutes, { prefix: API_PREFIX });
  await app.register(setupRoutes(config), { prefix: API_PREFIX });
  await app.register(settingsRoutes, { prefix: API_PREFIX });
  await app.register(userRoutes, { prefix: API_PREFIX });
  // OIDC login (H-08)
  await app.register(oidcRoutes(config, { now: deps.auth?.now }), { prefix: API_PREFIX });
  // H-09: catalog search and browse.
  await app.register(
    searchRoutes(
      deps.searchRateLimitMax === undefined ? {} : { rateLimitMax: deps.searchRateLimitMax },
    ),
    {
      prefix: API_PREFIX,
    },
  );

  for (const plugin of deps.routes ?? []) {
    await app.register(plugin, { prefix: API_PREFIX });
  }

  return app;
}
