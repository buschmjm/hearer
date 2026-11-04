import {
  batchApproveResponseSchema,
  requestListResponseSchema,
  uploadConfigSchema,
  uploadDetailSchema,
  uploadListResponseSchema,
  type ReviewBody,
  type UploadConfig,
  type UploadDetail,
  type UploadListResponse,
  type UploadStatus,
  type RequestListResponse,
} from '@hearer/shared';
import { queryOptions, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from './client.ts';

/** Statuses that still change on their own; the UI polls while an upload is in one. */
export const TRANSIENT_STATUSES: readonly UploadStatus[] = [
  'RECEIVING',
  'RECEIVED',
  'ANALYZING',
  'APPROVED',
  'IMPORTING',
];

export const isTransient = (status: UploadStatus): boolean => TRANSIENT_STATUSES.includes(status);

export const POLL_MS = 2000;

export const uploadKeys = {
  all: ['uploads'] as const,
  config: ['uploads', 'config'] as const,
  list: (params: UploadListParams) => ['uploads', 'list', params] as const,
  detail: (id: string) => ['uploads', 'detail', id] as const,
  targets: ['uploads', 'request-targets'] as const,
};

export interface UploadListParams {
  all: boolean;
  status?: UploadStatus | undefined;
  batchId?: string | undefined;
  limit: number;
  offset: number;
}

export const uploadConfigQuery = () =>
  queryOptions({
    queryKey: uploadKeys.config,
    staleTime: 0,
    queryFn: ({ signal }): Promise<UploadConfig> =>
      api('/uploads/config', { schema: uploadConfigSchema, signal }),
  });

export const uploadListQuery = (params: UploadListParams, poll = false) =>
  queryOptions({
    queryKey: uploadKeys.list(params),
    ...(poll ? { refetchInterval: POLL_MS * 2 } : {}),
    queryFn: ({ signal }): Promise<UploadListResponse> =>
      api('/uploads', {
        schema: uploadListResponseSchema,
        signal,
        query: {
          all: params.all ? 1 : undefined,
          status: params.status,
          batchId: params.batchId,
          limit: params.limit,
          offset: params.offset,
        },
      }),
  });

export const uploadDetailQuery = (id: string) =>
  queryOptions<UploadDetail>({
    queryKey: uploadKeys.detail(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status !== undefined && isTransient(status) ? POLL_MS : false;
    },
    queryFn: ({ signal }): Promise<UploadDetail> =>
      api<UploadDetail>(`/uploads/${id}`, { schema: uploadDetailSchema, signal }),
  });

/** Requests an upload may fulfil: yours, approved and still waiting for the music. */
export const requestTargetsQuery = () =>
  queryOptions({
    queryKey: uploadKeys.targets,
    staleTime: 15_000,
    retry: false,
    queryFn: ({ signal }): Promise<RequestListResponse> =>
      api('/requests', {
        schema: requestListResponseSchema,
        signal,
        redirectOn401: false,
        query: { status: 'AWAITING_UPLOAD,PROCESSING', limit: 100, sort: 'updatedAt' },
      }),
  });

function writeDetail(qc: QueryClient, detail: UploadDetail): void {
  qc.setQueryData(uploadKeys.detail(detail.id), detail);
  void qc.invalidateQueries({ queryKey: ['uploads', 'list'] });
}

/** One mutation per review action; each stores the fresh detail the server returns. */
export function useUploadAction<V = void>(run: (variables: V) => Promise<UploadDetail>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (detail) => {
      writeDetail(qc, detail);
    },
  });
}

const post = (path: string, body?: unknown): Promise<UploadDetail> =>
  api(path, {
    method: 'POST',
    schema: uploadDetailSchema,
    ...(body === undefined ? {} : { body }),
  });

export const uploadActions = {
  save: (id: string, body: ReviewBody): Promise<UploadDetail> =>
    api(`/uploads/${id}/review`, { method: 'PUT', body, schema: uploadDetailSchema }),
  approve: (id: string) => post(`/uploads/${id}/approve`),
  reject: (id: string, reason: string) => post(`/uploads/${id}/reject`, { reason }),
  reanalyze: (id: string) => post(`/uploads/${id}/reanalyze`),
  retryImport: (id: string) => post(`/uploads/${id}/retry-import`),
  keep: (id: string, reason?: string) =>
    post(`/uploads/${id}/keep`, reason ? { reason } : undefined),
  batchApprove: (batchId: string) =>
    api(`/uploads/batch/${batchId}/approve`, {
      method: 'POST',
      schema: batchApproveResponseSchema,
    }),
  cancel: (id: string) => api(`/uploads/${id}`, { method: 'DELETE', schema: z.unknown() }),
};
