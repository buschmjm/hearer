import type { z } from 'zod';

/** The server's error envelope: `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level messages from a `validation_error` (path joined with dots), if any. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (this.code !== 'validation_error' || !Array.isArray(this.details)) return out;
    for (const item of this.details as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const { message, instancePath, params } = item as {
        message?: unknown;
        instancePath?: unknown;
        params?: { issue?: { path?: unknown } };
      };
      const issuePath = params?.issue?.path;
      const path = Array.isArray(issuePath)
        ? issuePath.map(String).join('.')
        : typeof instancePath === 'string'
          ? instancePath.replace(/^\//, '').replaceAll('/', '.')
          : '';
      if (typeof message === 'string' && !(path in out)) out[path] = message;
    }
    return out;
  }
}

export const API_BASE = '/api/v1';

export interface ApiHandlers {
  /** A request that needed a session got 401. Typically: drop auth state, go to /login. */
  onUnauthorized?: () => void;
  /** The server answered 503 `setup_required`. Typically: go to /setup. */
  onSetupRequired?: () => void;
}

let handlers: ApiHandlers = {};
let csrfToken: string | null = null;

export function configureApi(next: ApiHandlers): void {
  handlers = next;
}

/** The CSRF token for the current session (from login, first-admin creation or /auth/me). */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiRequestOptions<T> {
  method?: HttpMethod;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
  /** Validate and type the response body (also strips unknown keys). */
  schema?: z.ZodType<T>;
  /** Run the 401 handler. Off for calls where 401 is an expected answer (login, /auth/me). */
  redirectOn401?: boolean;
  /** Run the setup_required handler. */
  redirectOnSetup?: boolean;
}

const MUTATING = new Set<HttpMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);

function buildUrl(path: string, query: ApiRequestOptions<unknown>['query']): string {
  const url = path.startsWith('/api/') ? path : `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function readEnvelope(res: Response): Promise<ApiError> {
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }
  const error = (
    parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined
  )?.error;
  const code = typeof error?.code === 'string' ? error.code : `http_${res.status}`;
  const message =
    typeof error?.message === 'string' ? error.message : `Request failed (${res.status})`;
  return new ApiError(res.status, code, message, error?.details);
}

/** Typed fetch against the Hearer API. Throws `ApiError` for every non-2xx answer. */
export async function api<T = unknown>(
  path: string,
  options: ApiRequestOptions<T> = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  // Cookie-authenticated writes must echo the session's CSRF token.
  if (MUTATING.has(method) && csrfToken) headers['x-csrf-token'] = csrfToken;

  let res: Response;
  try {
    res = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      credentials: 'same-origin',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Could not reach the server. Check your connection.');
  }

  if (!res.ok) {
    const error = await readEnvelope(res);
    if (error.status === 401 && options.redirectOn401 !== false) handlers.onUnauthorized?.();
    if (
      error.status === 503 &&
      error.code === 'setup_required' &&
      options.redirectOnSetup !== false
    ) {
      handlers.onSetupRequired?.();
    }
    throw error;
  }

  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json();
  return options.schema ? options.schema.parse(json) : (json as T);
}

/** Message safe to show a person for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
