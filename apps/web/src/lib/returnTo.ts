/** Only same-site absolute paths are allowed as a post-login destination (no open redirects). */
export function safeReturnTo(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined;
  // Never bounce back to the pages that lead here.
  if (/^\/(login|setup)(\/|\?|$)/.test(value)) return undefined;
  return value;
}
