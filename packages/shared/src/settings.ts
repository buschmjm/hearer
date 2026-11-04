import { z } from 'zod';
import { validateNamingTemplate } from './template.ts';
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
      /** Claim used as the Hearer username on first login (falls back to the email, then `sub`). */
      usernameClaim: z.string().trim().min(1).default('preferred_username'),
      emailClaim: z.string().trim().min(1).default('email'),
      /** Claim holding the user's groups (array or single string), e.g. `groups` in Keycloak. */
      groupsClaim: z.string().trim().default(''),
      /** Members of this group are granted ADMIN on login. Grant only: leaving the group does not revoke. */
      adminGroup: z.string().trim().default(''),
      /** When non-empty, only members of one of these groups may sign in. */
      allowedGroups: z.array(z.string().trim().min(1)).default([]),
      /**
       * Sign an OIDC login in as an existing local/Jellyfin account with the same email.
       * Off by default: matching on email is an account-takeover risk if the IdP lets users set
       * unverified emails or if the IdP is shared with untrusted tenants. Even when on, the IdP
       * must report `email_verified: true`, and administrator accounts are never linked unless
       * `linkAdminAccounts` is also on.
       */
      linkExistingByEmail: z.boolean().default(false),
      linkAdminAccounts: z.boolean().default(false),
      /**
       * Permit an `http://` issuer (discovery, token and JWKS requests in clear text). Only for an
       * IdP on a trusted private network; the default requires https.
       */
      allowInsecureHttp: z.boolean().default(false),
    })
    .refine((v) => v.groupsClaim !== '' || (v.adminGroup === '' && v.allowedGroups.length === 0), {
      message: 'groupsClaim is required when adminGroup or allowedGroups is set',
      path: ['groupsClaim'],
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
  /**
   * Translate paths between the media server's view and Hearer's (e.g. Jellyfin mounts the
   * music at `/data/music`, Hearer at `/music`). Longest matching `serverPath` prefix wins.
   */
  pathMappings: z
    .array(z.object({ serverPath: z.string().trim().min(1), localPath: z.string().trim().min(1) }))
    .default([]),
});

/** A path template; unknown variables and unsafe shapes are rejected when it is saved. */
const pathTemplate = (fallback: string) =>
  z
    .string()
    .min(1)
    .superRefine((value, ctx) => {
      for (const message of validateNamingTemplate(value))
        ctx.addIssue({ code: 'custom', message });
    })
    .default(fallback);

const library = z.object({
  namingTemplate: pathTemplate(DEFAULT_NAMING_TEMPLATE),
  singlesTemplate: pathTemplate(DEFAULT_SINGLES_TEMPLATE),
});

const uploads = z.object({
  maxFileSizeMb: z.number().int().min(1).default(2048),
  allowedFormats: z
    .array(z.string().min(1))
    .min(1)
    .default(['flac', 'mp3', 'm4a', 'ogg', 'opus', 'wav', 'aiff']),
  autoApproveThreshold: z.number().min(0).max(1).default(0.9),
  coverMaxPx: z.number().int().min(100).max(10000).default(1200),
  /**
   * Who may override a DUPLICATE verdict ("keep as alternate version"). Users with
   * MANAGE_UPLOADS always may. When true, an uploader with UPLOAD may also override their own
   * duplicates. Default false: only managers.
   */
  allowDuplicateOverride: z.boolean().default(false),
});

const metadata = z.object({
  musicBrainzBaseUrl: z.url().default('https://musicbrainz.org/ws/2'),
  coverArtBaseUrl: z.url().default('https://coverartarchive.org'),
  acoustIdApiKey: z.string().default(''),
  /** AcoustID web service base URL (a mirror, or a test double). */
  acoustIdBaseUrl: z.url().default('https://api.acoustid.org/v2'),
  /** How long MusicBrainz responses stay fresh in the cache. */
  cacheTtl: z
    .object({
      entityDays: z.number().int().min(1).max(365).default(7),
      searchDays: z.number().int().min(1).max(365).default(1),
    })
    .prefault({}),
});

/** Manual fulfillment settings (also the provider's config schema). */
export const manualSettingsSchema = z.object({ enabled: z.boolean().default(true) });

/** Lidarr fulfillment settings (also the provider's config schema, which drives the form). */
export const lidarrSettingsSchema = z.object({
  /** Off by default: an admin opts in once a Lidarr instance exists. */
  enabled: z.boolean().default(false),
  url: optionalUrl.default(''),
  apiKey: z.string().default(''),
  rootFolder: z.string().default(''),
  qualityProfileId: z.number().int().min(0).default(0),
  metadataProfileId: z.number().int().min(0).default(0),
  /** Track requests: 'album' requests the parent album, 'skip' hands them to Manual. */
  trackPolicy: z.enum(['album', 'skip']).default('album'),
});
export type LidarrSettings = z.output<typeof lidarrSettingsSchema>;

const fulfillment = z.object({
  manual: manualSettingsSchema.prefault({}),
  lidarr: lidarrSettingsSchema.prefault({}),
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
