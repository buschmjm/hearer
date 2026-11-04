/** Read a nested value by path, or undefined. */
export function getIn(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Immutable nested set; creates missing objects along the way. */
export function setIn<T extends Record<string, unknown>>(
  source: T,
  path: readonly string[],
  value: unknown,
): T {
  const [head, ...rest] = path;
  if (head === undefined) return source;
  if (rest.length === 0) return { ...source, [head]: value };
  const child = source[head];
  const base =
    typeof child === 'object' && child !== null && !Array.isArray(child)
      ? (child as Record<string, unknown>)
      : {};
  return { ...source, [head]: setIn(base, rest, value) };
}

export const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
