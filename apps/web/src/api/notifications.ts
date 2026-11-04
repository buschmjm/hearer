import {
  notificationAgentsResponseSchema,
  notificationTargetDtoSchema,
  notificationTargetsResponseSchema,
  notificationTestResultSchema,
  userNotificationsResponseSchema,
  type NotificationAgentsResponse,
  type NotificationCandidateTest,
  type NotificationTargetDto,
  type NotificationTargetInput,
  type NotificationTestResult,
  type UserNotificationsResponse,
  type UserNotifyPrefs,
} from '@hearer/shared';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client.ts';

export const targetsKey = ['notifications', 'targets'] as const;
export const userNotificationsKey = ['notifications', 'me'] as const;

export const agentsQuery = () =>
  queryOptions({
    queryKey: ['notifications', 'agents'] as const,
    staleTime: 5 * 60_000,
    queryFn: ({ signal }): Promise<NotificationAgentsResponse> =>
      api('/notifications/agents', { schema: notificationAgentsResponseSchema, signal }),
  });

export const targetsQuery = () =>
  queryOptions({
    queryKey: targetsKey,
    staleTime: 0,
    queryFn: ({ signal }): Promise<NotificationTargetDto[]> =>
      api('/notifications/targets', { schema: notificationTargetsResponseSchema, signal }).then(
        (r) => r.targets,
      ),
  });

export function useSaveTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string | undefined; input: NotificationTargetInput }) =>
      api(id ? `/notifications/targets/${id}` : '/notifications/targets', {
        method: id ? 'PUT' : 'POST',
        body: input,
        schema: notificationTargetDtoSchema,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: targetsKey }),
  });
}

export function useDeleteTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/notifications/targets/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: targetsKey }),
  });
}

/** Test an unsaved config (`targetId` resolves masked secrets against a stored target). */
export function useTestCandidate() {
  return useMutation({
    mutationFn: (body: NotificationCandidateTest): Promise<NotificationTestResult> =>
      api('/notifications/test', {
        method: 'POST',
        body,
        schema: notificationTestResultSchema,
      }),
  });
}

export function useTestTarget() {
  return useMutation({
    mutationFn: (id: string): Promise<NotificationTestResult> =>
      api(`/notifications/targets/${id}/test`, {
        method: 'POST',
        schema: notificationTestResultSchema,
      }),
  });
}

// ---- the signed-in user's own preferences ----

export const userNotificationsQuery = () =>
  queryOptions({
    queryKey: userNotificationsKey,
    staleTime: 0,
    queryFn: ({ signal }): Promise<UserNotificationsResponse> =>
      api('/auth/me/notifications', { schema: userNotificationsResponseSchema, signal }),
  });

export function useSaveUserNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (prefs: UserNotifyPrefs): Promise<UserNotificationsResponse> =>
      api('/auth/me/notifications', {
        method: 'PUT',
        body: prefs,
        schema: userNotificationsResponseSchema,
      }),
    onSuccess: (data) => {
      qc.setQueryData(userNotificationsKey, data);
    },
  });
}
