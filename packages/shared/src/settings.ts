import { z } from 'zod';
import { DEFAULT_USER_PERMISSIONS, isValidPermissionMask } from './permissions.ts';

/** Default library path template (see PLAN, upload pipeline step 5). */
export const DEFAULT_NAMING_TEMPLATE =
  '{albumartist}/{album} ({year})/{disc:?}{track:02} - {title}.{ext}';
export const DEFAULT_SINGLES_TEMPLATE = '{albumartist}/Singles/{title}.{ext}';

/** Shown instead of a stored secret in public views; writing it back keeps the stored value. */
export const REDACTED_SECRET = '********';

const permissionsMask = z.number().int().refine(isValidPermissionMask, 'unknown permission bits');
const optionalUrl = z.union([z.literal(''), z.url()]);
const general = z.object({
  appTitle: z.string().trim().min(1).max(80).default('Hearer'),
  /** Public URL users reach the app on (used in links and OIDC redirects). */
  applicationUrl: optionalUrl.default(''),
  setupComplete: z.boolean().default(false),
  defaultPermissions: permissionsMask.default(DEFAULT_USER_PERMISSIONS),
  /** limit = requests allowed per `days`; 0 means unlimited. */
  defaultRequestQuota: z
    .object({ limit: z.number().int().min(0), days: z.number().int().min(1) })
    .prefault({ limit: 0, days: 7 }),
  /** mb = megabytes of uploads allowed per `days`; 0 means unlimited. */
  defaultUploadQuota: z
    .object({ mb: z.number().int().min(0), days: z.number().int().min(1) })
    .prefault({ mb: 0, days: 7 }),
});

const auth = z.object({
  localEnabled: z.boolean().default(true),
  jellyfinEnabled: z.boolean().default(false),
  oidc: z
    .object({
      enabled: z.boolean().default(false),
      issuerUrl: optionalUrl.default(''),
      clientId: z.string().default(''),
      clientSecret: z.string().default(''),
      scopes: z.string().default('openid profile email'),
      buttonLabel: z.string().max(60).default('Sign in with SSO'),
      autoCreateUsers: z.boolean().default(true),
      usernameClaim: z.string().default('preferred_username'),
      emailClaim: z.string().default('email'),
    })
    .prefault({}),
});

const mediaServer = z.object({
  type: z.literal('jellyfin').default('jellyfin'),
  /** Base URL Hearer uses to reach the server (may be an internal address). */
  url: optionalUrl.default(''),
  /** URL users' browsers can reach, for "Open in Jellyfin" links; empty means use `url`. */
  externalUrl: optionalUrl.default(''),
  apiKey: z.string().default(''),
  serverId: z.string().default(''),
  /** Restrict indexing to these server library ids; omitted means all music libraries. */
  libraryIds: z.array(z.string()).optional(),
});

const library = z.object({
  namingTemplate: z.string().min(1).default(DEFAULT_NAMING_TEMPLATE),
  singlesTemplate: z.string().min(1).default(DEFAULT_SINGLES_TEMPLATE),
});

const uploads = z.object({
  maxFileSizeMb: z.number().int().min(1).default(2048),
  allowedFormats: z
    .array(z.string().min(1))
    .min(1)
    .default(['flac', 'mp3', 'm4a', 'ogg', 'opus', 'wav', 'aiff']),
  autoApproveThreshold: z.number().min(0).max(1).default(0.9),
  coverMaxPx: z.number().int().min(100).max(10000).default(1200),
});

const metadata = z.object({
  musicBrainzBaseUrl: z.url().default('https://musicbrainz.org/ws/2'),
  coverArtBaseUrl: z.url().default('https://coverartarchive.org'),
  acoustIdApiKey: z.string().default(''),
  cacheTtlDays: z.number().int().min(1).max(365).default(30),
});

const fulfillment = z.object({
  manual: z.object({ enabled: z.boolean().default(true) }).prefault({}),
  lidarr: z
    .object({
      enabled: z.boolean().default(false),
      url: optionalUrl.default(''),
      apiKey: z.string().default(''),
      rootFolder: z.string().default(''),
      qualityProfileId: z.number().int().min(0).default(0),
      metadataProfileId: z.number().int().min(0).default(0),
      trackPolicy: z.enum(['album', 'skip']).default('album'),
    })
    .prefault({}),
});

interface SettingDef<S extends z.ZodType> {
  schema: S;
  /** Object paths inside the value that hold secrets (encrypted at rest, redacted publicly). */
  secrets: readonly (readonly string[])[];
}

function def<S extends z.ZodType>(
  schema: S,
  secrets: readonly (readonly string[])[] = [],
): SettingDef<S> {
  return { schema, secrets };
}

export const SETTINGS_CATALOG = {
  general: def(general),
  auth: def(auth, [['oidc', 'clientSecret']]),
  mediaServer: def(mediaServer, [['apiKey']]),
  library: def(library),
  uploads: def(uploads),
  metadata: def(metadata, [['acoustIdApiKey']]),
  fulfillment: def(fulfillment, [['lidarr', 'apiKey']]),
} as const;

export type SettingsKey = keyof typeof SETTINGS_CATALOG;
export type SettingsValue<K extends SettingsKey> = z.output<(typeof SETTINGS_CATALOG)[K]['schema']>;
export type SettingsInput<K extends SettingsKey> = z.input<(typeof SETTINGS_CATALOG)[K]['schema']>;

export const SETTINGS_KEYS = Object.keys(SETTINGS_CATALOG) as SettingsKey[];

export function isSettingsKey(value: string): value is SettingsKey {
  return Object.hasOwn(SETTINGS_CATALOG, value);
}

/** The default value of a setting (every field defaulted). */
export function settingsDefault<K extends SettingsKey>(key: K): SettingsValue<K> {
  return SETTINGS_CATALOG[key].schema.parse({}) as SettingsValue<K>;
}
