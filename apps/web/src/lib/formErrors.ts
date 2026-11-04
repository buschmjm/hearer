import { ApiError } from '../api/client.ts';

/**
 * Field messages from an API validation error. Handles the three shapes the server produces:
 * route-schema errors (`instancePath`), wrapped zod issues, and raw zod issues from the settings
 * and notification services (`path` array). Keys are dotted paths, optionally under `prefix`.
 */
export function serverFieldErrors(err: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(err instanceof ApiError)) return out;
  Object.assign(out, err.fieldErrors);
  if (err.code === 'validation_error' && Array.isArray(err.details)) {
    for (const item of err.details as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const { path, message } = item as { path?: unknown; message?: unknown };
      if (Array.isArray(path) && typeof message === 'string') {
        const key = path.map(String).join('.');
        if (!(key in out)) out[key] = message;
      }
    }
  }
  if (!prefix) return out;
  return Object.fromEntries(
    Object.entries(out).map(([key, message]) => [
      key.startsWith(`${prefix}.`) ? key.slice(prefix.length + 1) : key,
      message,
    ]),
  );
}

/** First message per dotted path from zod issues. */
export function zodErrors(issues: readonly { path: PropertyKey[]; message: string }[]) {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.');
    out[key] ??= issue.message;
  }
  return out;
}
