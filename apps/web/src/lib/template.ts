/**
 * Naming-template helpers for the setup wizard's live preview.
 *
 * Syntax (matches the server default): `{name}` inserts a value, `{name:02}` zero-pads to a width,
 * and `{disc:?}` inserts "<disc>-" only for multi-disc releases. The preview is an approximation
 * for the wizard; the import batch owns the real renderer and sanitisation.
 */
export const TEMPLATE_VARIABLES = {
  artist: 'Track artist',
  albumartist: 'Album artist',
  album: 'Album title',
  year: 'Release year',
  disc: 'Disc number',
  track: 'Track number',
  title: 'Track title',
  ext: 'File extension',
} as const;

export type TemplateVariable = keyof typeof TEMPLATE_VARIABLES;

export interface TemplateSample {
  artist: string;
  albumartist: string;
  album: string;
  year: string;
  disc: number;
  discCount: number;
  track: number;
  title: string;
  ext: string;
}

export const SAMPLE_ALBUM_TRACK: TemplateSample = {
  artist: 'Radiohead',
  albumartist: 'Radiohead',
  album: 'OK Computer',
  year: '1997',
  disc: 1,
  discCount: 1,
  track: 2,
  title: 'Paranoid Android',
  ext: 'flac',
};

const TOKEN = /\{(\w+)(?::([^}]*))?\}/g;

const isVariable = (name: string): name is TemplateVariable =>
  Object.hasOwn(TEMPLATE_VARIABLES, name);

/** Characters that cannot appear in a path segment are replaced, as the real renderer will. */
const clean = (value: string): string => value.replace(/[\\/:*?"<>|]/g, '_').trim();

/** Problems with a template, as messages; empty when it is usable. */
export function validateTemplate(template: string): string[] {
  const problems: string[] = [];
  for (const match of template.matchAll(TOKEN)) {
    const [, name = '', spec] = match;
    if (!isVariable(name)) problems.push(`Unknown variable {${name}}`);
    else if (spec !== undefined && spec !== '?' && !/^0?\d{1,2}$/.test(spec)) {
      problems.push(`Bad format "${spec}" in {${name}:${spec}}`);
    }
  }
  const stripped = template.replace(TOKEN, '');
  if (/[{}]/.test(stripped)) problems.push('Unbalanced braces');
  if (!/\{title(:[^}]*)?\}/.test(template))
    problems.push('Include {title} so files get distinct names');
  if (!/\{ext(:[^}]*)?\}/.test(template))
    problems.push('Include {ext} so files keep their extension');
  if (template.startsWith('/') || template.split('/').includes('..')) {
    problems.push('Use a relative path without ".."');
  }
  return problems;
}

/** Render a template with sample data. Unknown variables are left visible as written. */
export function renderTemplate(
  template: string,
  sample: TemplateSample = SAMPLE_ALBUM_TRACK,
): string {
  return template
    .replace(TOKEN, (whole, name: string, spec: string | undefined) => {
      if (!isVariable(name)) return whole;
      const value = sample[name];
      if (name === 'disc' && spec === '?') {
        return sample.discCount > 1 ? `${sample.disc}-` : '';
      }
      if (typeof value === 'number') {
        const width = spec ? Number(spec) : 0;
        return String(value).padStart(Number.isNaN(width) ? 0 : width, '0');
      }
      return clean(value);
    })
    .split('/')
    .map((part) => part.trim())
    .join('/');
}
