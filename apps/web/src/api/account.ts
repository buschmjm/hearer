import {
  apiKeyDtoSchema,
  createApiKeyResponseSchema,
  meResponseSchema,
  type ChangePasswordRequest,
  type CreateApiKeyResponse,
  type UpdateProfileRequest,
} from '@hearer/shared';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { meKey } from './auth.ts';
import { api } from './client.ts';

export const apiKeysKey = ['account', 'api-keys'] as const;

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProfileRequest) =>
      api('/auth/me', { method: 'PATCH', body, schema: meResponseSchema }),
    onSuccess: (me) => {
      qc.setQueryData(meKey, me);
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: ChangePasswordRequest) =>
      api('/auth/password', { method: 'POST', body, redirectOn401: false }),
  });
}

export const apiKeysQuery = () =>
  queryOptions({
    queryKey: apiKeysKey,
    staleTime: 0,
    queryFn: ({ signal }) =>
      api('/auth/api-keys', { schema: z.object({ items: z.array(apiKeyDtoSchema) }), signal }).then(
        (r) => r.items,
      ),
  });

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string): Promise<CreateApiKeyResponse> =>
      api('/auth/api-keys', { method: 'POST', body: { name }, schema: createApiKeyResponseSchema }),
    onSuccess: () => qc.invalidateQueries({ queryKey: apiKeysKey }),
  });
}

export function useDeleteApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/auth/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: apiKeysKey }),
  });
}
