import {
  Permission,
  REDACTED_SECRET,
  SETTINGS_CATALOG,
  lidarrSettingsSchema,
} from '@hearer/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { LIDARR_PROVIDER_ID } from '../adapters/fulfillment/lidarr.ts';
import {
  ProviderPermanentError,
  ProviderTemporaryError,
  configJsonSchema,
} from '../adapters/fulfillment/types.ts';
import { requirePermission } from '../auth/guard.ts';
import { HttpError } from '../lib/http-error.ts';

const providerSchema = z.object({
  id: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  supports: z.object({ track: z.boolean(), album: z.boolean(), artist: z.boolean() }),
  /** Where the provider's settings live, for `PUT /settings/fulfillment`. */
  settingsPath: z.string(),
  /** JSON Schema of the provider's config; secret fields carry `x-secret: true`. */
  configSchema: z.record(z.string(), z.unknown()),
  /** The current config with secrets masked. */
  config: z.record(z.string(), z.unknown()),
});

const testResultSchema = z.object({
  ok: z.boolean(),
  version: z.string().optional(),
  message: z.string().optional(),
});

const optionsSchema = z.object({
  qualityProfiles: z.array(z.object({ id: z.number().int(), name: z.string() })),
  metadataProfiles: z.array(z.object({ id: z.number().int(), name: z.string() })),
  rootFolders: z.array(
    z.object({
      id: z.number().int(),
      path: z.string(),
      name: z.string().nullable(),
      freeSpace: z.number().nullable(),
    }),
  ),
});

/** Flag the secret properties of a provider's settings block in its JSON Schema. */
function markSecrets(
  schema: Record<string, unknown>,
  settingsPath: string,
): Record<string, unknown> {
  const [, block] = settingsPath.split('.');
  const secrets = SETTINGS_CATALOG.fulfillment.secrets
    .filter((path) => path[0] === block && path.length === 2)
    .map((path) => path[1]);
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null) return schema;
  const marked = { ...(properties as Record<string, Record<string, unknown>>) };
  for (const name of secrets) {
    if (name !== undefined && marked[name]) marked[name] = { ...marked[name], 'x-secret': true };
  }
  return { ...schema, properties: marked };
}

/** Provider errors are shown to the admin as API errors. */
function providerHttpError(err: unknown): unknown {
  if (err instanceof ProviderPermanentError) {
    return new HttpError(400, 'provider_rejected', err.message);
  }
  if (err instanceof ProviderTemporaryError) {
    return new HttpError(502, 'provider_unavailable', err.message);
  }
  return err;
}

/** Fulfillment provider administration (MANAGE_SETTINGS). */
export const fulfillmentRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  const { fulfillment, settings } = app.hearer;
  const guard = [requirePermission(Permission.MANAGE_SETTINGS)];

  app.get(
    '/fulfillment/providers',
    {
      onRequest: guard,
      schema: {
        tags: ['fulfillment'],
        summary: 'Fulfillment providers with their config schema',
        response: { 200: z.object({ providers: z.array(providerSchema) }) },
      },
    },
    () => ({
      providers: fulfillment.list().map(({ provider, enabled, settingsPath }) => ({
        id: provider.id,
        label: provider.label,
        enabled,
        supports: provider.supports,
        settingsPath,
        configSchema: markSecrets(
          configJsonSchema(provider) as Record<string, unknown>,
          settingsPath,
        ),
        config: provider.describeConfig?.() ?? {},
      })),
    }),
  );

  /** A candidate Lidarr config (the form's values); a masked API key means the stored one. */
  const candidate = (body: Record<string, unknown>) => {
    const parsed = lidarrSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, 'validation_error', 'Invalid Lidarr settings', parsed.error.issues);
    }
    const apiKey =
      parsed.data.apiKey === REDACTED_SECRET
        ? settings.get('fulfillment').lidarr.apiKey
        : parsed.data.apiKey;
    return fulfillment.lidarr({ ...parsed.data, apiKey });
  };

  app.post(
    `/settings/fulfillment/${LIDARR_PROVIDER_ID}/test`,
    {
      onRequest: guard,
      schema: {
        tags: ['fulfillment'],
        summary: 'Test a Lidarr config without saving it',
        description:
          'Always answers 200; `ok` tells whether Lidarr answered (`GET system/status`). A masked API key means the stored key.',
        body: z.record(z.string(), z.unknown()),
        response: { 200: testResultSchema },
      },
    },
    async (request) => {
      const result = await candidate(request.body).testConnection();
      return {
        ok: result.ok,
        ...(result.version ? { version: result.version } : {}),
        ...(result.message ? { message: result.message } : {}),
      };
    },
  );

  app.get(
    `/settings/fulfillment/${LIDARR_PROVIDER_ID}/options`,
    {
      onRequest: guard,
      schema: {
        tags: ['fulfillment'],
        summary: 'Quality profiles, metadata profiles and root folders of the stored Lidarr',
        description:
          'Save the Lidarr URL and API key first. 400 `provider_rejected` for a missing or rejected key, 502 `provider_unavailable` when Lidarr cannot be reached.',
        response: { 200: optionsSchema },
      },
    },
    async () => {
      try {
        return await fulfillment.lidarr(settings.get('fulfillment').lidarr).options();
      } catch (err) {
        throw providerHttpError(err);
      }
    },
  );

  done();
};
