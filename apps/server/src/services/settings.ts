import {
  REDACTED_SECRET,
  SETTINGS_CATALOG,
  SETTINGS_KEYS,
  settingsDefault,
  type SettingsInput,
  type SettingsKey,
  type SettingsValue,
} from '@hearer/shared';
import { eq } from 'drizzle-orm';
import type { ZodError } from 'zod';
import type { Db } from '../db/client.ts';
import { settings } from '../db/schema.ts';
import { SecretBox } from '../lib/secrets.ts';

export type AllSettings = { [K in SettingsKey]: SettingsValue<K> };

export interface SettingsLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export class SettingsValidationError extends Error {
  readonly key: SettingsKey;
  readonly issues: ZodError['issues'];

  constructor(key: SettingsKey, error: ZodError) {
    super(
      `Invalid value for setting "${key}": ${error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
    this.name = 'SettingsValidationError';
    this.key = key;
    this.issues = error.issues;
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Read a string at an object path; undefined when the path is absent or not a string. */
function getString(root: Json, path: readonly string[]): string | undefined {
  let node: unknown = root;
  for (const part of path) {
    if (!isObject(node)) return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Set a string at an object path, creating intermediate objects only if they already exist. */
function setString(root: Json, path: readonly string[], value: string): void {
  let node: unknown = root;
  for (const part of path.slice(0, -1)) {
    if (!isObject(node)) return;
    node = node[part];
  }
  const last = path[path.length - 1];
  if (isObject(node) && last !== undefined) node[last] = value;
}

/**
 * Typed settings store backed by the `settings` table. Values are validated against the shared
 * catalog on read and write, secret fields are encrypted at rest, and reads are cached in memory.
 */
export class SettingsService {
  readonly #db: Db;
  readonly #box: SecretBox;
  readonly #log: SettingsLogger;
  readonly #cache = new Map<SettingsKey, unknown>();

  constructor(db: Db, box: SecretBox, log: SettingsLogger) {
    this.#db = db;
    this.#box = box;
    this.#log = log;
  }

  get<K extends SettingsKey>(key: K): SettingsValue<K> {
    if (!this.#cache.has(key)) this.#cache.set(key, this.#load(key));
    return structuredClone(this.#cache.get(key)) as SettingsValue<K>;
  }

  set<K extends SettingsKey>(key: K, value: SettingsInput<K>): SettingsValue<K> {
    const def = SETTINGS_CATALOG[key];
    // The UI echoes redacted secrets back; treat that as "unchanged".
    let candidate: unknown = value;
    if (isObject(candidate) && def.secrets.length > 0) {
      const current = this.get(key) as unknown as Json;
      candidate = structuredClone(candidate);
      for (const path of def.secrets) {
        if (getString(candidate as Json, path) === REDACTED_SECRET) {
          setString(candidate as Json, path, getString(current, path) ?? '');
        }
      }
    }
    const parsed = def.schema.safeParse(candidate);
    if (!parsed.success) throw new SettingsValidationError(key, parsed.error);

    const stored = structuredClone(parsed.data) as Json;
    for (const path of def.secrets) {
      const plain = getString(stored, path);
      if (plain) setString(stored, path, this.#box.encrypt(plain));
    }
    const valueJson = JSON.stringify(stored);
    this.#db
      .insert(settings)
      .values({ key, valueJson })
      .onConflictDoUpdate({ target: settings.key, set: { valueJson, updatedAt: new Date() } })
      .run();
    this.#cache.set(key, parsed.data);
    return this.get(key);
  }

  getAll(): AllSettings {
    const entries = SETTINGS_KEYS.map((key) => [key, this.get(key)] as const);
    return Object.fromEntries(entries) as AllSettings;
  }

  /** Every setting with secret fields replaced by REDACTED_SECRET (or '' when unset). */
  getPublic(): AllSettings {
    const all = this.getAll();
    for (const key of SETTINGS_KEYS) {
      const value = all[key] as unknown as Json;
      for (const path of SETTINGS_CATALOG[key].secrets) {
        setString(value, path, getString(value, path) ? REDACTED_SECRET : '');
      }
    }
    return all;
  }

  /** Forget cached values, e.g. after another process wrote to the table. */
  invalidate(): void {
    this.#cache.clear();
  }

  #load<K extends SettingsKey>(key: K): SettingsValue<K> {
    const def = SETTINGS_CATALOG[key];
    const row = this.#db.select().from(settings).where(eq(settings.key, key)).get();
    if (!row) return settingsDefault(key);

    let raw: unknown;
    try {
      raw = JSON.parse(row.valueJson);
    } catch (err) {
      this.#log.warn({ key, err }, 'stored setting is not valid JSON; using defaults');
      return settingsDefault(key);
    }
    if (isObject(raw)) {
      for (const path of def.secrets) {
        const stored = getString(raw, path);
        if (stored === undefined || !SecretBox.isEncrypted(stored)) continue;
        try {
          setString(raw, path, this.#box.decrypt(stored));
        } catch (err) {
          // Typically the secret key changed. Blank the field so the rest of the setting survives.
          this.#log.warn(
            { key, field: path.join('.'), err },
            'could not decrypt stored secret; treating it as unset',
          );
          setString(raw, path, '');
        }
      }
    }
    const parsed = def.schema.safeParse(raw);
    if (!parsed.success) {
      this.#log.warn(
        { key, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
        'stored setting failed validation; using defaults',
      );
      return settingsDefault(key);
    }
    return parsed.data as SettingsValue<K>;
  }
}
