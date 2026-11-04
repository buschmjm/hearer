import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import { HttpError } from '../lib/http-error.ts';
import type { SettingsService } from '../services/settings.ts';
import { extractApiKey, type ApiKeyService } from './apikeys.ts';
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  csrfTokenMatches,
  type CreatedSession,
  type SessionService,
} from './sessions.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AuthHelpers {
  /** Create a session for the user and set the cookie. Replaces any session on the request. */
  startSession: (request: FastifyRequest, reply: FastifyReply, userId: string) => CreatedSession;
  /** (Re)issue the session cookie for an existing raw session id. */
  setSessionCookie: (
    request: FastifyRequest,
    reply: FastifyReply,
    rawId: string,
    expires: Date,
  ) => void;
  /** Expire the session cookie. */
  clearSessionCookie: (reply: FastifyReply) => void;
  /** Route `config.rateLimit` for brute-forceable endpoints (login, first-admin, password). */
  rateLimit: { max: number; timeWindow: string };
}

export interface AuthHelperDeps {
  config: Pick<Config, 'baseUrl' | 'authRateLimitMax'>;
  settings: SettingsService;
  sessions: SessionService;
  rateLimitMax?: number | undefined;
}

export function createAuthHelpers(deps: AuthHelperDeps): AuthHelpers {
  const isHttps = (url: string | undefined): boolean => url?.startsWith('https://') === true;
  /** Secure cookies when the request arrived over https or the public URL is https. */
  const secure = (request: FastifyRequest): boolean =>
    request.protocol === 'https' ||
    isHttps(deps.config.baseUrl) ||
    isHttps(deps.settings.get('general').applicationUrl);

  const setSessionCookie: AuthHelpers['setSessionCookie'] = (request, reply, id, expires) => {
    void reply.setCookie(SESSION_COOKIE, id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: secure(request),
      expires,
    });
  };

  return {
    setSessionCookie,
    startSession(request, reply, userId) {
      if (request.auth?.method === 'session') deps.sessions.destroy(request.auth.sessionId);
      const created = deps.sessions.create(userId, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      setSessionCookie(request, reply, created.id, created.expiresAt);
      return created;
    },
    clearSessionCookie(reply) {
      void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    },
    rateLimit: { max: deps.rateLimitMax ?? deps.config.authRateLimitMax, timeWindow: '1 minute' },
  };
}

export interface AuthPluginDeps extends AuthHelperDeps {
  apiKeys: ApiKeyService;
  helpers: AuthHelpers;
}

/**
 * Registers cookie parsing, the rate limiter (opt-in per route via `config.rateLimit`) and the
 * global hook that resolves `request.user` and enforces CSRF. Must run before routes are added.
 */
export async function registerAuth(app: FastifyInstance, deps: AuthPluginDeps): Promise<void> {
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_request, context) =>
      new HttpError(
        429,
        'rate_limited',
        `Too many attempts. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
      ),
  });

  app.decorateRequest('user', null);
  app.decorateRequest('auth', null);

  app.addHook('onRequest', (request, reply) => {
    request.user = null;
    request.auth = null;

    // An API key, when presented, is the only credential considered.
    const key = extractApiKey(request.headers);
    if (key !== undefined) {
      const found = deps.apiKeys.authenticate(key);
      if (found) {
        request.user = found.user;
        request.auth = { method: 'apiKey', keyId: found.keyId };
      }
      return Promise.resolve();
    }

    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return Promise.resolve();
    const session = deps.sessions.validate(raw);
    if (!session) {
      deps.helpers.clearSessionCookie(reply);
      return Promise.resolve();
    }
    if (
      !SAFE_METHODS.has(request.method) &&
      request.routeOptions.config.csrfExempt !== true &&
      !csrfTokenMatches(raw, request.headers[CSRF_HEADER])
    ) {
      throw new HttpError(403, 'csrf_invalid', 'Missing or invalid CSRF token');
    }
    request.user = session.user;
    request.auth = { method: 'session', sessionId: raw, csrfToken: session.csrfToken };
    if (session.refreshed) {
      // Re-issue the cookie so its expiry slides with the session.
      deps.helpers.setSessionCookie(request, reply, raw, session.expiresAt);
    }
    return Promise.resolve();
  });
}
