import {
  declineRequestBodySchema,
  requestCountsSchema,
  requestDetailDtoSchema,
  requestDtoSchema,
  requestListResponseSchema,
  requestQuotaSchema,
  type CreateRequestBody,
  type RequestDto,
  type RequestListQuery,
  type RequestStatus,
  type RequestType,
} from '@hearer/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.ts';
import { catalogKeys } from './catalog.ts';

export const requestKeys = {
  all: ['requests'] as const,
  list: (params: ListParams) => ['requests', 'list', params] as const,
  counts: (all: boolean) => ['requests', 'counts', all] as const,
  quota: ['requests', 'quota'] as const,
  detail: (id: string) => ['requests', 'detail', id] as const,
};

export interface ListParams {
  all: boolean;
  status?: RequestStatus | undefined;
  type?: RequestType | undefined;
  sort: RequestListQuery['sort'];
  order: RequestListQuery['order'];
  offset: number;
  limit: number;
}

export const requestListQuery = (params: ListParams) =>
  queryOptions({
    queryKey: requestKeys.list(params),
    staleTime: 15_000,
    queryFn: ({ signal }) =>
      api('/requests', {
        query: {
          all: params.all ? 1 : 0,
          status: params.status,
          type: params.type,
          sort: params.sort,
          order: params.order,
          offset: params.offset,
          limit: params.limit,
        },
        schema: requestListResponseSchema,
        signal,
      }),
  });

export const requestCountsQuery = (all: boolean) =>
  queryOptions({
    queryKey: requestKeys.counts(all),
    staleTime: 15_000,
    queryFn: ({ signal }) =>
      api('/requests/counts', {
        query: { all: all ? 1 : 0 },
        schema: requestCountsSchema,
        signal,
      }),
  });

export const requestQuotaQuery = () =>
  queryOptions({
    queryKey: requestKeys.quota,
    staleTime: 30_000,
    retry: false,
    queryFn: ({ signal }) => api('/requests/quota', { schema: requestQuotaSchema, signal }),
  });

export const requestDetailQuery = (id: string) =>
  queryOptions({
    queryKey: requestKeys.detail(id),
    staleTime: 10_000,
    queryFn: ({ signal }) =>
      api(`/requests/${encodeURIComponent(id)}`, { schema: requestDetailDtoSchema, signal }),
  });

export function useRequestQuota(enabled = true) {
  return useQuery({ ...requestQuotaQuery(), enabled });
}

/** After any request change: refresh queues, counts, quota and every catalog badge. */
function useRefreshRequests() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: requestKeys.all }),
      qc.invalidateQueries({ queryKey: catalogKeys.all }),
    ]);
}

export function useCreateRequest() {
  const refresh = useRefreshRequests();
  return useMutation({
    mutationFn: (body: CreateRequestBody) =>
      api('/requests', { method: 'POST', body, schema: requestDtoSchema }),
    onSettled: () => refresh(),
  });
}

export type RequestAction = 'approve' | 'retry' | 'cancel' | 'decline';

export function useRequestAction(action: RequestAction) {
  const refresh = useRefreshRequests();
  return useMutation<RequestDto, Error, { id: string; reason?: string }>({
    mutationFn: ({ id, reason }) =>
      api(`/requests/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        ...(action === 'decline' ? { body: declineRequestBodySchema.parse({ reason }) } : {}),
        schema: requestDtoSchema,
      }),
    onSettled: () => refresh(),
  });
}
