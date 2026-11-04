import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { AuthorizationResponseError } from 'openid-client';
import { z } from 'zod';
import { requirePermission } from '../auth/guard.ts';
import {
  OIDC_COOKIE,
  OIDC_COOKIE_PATH,
  OidcLoginError,
  OidcService,
  TRANSACTION_TTL_MS,
  resolveOidcUser,
} from '../auth/oidc.ts';
import { Permission } from '../auth/permissions.ts';
import type { Config } from '../config.ts';
import { HttpError } from '../lib/http-error.ts';

/** Where the web app shows sign-in errors (`/login?error=<code>`). */
const loginErrorUrl = (code: string): string => `/login?error=${encodeURIComponent(code)}`;

const discoveryResult = z.object({
  ok: z.boolean(),
  redirectUri: z.string(),
  issuer: z.string().optional(),
  authorizationEndpoint: z.string().nullable().optional(),
  tokenEndpoint: z.string().nullable().optional(),
  jwksUri: z.string().nullable().optional(),
  userinfoEndpoint: z.string().nullable().optional(),
  pkceS256: z.boolean().nullable().optional(),
  idTokenAlgs: z.array(z.string()).optional(),
  error: z.string().optional(),
});

/** OIDC routes: public login flow under /auth/oidc, admin helpers under /settings/auth/oidc. */
export const oidcRoutes =
  (
    config: Pick<Config, 'baseUrl'>,
    options: { now?: (() => number) | undefined } = {},
  ): FastifyPluginCallbackZod =>
  (app, _options, done) => {
    const { users, settings, secrets, auth } = app.hearer;
    const oidc = new OidcService({ settings, secrets, config, now: options.now });
    const rateLimit = auth.rateLimit;

    const isHttps = (url: string | undefined): boolean => url?.startsWith('https://') === true;
    const cookieOptions = (request: FastifyRequest) => ({
      path: OIDC_COOKIE_PATH,
      httpOnly: true,
      // Lax so the browser sends it on the top-level redirect back from the IdP.
      sameSite: 'lax' as const,
      secure:
        request.protocol === 'https' ||
        isHttps(config.baseUrl) ||
        isHttps(settings.get('general').applicationUrl),
    });
    const clearTransaction = (request: FastifyRequest, reply: FastifyReply) => {
      void reply.clearCookie(OIDC_COOKIE, cookieOptions(request));
    };

    app.get(
      '/auth/oidc/config',
      {
        schema: {
          tags: ['auth'],
          summary: 'Whether single sign-on is available, and its button label',
          response: { 200: z.object({ enabled: z.boolean(), buttonLabel: z.string() }) },
        },
      },
      () => ({ enabled: oidc.isEnabled(), buttonLabel: oidc.settings.buttonLabel }),
    );

    app.get(
      '/auth/oidc/login',
      {
        config: { rateLimit },
        schema: {
          tags: ['auth'],
          summary: 'Start single sign-on (redirects to the identity provider)',
          querystring: z.object({ returnTo: z.string().max(4096).optional() }),
        },
      },
      async (request, reply) => {
        if (!oidc.isEnabled()) throw new HttpError(404, 'oidc_disabled', 'Single sign-on is off');
        try {
          const { location, cookie } = await oidc.begin(request, request.query.returnTo);
          void reply.setCookie(OIDC_COOKIE, cookie, {
            ...cookieOptions(request),
            maxAge: TRANSACTION_TTL_MS / 1000,
          });
          return await reply.redirect(location);
        } catch (err) {
          request.log.warn({ err }, 'oidc login could not start');
          return await reply.redirect(loginErrorUrl('oidc_unavailable'));
        }
      },
    );

    app.get(
      '/auth/oidc/callback',
      {
        config: { rateLimit },
        schema: {
          tags: ['auth'],
          summary: 'Single sign-on return URL (the identity provider redirects here)',
        },
      },
      async (request, reply) => {
        const fail = (code: string, err: unknown) => {
          request.log.warn({ err, code }, 'oidc login failed');
          clearTransaction(request, reply);
          return reply.redirect(loginErrorUrl(code));
        };
        if (!oidc.isEnabled()) return fail('oidc_disabled', 'single sign-on is off');
        try {
          const identity = await oidc.complete(request, request.cookies[OIDC_COOKIE]);
          const user = resolveOidcUser(users, oidc.settings, identity);
          users.touchLogin(user.id);
          auth.startSession(request, reply, user.id);
          clearTransaction(request, reply);
          return await reply.redirect(identity.returnTo);
        } catch (err) {
          if (err instanceof OidcLoginError) return fail(err.code, err);
          if (err instanceof AuthorizationResponseError && err.error === 'access_denied') {
            return fail('access_denied', err);
          }
          return fail('login_failed', err);
        }
      },
    );

    app.get(
      '/settings/auth/oidc/redirect-uri',
      {
        onRequest: [requirePermission(Permission.MANAGE_SETTINGS)],
        schema: {
          tags: ['settings'],
          summary: 'The redirect URI to register at the identity provider',
          response: { 200: z.object({ redirectUri: z.string() }) },
        },
      },
      (request) => ({ redirectUri: oidc.redirectUri(request) }),
    );

    app.post(
      '/settings/auth/oidc/test',
      {
        onRequest: [requirePermission(Permission.MANAGE_SETTINGS)],
        schema: {
          tags: ['settings'],
          summary: 'Run OIDC discovery against a candidate issuer URL',
          body: z.object({
            issuerUrl: z.url(),
            allowInsecureHttp: z.boolean().default(false),
          }),
          response: { 200: discoveryResult },
        },
      },
      async (request) => {
        const redirectUri = oidc.redirectUri(request);
        try {
          const summary = await oidc.testDiscovery(
            request.body.issuerUrl,
            request.body.allowInsecureHttp,
          );
          return { ok: true, redirectUri, ...summary };
        } catch (err) {
          request.log.info({ err }, 'oidc discovery test failed');
          return {
            ok: false,
            redirectUri,
            error: err instanceof Error ? err.message : 'Discovery failed',
          };
        }
      },
    );
    done();
  };
