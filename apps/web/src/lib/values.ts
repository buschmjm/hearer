/** Read a loosely typed settings value as a string (settings sections arrive as plain objects). */
export const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;

export const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' ? value : fallback;

/** First message per top-level field from a zod error. */
export function zodFieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]) {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? '');
    out[key] ??= issue.message;
  }
  return out;
}
