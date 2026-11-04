/**
 * Route guards. They are `onRequest` hooks, so authorization runs before body validation: an
 * anonymous caller always gets 401 (never a 400 that leaks the schema) and a caller without the
 * permission gets 403.
 *
 *   app.get('/things', { onRequest: [requirePermission(Permission.MANAGE_USERS)] }, handler)
 *   app.get('/me', { onRequest: [requireAuth()] }, handler)
 *
 * `request.user` is populated for every request by the auth plugin (session cookie or API key);
 * a route that declares no guard is public. The route-matrix test fails when a route is
 * unguarded and not on its explicit public allowlist.
 */
import type { onRequestAsyncHookHandler } from 'fastify';
import { hasPermission, type HasPermissionOptions } from './permissions.ts';
import { forbidden, unauthorized } from '../lib/http-error.ts';
import type { AuthUser } from '../services/users.ts';

export type RequestAuth =
  { method: 'session'; sessionId: string; csrfToken: string } | { method: 'apiKey'; keyId: string };

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated user, or null for anonymous requests. */
    user: AuthUser | null;
    /** How the request authenticated, or null when anonymous. */
    auth: RequestAuth | null;
  }
  interface FastifyContextConfig {
    /** Skip the CSRF check (only for routes that create a session and do not rely on one). */
    csrfExempt?: boolean;
  }
}

export function requireAuth(): onRequestAsyncHookHandler {
  return (request) => {
    if (!request.user) throw unauthorized();
    return Promise.resolve();
  };
}

/**
 * Require a permission (or several, `and` by default, or `{type:'or'}`). ADMIN implies all.
 */
export function requirePermission(
  required: number | readonly number[],
  options: HasPermissionOptions = {},
): onRequestAsyncHookHandler {
  return (request) => {
    if (!request.user) throw unauthorized();
    if (!hasPermission(request.user.permissions, required, options)) throw forbidden();
    return Promise.resolve();
  };
}

/**
 * Like requireAuth, but refuses API keys. For credential management (passwords, API keys), so
 * a leaked key cannot mint further keys or change the password.
 */
export function requireSession(): onRequestAsyncHookHandler {
  return (request) => {
    if (!request.user) throw unauthorized();
    if (request.auth?.method !== 'session') {
      throw forbidden('This action requires an interactive session', 'session_required');
    }
    return Promise.resolve();
  };
}
