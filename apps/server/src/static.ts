import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.ts';

/** Where the Docker image puts the built web app. */
export const DOCKER_STATIC_DIR = '/app/public';

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The directory holding the built web app, or undefined when there is none (API-only mode).
 * `STATIC_DIR` wins. Otherwise production uses the image path and development uses
 * `apps/web/dist` next to the server sources (both `src/` and the bundled `dist/` sit two
 * levels below `apps/`). Tests never pick up a default so they stay API-only.
 */
export function resolveStaticDir(
  config: Pick<Config, 'staticDir' | 'nodeEnv'>,
): string | undefined {
  const candidate =
    config.staticDir ??
    (config.nodeEnv === 'production'
      ? DOCKER_STATIC_DIR
      : config.nodeEnv === 'development'
        ? fileURLToPath(new URL('../../web/dist', import.meta.url))
        : undefined);
  if (candidate === undefined) return undefined;
  return isDirectory(candidate) && existsSync(`${candidate}/index.html`) ? candidate : undefined;
}

/**
 * Content-Security-Policy for the web app. Tailwind and Vite emit real CSS files and the theme
 * bootstrap is a separate script, so neither inline scripts nor inline styles are allowed.
 * Cover art comes from the Cover Art Archive, which redirects to archive.org hosts.
 * `upgrade-insecure-requests` is deliberately off: many installs run on plain http.
 */
export const CONTENT_SECURITY_POLICY = {
  useDefaults: false,
  directives: {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: [
      "'self'",
      'data:',
      'https://coverartarchive.org',
      'https://archive.org',
      'https://*.archive.org',
    ],
    fontSrc: ["'self'"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
  },
} as const;

function cacheControlFor(path: string): string {
  // Vite emits content-hashed files under /assets/, which never change.
  if (/[\\/]assets[\\/]/.test(path)) return 'public, max-age=31536000, immutable';
  if (path.endsWith('index.html')) return 'no-cache';
  return 'public, max-age=3600';
}

const wantsHtml = (request: FastifyRequest): boolean =>
  (request.headers.accept ?? '').includes('text/html');

/** Security headers for every response (API included). */
export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: CONTENT_SECURITY_POLICY,
    // Cover art and the OIDC round trip are cross-origin navigations/loads; keep helmet's other
    // defaults (nosniff, referrer policy, frame denial, same-origin resource policy).
    crossOriginEmbedderPolicy: false,
  });
}

/**
 * Serve the built web app with a single-page-app fallback. Returns the "not found" renderer to
 * use for unknown paths: browsers asking for HTML get index.html, everything else (and every
 * /api path) keeps the JSON 404.
 */
export async function registerWebApp(
  app: FastifyInstance,
  root: string,
): Promise<(request: FastifyRequest, reply: FastifyReply) => FastifyReply | undefined> {
  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    index: ['index.html'],
    cacheControl: false,
    setHeaders: (res, path) => {
      void res.header('cache-control', cacheControlFor(path));
    },
  });
  return (request, reply) => {
    const isApi = request.url === '/api' || request.url.startsWith('/api/');
    const method = request.method;
    if (isApi || (method !== 'GET' && method !== 'HEAD') || !wantsHtml(request)) return undefined;
    return reply.type('text/html; charset=utf-8').sendFile('index.html');
  };
}
