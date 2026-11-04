import {
  REDACTED_SECRET,
  SETTINGS_CATALOG,
  isSettingsKey,
  mediaServerTestResultSchema,
  type MediaServerInfoDto,
  type MediaServerTestResult,
  type SettingsKey,
} from '@hearer/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Permission } from '../auth/permissions.ts';
import { requirePermission } from '../auth/guard.ts';
import { mediaServerHttpError } from '../auth/jellyfin.ts';
import { MediaServerError, MediaServerNotConfiguredError } from '../adapters/mediaserver/types.ts';
import type { MediaServerRegistry } from '../adapters/mediaserver/registry.ts';
import { HttpError, notFound } from '../lib/http-error.ts';
import { SettingsValidationError, type SettingsService } from '../services/settings.ts';

const settingsBody = z.record(z.string(), z.unknown());
const settingsView = z.record(z.string(), z.unknown());

/**
 * Validate and store one settings section (full replace: omitted fields fall back to their
 * defaults, and a secret sent as the masked placeholder keeps its stored value). Returns the
 * public view, secrets masked. Shared by `PUT /settings/:key` and the setup wizard.
 *
 * Two server-side safeguards that a client cannot override here:
 * - `general.setupComplete` only changes through `POST /setup/complete`.
 * - `auth` cannot turn off the last enabled sign-in method (which would lock everyone out).
 */
export function saveSettingsSection(
  settings: SettingsService,
  key: SettingsKey,
  body: Record<string, unknown>,
): Record<string, unknown> {
  let value: Record<string, unknown> = body;
  if (key === 'general') {
    value = { ...body, setupComplete: settings.get('general').setupComplete };
  }
  if (key === 'auth') {
    const parsed = SETTINGS_CATALOG.auth.schema.safeParse(body);
    if (
      parsed.success &&
      !parsed.data.localEnabled &&
      !parsed.data.jellyfinEnabled &&
      !parsed.data.oidc.enabled
    ) {
      throw new HttpError(400, 'would_lock_out', 'At least one sign-in method must stay enabled');
    }
  }
  try {
    settings.set(key, value);
  } catch (err) {
    if (err instanceof SettingsValidationError) {
      throw new HttpError(400, 'validation_error', err.message, err.issues);
    }
    throw err;
  }
  return settings.getPublic()[key];
}

/** Parse a candidate `mediaServer` config; a validation failure is a 400. */
export function parseMediaServerCandidate(
  body: Record<string, unknown>,
): ReturnType<typeof SETTINGS_CATALOG.mediaServer.schema.parse> {
  const parsed = SETTINGS_CATALOG.mediaServer.schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(
      400,
      'validation_error',
      'Invalid media server settings',
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/**
 * Try a candidate media server config without saving it. A masked API key means "use the stored
 * one". Returns the server info, or throws the adapter's error (MediaServerError family).
 */
export async function testMediaServer(
  registry: MediaServerRegistry,
  body: Record<string, unknown>,
): Promise<MediaServerInfoDto> {
  const candidate = parseMediaServerCandidate(body);
  if (candidate.apiKey === REDACTED_SECRET && !registry.isConfigured()) {
    throw new MediaServerNotConfiguredError('No API key is stored yet; enter one');
  }
  return registry.forCandidate(candidate).testConnection();
}

/** The `{ok:false, error}` result for a failed test (codes match the API error envelope). */
export function failedTestResult(err: MediaServerError): MediaServerTestResult {
  const { code, message } = mediaServerHttpError(err);
  return { ok: false, error: { code, message } };
}

export function parseSettingsKey(raw: string): SettingsKey {
  if (!isSettingsKey(raw)) throw notFound(`Unknown settings section "${raw}"`);
  return raw;
}

/** Routes under /api/v1/settings (MANAGE_SETTINGS). Secrets are always masked. */
export const settingsRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  const { settings, mediaServer } = app.hearer;
  const guard = [requirePermission(Permission.MANAGE_SETTINGS)];

  // Registered before /settings/:key so the static path wins (find-my-way prefers it anyway).
  app.post(
    '/settings/mediaServer/test',
    {
      onRequest: guard,
      schema: {
        tags: ['settings'],
        summary: 'Test a media server config without saving it',
        description:
          'Always answers 200; `ok` tells whether the server answered. A masked API key means the stored key.',
        body: settingsBody,
        response: { 200: mediaServerTestResultSchema },
      },
    },
    async (request) => {
      try {
        return { ok: true, server: await testMediaServer(mediaServer, request.body) };
      } catch (err) {
        if (err instanceof MediaServerError) return failedTestResult(err);
        throw err;
      }
    },
  );

  app.get(
    '/settings',
    {
      onRequest: guard,
      schema: {
        tags: ['settings'],
        summary: 'All settings, secrets masked',
        response: { 200: settingsView },
      },
    },
    () => settings.getPublic() as Record<string, unknown>,
  );

  app.get(
    '/settings/:key',
    {
      onRequest: guard,
      schema: {
        tags: ['settings'],
        summary: 'One settings section, secrets masked',
        params: z.object({ key: z.string().min(1).max(64) }),
        response: { 200: settingsView },
      },
    },
    (request) =>
      settings.getPublic()[parseSettingsKey(request.params.key)] as Record<string, unknown>,
  );

  app.put(
    '/settings/:key',
    {
      onRequest: guard,
      schema: {
        tags: ['settings'],
        summary: 'Replace one settings section',
        description:
          'Validated against the section schema. Omitted fields reset to their defaults; a secret sent as the masked placeholder keeps its stored value.',
        params: z.object({ key: z.string().min(1).max(64) }),
        body: settingsBody,
        response: { 200: settingsView },
      },
    },
    (request) => saveSettingsSection(settings, parseSettingsKey(request.params.key), request.body),
  );
  done();
};
