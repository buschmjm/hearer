import {
  jobDtoSchema,
  jobListResponseSchema,
  jobSummarySchema,
  type JobDto,
  type JobListResponse,
  type JobStatus,
  type JobSummary,
} from '@hearer/shared';
import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client.ts';

export const jobsKey = ['jobs'] as const;
export const JOBS_PAGE_SIZE = 25;
/** Jobs and counts refresh this often while the page is visible. */
export const JOBS_REFRESH_MS = 5000;

export const jobSummaryQuery = () =>
  queryOptions({
    queryKey: [...jobsKey, 'summary'] as const,
    staleTime: 0,
    refetchInterval: JOBS_REFRESH_MS,
    queryFn: ({ signal }): Promise<JobSummary> =>
      api('/jobs/summary', { schema: jobSummarySchema, signal }),
  });

export interface JobFilters {
  status?: JobStatus | undefined;
  type?: string | undefined;
  page: number;
}

export const jobListQuery = (filters: JobFilters) =>
  queryOptions({
    queryKey: [...jobsKey, 'list', filters] as const,
    staleTime: 0,
    refetchInterval: JOBS_REFRESH_MS,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }): Promise<JobListResponse> =>
      api('/jobs', {
        query: {
          page: filters.page,
          pageSize: JOBS_PAGE_SIZE,
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.type ? { type: filters.type } : {}),
        },
        schema: jobListResponseSchema,
        signal,
      }),
  });

export const jobQuery = (id: number, enabled = true) =>
  queryOptions({
    queryKey: [...jobsKey, 'one', id] as const,
    enabled,
    staleTime: 0,
    queryFn: ({ signal }): Promise<JobDto> => api(`/jobs/${id}`, { schema: jobDtoSchema, signal }),
  });

export function useRetryJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api(`/jobs/${id}/retry`, { method: 'POST', schema: jobDtoSchema }),
    onSuccess: () => qc.invalidateQueries({ queryKey: jobsKey }),
  });
}

export function useDeleteJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api(`/jobs/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: jobsKey }),
  });
}
