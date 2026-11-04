import {
  REQUEST_STATUSES,
  REQUEST_TYPES,
  type RequestStatus,
  type RequestType,
} from '@hearer/shared';
import { z } from 'zod';
import type { ListParams } from '../api/requests.ts';

export const REQUESTS_PAGE_SIZE = 20;

export const SORTS = {
  newest: { label: 'Newest first', sort: 'createdAt', order: 'desc' },
  oldest: { label: 'Oldest first', sort: 'createdAt', order: 'asc' },
  updated: { label: 'Recently updated', sort: 'updatedAt', order: 'desc' },
} as const;
export type SortKey = keyof typeof SORTS;

/** The /requests URL: tab, filters, sort and page. Anything invalid falls back to its default. */
export const requestsSearchSchema = z.object({
  tab: z.enum(['mine', 'all']).optional().catch(undefined),
  status: z.enum(REQUEST_STATUSES).optional().catch(undefined),
  type: z.enum(REQUEST_TYPES).optional().catch(undefined),
  sort: z.enum(['newest', 'oldest', 'updated']).optional().catch(undefined),
  page: z.number().int().min(1).max(10_000).optional().catch(undefined),
});
export type RequestsSearch = z.infer<typeof requestsSearchSchema>;

export interface ResolvedFilters {
  all: boolean;
  status: RequestStatus | undefined;
  type: RequestType | undefined;
  sort: SortKey;
  page: number;
}

export function resolveFilters(search: RequestsSearch, canViewAll: boolean): ResolvedFilters {
  return {
    all: search.tab === 'all' && canViewAll,
    status: search.status,
    type: search.type,
    sort: search.sort ?? 'newest',
    page: search.page ?? 1,
  };
}

export function toListParams(filters: ResolvedFilters): ListParams {
  const { sort, order } = SORTS[filters.sort];
  return {
    all: filters.all,
    status: filters.status,
    type: filters.type,
    sort,
    order,
    offset: (filters.page - 1) * REQUESTS_PAGE_SIZE,
    limit: REQUESTS_PAGE_SIZE,
  };
}

/** Search params for navigation: defaults are omitted so URLs stay short. */
export function toSearch(filters: ResolvedFilters): RequestsSearch {
  return {
    ...(filters.all ? { tab: 'all' as const } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.sort === 'newest' ? {} : { sort: filters.sort }),
    ...(filters.page > 1 ? { page: filters.page } : {}),
  };
}
