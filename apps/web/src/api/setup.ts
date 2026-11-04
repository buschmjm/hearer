import {
  mediaServerTestResultSchema,
  sessionResponseSchema,
  setupStatusSchema,
  type MediaServerTestResult,
  type SetupAdminRequest,
  type SetupStatus,
} from '@hearer/shared';
import { queryOptions, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { adoptSession } from './auth.ts';
import { api } from './client.ts';

export const setupStatusKey = ['setup', 'status'] as const;
export type SetupSection = 'general' | 'library' | 'uploads' | 'mediaServer';

// The wizard talks to a loosely typed settings object per section; the shared zod schemas
// validate it in the forms, the server validates it again.
const sectionSchema = z.record(z.string(), z.unknown());
export type SectionValues = Record<string, unknown>;

export const setupStatusQuery = () =>
  queryOptions({
    queryKey: setupStatusKey,
    staleTime: 0,
    queryFn: ({ signal }): Promise<SetupStatus> =>
      api('/setup/status', {
        schema: setupStatusSchema,
        signal,
        redirectOn401: false,
        redirectOnSetup: false,
      }),
  });

/** Setup status for route guards. Once setup is complete it never changes, so cache it. */
export async function ensureSetupStatus(qc: QueryClient): Promise<SetupStatus> {
  const cached = qc.getQueryData<SetupStatus>(setupStatusKey);
  if (cached?.setupComplete) return cached;
  return qc.query(setupStatusQuery());
}

export const sectionQuery = (section: SetupSection) =>
  queryOptions({
    queryKey: ['setup', 'section', section] as const,
    staleTime: 0,
    queryFn: ({ signal }): Promise<SectionValues> =>
      api(`/setup/${section}`, { schema: sectionSchema, signal, redirectOn401: false }),
  });

export function useCreateAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: SetupAdminRequest) => {
      const session = await api('/setup/admin', {
        method: 'POST',
        body,
        schema: sessionResponseSchema,
        redirectOn401: false,
      });
      await adoptSession(qc, session);
      await qc.invalidateQueries({ queryKey: setupStatusKey });
      return session;
    },
  });
}

/**
 * Save a wizard section. The API replaces the whole section, so the stored values are fetched
 * and merged under the edited fields (anything the wizard does not show is preserved).
 */
export function useSaveSection(section: SetupSection) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: SectionValues) => {
      const current = await qc.query(sectionQuery(section));
      const saved = await api(`/setup/${section}`, {
        method: 'PUT',
        body: { ...current, ...values },
        schema: sectionSchema,
        redirectOn401: false,
      });
      qc.setQueryData(['setup', 'section', section], saved);
      return saved;
    },
  });
}

export function useTestMediaServer() {
  return useMutation({
    mutationFn: (body: { url: string; apiKey: string }): Promise<MediaServerTestResult> =>
      api('/settings/mediaServer/test', {
        method: 'POST',
        body,
        schema: mediaServerTestResultSchema,
        redirectOn401: false,
      }),
  });
}

export function useCompleteSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const status = await api('/setup/complete', {
        method: 'POST',
        schema: setupStatusSchema,
        redirectOn401: false,
      });
      qc.setQueryData(setupStatusKey, status);
      return status;
    },
  });
}
