import {
  jellyfinImportCandidateSchema,
  jellyfinImportResultSchema,
  userDtoSchema,
  userListResponseSchema,
  type CreateUserRequest,
  type JellyfinImportResult,
  type UpdateUserRequest,
  type UserListResponse,
} from '@hearer/shared';
import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from './client.ts';

export const usersKey = ['users'] as const;
export const USERS_PAGE_SIZE = 20;

export const usersQuery = (page: number, q: string) =>
  queryOptions({
    queryKey: [...usersKey, 'list', page, q] as const,
    staleTime: 0,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }): Promise<UserListResponse> =>
      api('/users', {
        query: { page, pageSize: USERS_PAGE_SIZE, ...(q ? { q } : {}) },
        schema: userListResponseSchema,
        signal,
      }),
  });

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateUserRequest) =>
      api('/users', { method: 'POST', body, schema: userDtoSchema }),
    onSuccess: () => qc.invalidateQueries({ queryKey: usersKey }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateUserRequest }) =>
      api(`/users/${id}`, { method: 'PATCH', body, schema: userDtoSchema }),
    onSuccess: () => qc.invalidateQueries({ queryKey: usersKey }),
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: usersKey }),
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: ({ id, newPassword }: { id: string; newPassword: string }) =>
      api(`/users/${id}/password`, { method: 'POST', body: { newPassword } }),
  });
}

export const jellyfinCandidatesQuery = () =>
  queryOptions({
    queryKey: [...usersKey, 'jellyfin'] as const,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }) =>
      api('/users/import/jellyfin', {
        schema: z.object({ items: z.array(jellyfinImportCandidateSchema) }),
        signal,
      }).then((r) => r.items),
  });

export function useImportJellyfin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]): Promise<JellyfinImportResult> =>
      api('/users/import/jellyfin', {
        method: 'POST',
        body: { ids },
        schema: jellyfinImportResultSchema,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: usersKey }),
  });
}
