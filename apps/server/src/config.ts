import { z } from 'zod';

/** Accepts "true"/"false"/"1"/"0" or a proxy hop count ("2"). */
const trustProxy = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value, ctx): boolean | number => {
    if (value === 'true') return true;
    if (value === 'false' || value === '0' || value === '') return false;
    if (/^\d+$/.test(value)) return Number(value);
    ctx.addIssue({ code: 'custom', message: 'must be true, false or a hop count' });
    return z.NEVER;
  });

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5055),
  BASE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  DATA_DIR: z.string().min(1).default('/data'),
  MUSIC_DIR: z.string().min(1).default('/music'),
  STAGING_DIR: z.string().min(1).default('/staging'),
  STATIC_DIR: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  HEARER_SECRET: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  TRUST_PROXY: z.preprocess(emptyToUndefined, trustProxy.default(false)),
  /** Crash-test hook for the end-to-end suite; only honored when NODE_ENV=test. */
  HEARER_TEST_IMPORT_PAUSE_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(600_000).optional(),
  ),
  HEARER_TEST_IMPORT_PAUSE_AT: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  AUTH_RATE_LIMIT_MAX: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).default(10)),
});

export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  host: string;
  port: number;
  baseUrl: string | undefined;
  dataDir: string;
  musicDir: string;
  stagingDir: string;
  /** Built web app. Undefined means "use the default location if it exists" (see static.ts). */
  staticDir: string | undefined;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  logFormat: 'json' | 'pretty';
  /** Optional; when absent a secret is generated into DATA_DIR later. */
  secret: string | undefined;
  trustProxy: boolean | number;
  /** Login / setup attempts allowed per client address per minute. */
  authRateLimitMax: number;
  /**
   * Test only (NODE_ENV=test): sleep this long at the named import step (default `state-saved`),
   * so a test can kill the process mid-import. Always undefined in production.
   */
  testImportPause: { ms: number; point: string } | undefined;
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Parse and validate environment variables. Pure: never reads process state itself. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    baseUrl: e.BASE_URL,
    dataDir: e.DATA_DIR,
    musicDir: e.MUSIC_DIR,
    stagingDir: e.STAGING_DIR,
    staticDir: e.STATIC_DIR,
    logLevel: e.LOG_LEVEL,
    logFormat: e.LOG_FORMAT,
    secret: e.HEARER_SECRET,
    trustProxy: e.TRUST_PROXY,
    authRateLimitMax: e.AUTH_RATE_LIMIT_MAX,
    testImportPause:
      e.NODE_ENV === 'test' && e.HEARER_TEST_IMPORT_PAUSE_MS !== undefined
        ? {
            ms: e.HEARER_TEST_IMPORT_PAUSE_MS,
            point: e.HEARER_TEST_IMPORT_PAUSE_AT ?? 'state-saved',
          }
        : undefined,
  };
}
