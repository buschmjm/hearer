import { mediaServerTestResultSchema, type MediaServerTestResult } from '@hearer/shared';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { methodsKey } from './auth.ts';
import { api } from './client.ts';
import { setupStatusKey } from './setup.ts';

/** A settings section as the API serves it: a plain object, secrets masked. */
export type SettingsSection = Record<string, unknown>;
const sectionSchema = z.record(z.string(), z.unknown());

export type SettingsKey =
  'general' | 'auth' | 'mediaServer' | 'library' | 'uploads' | 'metadata' | 'fulfillment';

export const settingsKey = (key: SettingsKey) => ['settings', key] as const;

export const settingsQuery = (key: SettingsKey) =>
  queryOptions({
    queryKey: settingsKey(key),
    staleTime: 0,
    gcTime: 0,
    queryFn: ({ signal }): Promise<SettingsSection> =>
      api(`/settings/${key}`, { schema: sectionSchema, signal }),
  });

/** PUT replaces the whole section; callers send the full draft with masked secrets echoed back. */
export function useSaveSettings(key: SettingsKey) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsSection): Promise<SettingsSection> =>
      api(`/settings/${key}`, { method: 'PUT', body, schema: sectionSchema }),
    onSuccess: (saved) => {
      qc.setQueryData(settingsKey(key), saved);
      // The login page and the app title read these.
      void qc.invalidateQueries({ queryKey: methodsKey });
      void qc.invalidateQueries({ queryKey: setupStatusKey });
    },
  });
}

export function useTestMediaServerConfig() {
  return useMutation({
    mutationFn: (body: SettingsSection): Promise<MediaServerTestResult> =>
      api('/settings/mediaServer/test', {
        method: 'POST',
        body,
        schema: mediaServerTestResultSchema,
      }),
  });
}

// ---- library index ----

const syncStateSchema = z.object({
  lastIncrementalAt: z.number().nullable(),
  lastFullAt: z.number().nullable(),
  lastMode: z.enum(['incremental', 'full']).nullable(),
  lastCounts: z.object({ seen: z.number(), upserted: z.number(), removed: z.number() }).nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.number().nullable(),
});
const libraryStatusSchema = z.object({
  configured: z.boolean(),
  state: syncStateSchema,
  counts: z.object({ artist: z.number(), album: z.number(), track: z.number() }),
  total: z.number(),
});
export type LibraryStatus = z.infer<typeof libraryStatusSchema>;

export const libraryStatusQuery = () =>
  queryOptions({
    queryKey: ['library', 'status'] as const,
    staleTime: 0,
    queryFn: ({ signal }): Promise<LibraryStatus> =>
      api('/library/status', { schema: libraryStatusSchema, signal }),
  });

export function useLibrarySync() {
  return useMutation({
    mutationFn: (mode: 'incremental' | 'full') =>
      api('/library/sync', {
        method: 'POST',
        body: { mode },
        schema: z.object({ jobId: z.number(), mode: z.enum(['incremental', 'full']) }),
      }),
  });
}

// ---- OIDC ----

export const oidcRedirectQuery = () =>
  queryOptions({
    queryKey: ['settings', 'oidc', 'redirect-uri'] as const,
    staleTime: 0,
    queryFn: ({ signal }) =>
      api('/settings/auth/oidc/redirect-uri', {
        schema: z.object({ redirectUri: z.string() }),
        signal,
      }),
  });

const discoverySchema = z.object({
  ok: z.boolean(),
  redirectUri: z.string(),
  issuer: z.string().optional(),
  authorizationEndpoint: z.string().nullable().optional(),
  tokenEndpoint: z.string().nullable().optional(),
  jwksUri: z.string().nullable().optional(),
  userinfoEndpoint: z.string().nullable().optional(),
  pkceS256: z.boolean().nullable().optional(),
  idTokenAlgs: z.array(z.string()).optional(),
  error: z.string().optional(),
});
export type OidcDiscoveryResult = z.infer<typeof discoverySchema>;

export function useTestOidc() {
  return useMutation({
    mutationFn: (body: { issuerUrl: string; allowInsecureHttp: boolean }) =>
      api('/settings/auth/oidc/test', { method: 'POST', body, schema: discoverySchema }),
  });
}

// ---- fulfillment ----

const providerSchema = z.object({
  id: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  supports: z.object({ track: z.boolean(), album: z.boolean(), artist: z.boolean() }),
  settingsPath: z.string(),
  configSchema: z.record(z.string(), z.unknown()),
  config: z.record(z.string(), z.unknown()),
});
export type FulfillmentProvider = z.infer<typeof providerSchema>;

export const fulfillmentProvidersQuery = () =>
  queryOptions({
    queryKey: ['fulfillment', 'providers'] as const,
    staleTime: 0,
    gcTime: 0,
    queryFn: ({ signal }): Promise<FulfillmentProvider[]> =>
      api('/fulfillment/providers', {
        schema: z.object({ providers: z.array(providerSchema) }),
        signal,
      }).then((r) => r.providers),
  });

const lidarrTestSchema = z.object({
  ok: z.boolean(),
  version: z.string().optional(),
  message: z.string().optional(),
});

export function useTestLidarr() {
  return useMutation({
    mutationFn: (body: SettingsSection) =>
      api('/settings/fulfillment/lidarr/test', { method: 'POST', body, schema: lidarrTestSchema }),
  });
}

const lidarrOptionsSchema = z.object({
  qualityProfiles: z.array(z.object({ id: z.number(), name: z.string() })),
  metadataProfiles: z.array(z.object({ id: z.number(), name: z.string() })),
  rootFolders: z.array(z.object({ id: z.number(), path: z.string() })),
});
export type LidarrOptions = z.infer<typeof lidarrOptionsSchema>;

export const lidarrOptionsQuery = (enabled: boolean) =>
  queryOptions({
    queryKey: ['fulfillment', 'lidarr', 'options'] as const,
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: ({ signal }): Promise<LidarrOptions> =>
      api('/settings/fulfillment/lidarr/options', { schema: lidarrOptionsSchema, signal }),
  });
