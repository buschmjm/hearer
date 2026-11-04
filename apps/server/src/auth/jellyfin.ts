import {
  Permission,
  loginRequestSchema,
  permissionNames,
  sessionResponseSchema,
} from '@hearer/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import {
  MediaServerAuthError,
  MediaServerError,
  MediaServerNotConfiguredError,
  MediaServerUnavailableError,
} from '../adapters/mediaserver/types.ts';
import { HttpError } from '../lib/http-error.ts';
import type { SettingsService } from '../services/settings.ts';
import { toUserDto } from '../services/users.ts';

/**
 * Permissions for a Jellyfin user that Hearer creates on first login or import: the configured
 * `general.defaultPermissions` without UPLOAD. Uploads write into the library, so an admin grants
 * them deliberately (PLAN open question: imported users do not get UPLOAD by default).
 *
 * A Jellyfin administrator does NOT become a Hearer ADMIN. Being trusted to run the media server
 * says nothing about who may approve requests, change settings or manage Hearer users here, and
 * silently minting admins from an external system would let anyone who controls (or compromises)
 * that server take over Hearer. Promote people explicitly in the users admin.
 */
export function jellyfinDefaultPermissions(settings: SettingsService): number {
  return settings.get('general').defaultPermissions & ~Permission.UPLOAD;
}

/** Translate adapter failures into the API error envelope (502 upstream, 503 not configured). */
export function mediaServerHttpError(err: unknown, options: { redact?: boolean } = {}): HttpError {
  // Public callers must not learn internal URLs or upstream details from error messages.
  const text = (message: string, generic: string) => (options.redact ? generic : message);
  if (err instanceof MediaServerNotConfiguredError) {
    return new HttpError(503, 'media_server_not_configured', 'No media server is configured');
  }
  if (err instanceof MediaServerUnavailableError) {
    return new HttpError(
      502,
      'media_server_unavailable',
      text(err.message, 'The media server is unavailable'),
    );
  }
  if (err instanceof MediaServerAuthError) {
    // The API key (not the user's password) was refused: an operator problem, not a login failure.
    return new HttpError(
      502,
      'media_server_auth_failed',
      text(err.message, 'The media server is not available for sign-in right now'),
    );
  }
  if (err instanceof MediaServerError) {
    return new HttpError(
      502,
      'media_server_error',
      text(err.message, 'The media server returned an unexpected response'),
    );
  }
  throw err;
}

/** `POST /auth/jellyfin`: sign in with a Jellyfin account. */
export const jellyfinAuthRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  const { users, settings, auth, mediaServer } = app.hearer;

  app.post(
    '/auth/jellyfin',
    {
      // Creates a session; it does not depend on an existing one.
      config: { csrfExempt: true, rateLimit: auth.rateLimit },
      schema: {
        tags: ['auth'],
        summary: 'Sign in with a Jellyfin account',
        body: loginRequestSchema,
        response: { 200: sessionResponseSchema },
      },
    },
    async (request, reply) => {
      if (!settings.get('auth').jellyfinEnabled) {
        throw new HttpError(403, 'jellyfin_auth_disabled', 'Jellyfin sign-in is disabled');
      }
      const { username, password } = request.body;
      let external;
      try {
        external = await mediaServer.get().authenticate(username, password);
      } catch (err) {
        if (err instanceof MediaServerAuthError) {
          throw new HttpError(401, 'invalid_credentials', 'Invalid username or password');
        }
        throw mediaServerHttpError(err, { redact: true });
      }
      if (external.isDisabled) {
        throw new HttpError(401, 'invalid_credentials', 'Invalid username or password');
      }
      const { user } = users.findOrCreateExternalUser(
        'jellyfin',
        external.id,
        {
          username: external.name,
          displayName: external.name,
          ...(external.email === undefined ? {} : { email: external.email }),
        },
        { permissions: jellyfinDefaultPermissions(settings) },
      );
      users.touchLogin(user.id);
      const session = auth.startSession(request, reply, user.id);
      const fresh = users.get(user.id) ?? user;
      return {
        user: toUserDto(fresh),
        permissions: permissionNames(fresh.permissions),
        csrfToken: session.csrfToken,
      };
    },
  );
  done();
};
