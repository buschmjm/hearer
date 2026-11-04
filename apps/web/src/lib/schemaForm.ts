/**
 * Helpers for forms generated from a JSON Schema (draft 2020-12, as produced by zod's
 * `toJSONSchema`). Used by the fulfillment provider and notification agent forms. Only the
 * subset those schemas use is understood; anything else renders as an "unsupported" note rather
 * than breaking the form.
 */
export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  additionalProperties?: JsonSchema | boolean;
  propertyNames?: { pattern?: string };
  /** Set by the server on secret properties. */
  'x-secret'?: boolean;
}

export type FieldKind =
  | 'secret'
  | 'boolean'
  | 'number'
  | 'enum'
  | 'string'
  | 'url'
  | 'list'
  | 'multiEnum'
  | 'map'
  | 'unsupported';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Narrow an API payload to a schema object (the server is trusted; this only guards the shape). */
export function asSchema(value: unknown): JsonSchema {
  return isRecord(value) ? value : {};
}

const typeOf = (schema: JsonSchema): string | undefined =>
  Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;

/** `anyOf: [{const: ''}, {format: 'uri'}]` (an optional URL) collapses to one string schema. */
function flatten(schema: JsonSchema): JsonSchema {
  if (!schema.anyOf || schema.anyOf.length === 0) return schema;
  const branches = schema.anyOf;
  if (branches.every((b) => typeOf(b) === 'string')) {
    const format = branches.find((b) => b.format)?.format;
    return { ...schema, type: 'string', ...(format ? { format } : {}) };
  }
  return schema;
}

export function fieldKind(raw: JsonSchema): FieldKind {
  const schema = flatten(raw);
  if (schema['x-secret']) return 'secret';
  const type = typeOf(schema);
  if (type === 'boolean') return 'boolean';
  if (type === 'integer' || type === 'number') return 'number';
  if (schema.enum && schema.enum.length > 0) return 'enum';
  if (type === 'string') return schema.format === 'uri' ? 'url' : 'string';
  if (type === 'array') {
    const items = schema.items ? flatten(schema.items) : undefined;
    if (items?.enum && items.enum.length > 0) return 'multiEnum';
    if (items && typeOf(items) === 'string') return 'list';
  }
  if (type === 'object' && isRecord(schema.additionalProperties)) return 'map';
  return 'unsupported';
}

const ACRONYMS: Record<string, string> = {
  url: 'URL',
  uri: 'URI',
  id: 'ID',
  api: 'API',
  tls: 'TLS',
  smtp: 'SMTP',
  ntfy: 'ntfy',
  ui: 'UI',
  mb: 'MB',
};

/** `webhookUrl` -> "Webhook URL". Schemas carry no titles, so labels come from property names. */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((word) => ACRONYMS[word] ?? word);
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function propertyEntries(schema: JsonSchema): [string, JsonSchema][] {
  return Object.entries(schema.properties ?? {});
}

/** The values a new form starts with: each property's schema default. */
export function schemaDefaults(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, prop] of propertyEntries(schema)) {
    if (prop.default !== undefined) out[name] = prop.default;
  }
  return out;
}

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);

/**
 * Client-side checks for the constraints the schema states, keyed by property name. The server
 * validates again; this just saves a round trip and points at the field.
 */
export function validateAgainstSchema(
  schema: JsonSchema,
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const required = new Set(schema.required ?? []);
  for (const [name, raw] of propertyEntries(schema)) {
    const prop = flatten(raw);
    const value = values[name];
    const kind = fieldKind(raw);
    if (kind === 'boolean' || kind === 'unsupported') continue;
    if (isEmpty(value)) {
      if (required.has(name)) errors[name] = 'This field is required.';
      continue;
    }
    if (kind === 'number') {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        errors[name] = 'Enter a number.';
      } else if (typeOf(prop) === 'integer' && !Number.isInteger(value)) {
        errors[name] = 'Enter a whole number.';
      } else if (prop.minimum !== undefined && value < prop.minimum) {
        errors[name] = `Must be at least ${String(prop.minimum)}.`;
      } else if (prop.maximum !== undefined && prop.maximum < 1e12 && value > prop.maximum) {
        errors[name] = `Must be at most ${String(prop.maximum)}.`;
      }
      continue;
    }
    if (kind === 'enum') {
      if (!prop.enum?.includes(value)) errors[name] = 'Choose one of the options.';
      continue;
    }
    if (typeof value !== 'string') continue;
    if (kind === 'secret') continue; // the server checks lengths against the real value
    if (prop.minLength !== undefined && value.length < prop.minLength) {
      errors[name] = `Must be at least ${String(prop.minLength)} characters.`;
    } else if (prop.maxLength !== undefined && value.length > prop.maxLength) {
      errors[name] = `Must be at most ${String(prop.maxLength)} characters.`;
    } else if (kind === 'url' && !isHttpUrl(value)) {
      errors[name] = 'Enter a full URL, for example https://example.com.';
    } else if (prop.pattern && !matchesPattern(prop.pattern, value)) {
      errors[name] = 'This value is not in the expected format.';
    }
  }
  return errors;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function matchesPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(value);
  } catch {
    return true; // a pattern JS cannot compile is the server's to enforce
  }
}

/** Drop blank optional numbers (the server applies defaults), blank list lines and unnamed map rows. */
export function normalizeConfig(
  schema: JsonSchema,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  const blankNumbers = new Set<string>();
  for (const [name, prop] of propertyEntries(schema)) {
    const kind = fieldKind(prop);
    const current = out[name];
    if (kind === 'number' && (current === '' || current === undefined)) {
      blankNumbers.add(name);
    } else if (kind === 'list' && Array.isArray(current)) {
      out[name] = current.map((line) => String(line).trim()).filter(Boolean);
    } else if (kind === 'map' && isRecord(current)) {
      out[name] = Object.fromEntries(Object.entries(current).filter(([key]) => key.trim() !== ''));
    }
  }
  return Object.fromEntries(Object.entries(out).filter(([name]) => !blankNumbers.has(name)));
}
