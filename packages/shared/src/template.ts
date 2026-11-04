/**
 * Library path templates (`library.namingTemplate`, `library.singlesTemplate`).
 *
 * Syntax: `{name}` inserts a value, `{name:02}` zero-pads a number to that width (disc, track),
 * and `{disc:?}` inserts "<disc>-" only on multi-disc releases (discTotal > 1). A literal `/`
 * in the template separates path segments; slashes inside VALUES never do (the renderer replaces
 * them). The server renders (`apps/server/src/lib/pathTemplate.ts`); the setup wizard previews
 * with the same variable names (`apps/web/src/lib/template.ts`).
 */

/** Text variables; the value is sanitized per path segment when rendered. */
export const TEXT_TEMPLATE_VARIABLES = [
  'albumartist',
  'artist',
  'album',
  'title',
  'ext',
  'genre',
  /** Full release date as tagged (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`). */
  'date',
  /** The four-digit year of `date`. */
  'year',
  'mbrecording',
  'mbtrack',
  'mbrelease',
  'mbreleasegroup',
  'mbartist',
  'mbalbumartist',
  'acoustid',
] as const;

/** Numeric variables; these accept a zero-pad width. */
export const NUMERIC_TEMPLATE_VARIABLES = ['disc', 'track'] as const;

export const TEMPLATE_VARIABLE_NAMES: readonly string[] = [
  ...TEXT_TEMPLATE_VARIABLES,
  ...NUMERIC_TEMPLATE_VARIABLES,
];

export type TemplateVariableName =
  (typeof TEXT_TEMPLATE_VARIABLES)[number] | (typeof NUMERIC_TEMPLATE_VARIABLES)[number];

/** `{name}` or `{name:spec}`; the name is any word so unknown ones can be reported. */
export const TEMPLATE_TOKEN = /\{(\w+)(?::([^{}]*))?\}/gu;

const isNumeric = (name: string): boolean =>
  (NUMERIC_TEMPLATE_VARIABLES as readonly string[]).includes(name);

/** Problems with a template as messages; empty when it can be used. */
export function validateNamingTemplate(template: string): string[] {
  const problems: string[] = [];
  if (template.trim() === '') return ['The template is empty'];
  for (const match of template.matchAll(TEMPLATE_TOKEN)) {
    const [, name = '', spec] = match;
    if (!TEMPLATE_VARIABLE_NAMES.includes(name)) {
      problems.push(`Unknown variable {${name}}`);
    } else if (spec !== undefined) {
      const okSpec =
        (spec === '?' && name === 'disc') || (isNumeric(name) && /^0?[1-9]$/u.test(spec));
      if (!okSpec) problems.push(`Bad format "${spec}" in {${name}:${spec}}`);
    }
  }
  if (/[{}]/u.test(template.replace(TEMPLATE_TOKEN, ''))) problems.push('Unbalanced braces');
  if (!/\{title(?::[^{}]*)?\}/u.test(template)) {
    problems.push('Include {title} so files get distinct names');
  }
  if (!/\{ext(?::[^{}]*)?\}/u.test(template)) {
    problems.push('Include {ext} so files keep their extension');
  }
  if (template.includes('\0')) problems.push('The template contains a NUL character');
  if (template.includes('\\')) problems.push('Use "/" as the folder separator, not "\\"');
  if (template.startsWith('/')) problems.push('Use a relative path (no leading "/")');
  if (template.split('/').some((part) => part.trim() === '..')) {
    problems.push('Use a relative path without ".."');
  }
  return problems;
}
