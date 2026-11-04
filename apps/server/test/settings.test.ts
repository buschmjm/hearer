import {
  DEFAULT_NAMING_TEMPLATE,
  DEFAULT_USER_PERMISSIONS,
  Permission,
  REDACTED_SECRET,
  SETTINGS_KEYS,
} from '@hearer/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { openDatabase, type Database_ } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { settings } from '../src/db/schema.ts';
import { SecretBox } from '../src/lib/secrets.ts';
import {
  SettingsService,
  SettingsValidationError,
  type SettingsLogger,
} from '../src/services/settings.ts';

let database: Database_;
let box: SecretBox;
let warn: Mock<SettingsLogger['warn']>;
let service: SettingsService;

const makeService = (b = box) => new SettingsService(database.db, b, { warn });
const rawRow = (key: string) =>
  database.db.select().from(settings).where(eq(settings.key, key)).get();

beforeEach(() => {
  database = openDatabase(':memory:');
  runMigrations(database.db);
  box = new SecretBox('settings-test-secret-key');
  warn = vi.fn<SettingsLogger['warn']>();
  service = makeService();
});
afterEach(() => {
  database.close();
});

describe('defaults', () => {
  it('returns defaults for every key when nothing is stored', () => {
    const all = service.getAll();
    expect(Object.keys(all).sort()).toEqual([...SETTINGS_KEYS].sort());
    expect(all.general).toMatchObject({
      appTitle: 'Hearer',
      setupComplete: false,
      defaultPermissions: DEFAULT_USER_PERMISSIONS,
    });
    expect(all.library.namingTemplate).toBe(DEFAULT_NAMING_TEMPLATE);
    expect(all.library.singlesTemplate).toBe('{albumartist}/Singles/{title}.{ext}');
    expect(all.uploads).toMatchObject({
      maxFileSizeMb: 2048,
      autoApproveThreshold: 0.9,
      coverMaxPx: 1200,
    });
    expect(all.mediaServer.type).toBe('jellyfin');
    expect(all.fulfillment.lidarr.trackPolicy).toBe('album');
    expect(all.fulfillment.manual.enabled).toBe(true);
    expect(all.auth.localEnabled).toBe(true);
    expect(all.auth.oidc.enabled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not let callers mutate the cache', () => {
    service.get('general').appTitle = 'mutated';
    expect(service.get('general').appTitle).toBe('Hearer');
  });
});

describe('set/get', () => {
  it('round trips, fills omitted fields with defaults and survives a new instance', () => {
    const saved = service.set('general', { appTitle: 'My Music' });
    expect(saved.appTitle).toBe('My Music');
    expect(saved.defaultRequestQuota).toEqual({ limit: 0, days: 7 });
    expect(service.get('general').appTitle).toBe('My Music');
    expect(makeService().get('general').appTitle).toBe('My Music');
    expect(warn).not.toHaveBeenCalled();
  });

  it('replaces the previous value on repeated sets', () => {
    service.set('uploads', { maxFileSizeMb: 10 });
    service.set('uploads', { maxFileSizeMb: 20 });
    expect(service.get('uploads').maxFileSizeMb).toBe(20);
    expect(database.db.select().from(settings).all()).toHaveLength(1);
  });

  it('rejects invalid writes without touching the stored value', () => {
    service.set('uploads', { maxFileSizeMb: 10 });
    expect(() => service.set('uploads', { maxFileSizeMb: -5 })).toThrow(SettingsValidationError);
    expect(() => service.set('uploads', { autoApproveThreshold: 2 })).toThrow(
      /autoApproveThreshold/,
    );
    expect(() => service.set('general', { applicationUrl: 'not a url' })).toThrow(
      SettingsValidationError,
    );
    expect(() =>
      service.set('general', { defaultPermissions: Permission.ADMIN * 2 ** 20 }),
    ).toThrow(SettingsValidationError);
    expect(() => service.set('mediaServer', { type: 'plex' } as never)).toThrow(
      SettingsValidationError,
    );
    expect(service.get('uploads').maxFileSizeMb).toBe(10);
    expect(JSON.parse(rawRow('uploads')?.valueJson ?? '{}')).toMatchObject({ maxFileSizeMb: 10 });
  });

  it('accepts optional fields such as libraryIds', () => {
    service.set('mediaServer', { url: 'http://jf.local:8096', libraryIds: ['a', 'b'] });
    expect(service.get('mediaServer').libraryIds).toEqual(['a', 'b']);
  });
});

describe('corrupt stored values', () => {
  it('falls back to the default with a warning for invalid JSON', () => {
    database.sqlite
      .prepare("insert into settings (key, value_json) values ('general', '{nope')")
      .run();
    expect(service.get('general').appTitle).toBe('Hearer');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ key: 'general' });
  });

  it('falls back to the default with a warning for schema violations', () => {
    database.sqlite
      .prepare(
        `insert into settings (key, value_json) values ('uploads', '{"maxFileSizeMb":"huge"}')`,
      )
      .run();
    expect(service.get('uploads').maxFileSizeMb).toBe(2048);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('keeps working after corruption: a valid write replaces the bad row', () => {
    database.sqlite
      .prepare("insert into settings (key, value_json) values ('uploads', '[]')")
      .run();
    expect(service.get('uploads').coverMaxPx).toBe(1200);
    service.set('uploads', { coverMaxPx: 800 });
    expect(makeService().get('uploads').coverMaxPx).toBe(800);
  });

  it('blanks only the secret when it cannot be decrypted (e.g. the key changed)', () => {
    service.set('metadata', {
      acoustIdApiKey: 'abc123',
      cacheTtl: { entityDays: 5, searchDays: 2 },
    });
    const other = makeService(new SecretBox('a-different-secret-key'));
    const value = other.get('metadata');
    expect(value.acoustIdApiKey).toBe('');
    expect(value.cacheTtl).toEqual({ entityDays: 5, searchDays: 2 });
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('abc123');
  });

  it('reads a plaintext secret written by hand and encrypts it on the next write', () => {
    database.sqlite
      .prepare(
        `insert into settings (key, value_json) values ('metadata', '{"acoustIdApiKey":"hand"}')`,
      )
      .run();
    expect(service.get('metadata').acoustIdApiKey).toBe('hand');
    service.set('metadata', service.get('metadata'));
    expect(rawRow('metadata')?.valueJson).not.toContain('"hand"');
  });
});

describe('secrets', () => {
  const full = () => ({
    mediaServer: { url: 'http://jf:8096', apiKey: 'jf-key-123' },
    metadata: { acoustIdApiKey: 'acoust-456' },
    auth: { oidc: { enabled: true, clientSecret: 'oidc-secret-789' } },
    fulfillment: { lidarr: { enabled: true, apiKey: 'lidarr-key-000' } },
  });

  it('encrypts every secret field at rest and decrypts on get', () => {
    const v = full();
    service.set('mediaServer', v.mediaServer);
    service.set('metadata', v.metadata);
    service.set('auth', v.auth);
    service.set('fulfillment', v.fulfillment);

    for (const secret of ['jf-key-123', 'acoust-456', 'oidc-secret-789', 'lidarr-key-000']) {
      for (const row of database.db.select().from(settings).all()) {
        expect(row.valueJson).not.toContain(secret);
      }
    }
    expect(JSON.parse(rawRow('mediaServer')?.valueJson ?? '{}')).toMatchObject({
      url: 'http://jf:8096',
      apiKey: expect.stringMatching(/^enc:v1:/) as unknown,
    });
    // fresh instance (no cache) decrypts from the DB
    const fresh = makeService();
    expect(fresh.get('mediaServer').apiKey).toBe('jf-key-123');
    expect(fresh.get('metadata').acoustIdApiKey).toBe('acoust-456');
    expect(fresh.get('auth').oidc.clientSecret).toBe('oidc-secret-789');
    expect(fresh.get('fulfillment').lidarr.apiKey).toBe('lidarr-key-000');
  });

  it('does not encrypt empty secrets', () => {
    service.set('mediaServer', { url: 'http://jf' });
    expect(JSON.parse(rawRow('mediaServer')?.valueJson ?? '{}')).toMatchObject({ apiKey: '' });
  });

  it('getPublic redacts secrets and leaves everything else', () => {
    const v = full();
    service.set('mediaServer', v.mediaServer);
    service.set('auth', v.auth);
    const pub = service.getPublic();
    expect(pub.mediaServer.apiKey).toBe(REDACTED_SECRET);
    expect(pub.mediaServer.url).toBe('http://jf:8096');
    expect(pub.auth.oidc.clientSecret).toBe(REDACTED_SECRET);
    expect(pub.auth.oidc.enabled).toBe(true);
    expect(pub.metadata.acoustIdApiKey).toBe('');
    expect(pub.fulfillment.lidarr.apiKey).toBe('');
    expect(JSON.stringify(pub)).not.toMatch(/jf-key-123|oidc-secret-789/);
    // and the real values are intact
    expect(service.get('mediaServer').apiKey).toBe('jf-key-123');
  });

  it('keeps the stored secret when the redacted placeholder is written back', () => {
    service.set('mediaServer', { url: 'http://a', apiKey: 'real-key' });
    service.set('mediaServer', { ...service.getPublic().mediaServer, url: 'http://b' });
    const v = makeService().get('mediaServer');
    expect(v.url).toBe('http://b');
    expect(v.apiKey).toBe('real-key');
  });

  it('allows clearing a secret with an empty string', () => {
    service.set('mediaServer', { apiKey: 'real-key' });
    service.set('mediaServer', { apiKey: '' });
    expect(makeService().get('mediaServer').apiKey).toBe('');
  });
});
