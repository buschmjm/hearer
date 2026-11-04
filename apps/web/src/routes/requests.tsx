import { Permission, REQUEST_STATUSES, REQUEST_TYPES } from '@hearer/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, ListMusic } from 'lucide-react';
import { useAuth } from '../api/auth.ts';
import { requestCountsQuery, requestListQuery } from '../api/requests.ts';
import { CatalogError, EmptyState, Skeletons } from '../components/CatalogState.tsx';
import { RequestTable } from '../components/RequestTable.tsx';
import { Button, PageHeader } from '../components/ui.tsx';
import { cx } from '../lib/cx.ts';
import { REQUEST_TYPE_LABELS, requestStatusLabel } from '../lib/format.ts';
import {
  REQUESTS_PAGE_SIZE,
  SORTS,
  resolveFilters,
  toListParams,
  toSearch,
  type RequestsSearch,
  type ResolvedFilters,
  type SortKey,
} from '../lib/requestFilters.ts';

const selectClass =
  'min-h-10 rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg hover:border-muted/60';

function Tabs({
  all,
  canViewAll,
  onChange,
}: {
  all: boolean;
  canViewAll: boolean;
  onChange: (all: boolean) => void;
}) {
  if (!canViewAll) return null;
  const tabs = [
    { all: false, label: 'My requests' },
    { all: true, label: 'All requests' },
  ];
  return (
    <div
      role="tablist"
      aria-label="Which requests"
      className="mb-5 flex gap-1 border-b border-line"
    >
      {tabs.map((tab) => (
        <button
          key={tab.label}
          type="button"
          role="tab"
          aria-selected={tab.all === all}
          onClick={() => {
            onChange(tab.all);
          }}
          className={cx(
            '-mb-px min-h-11 border-b-2 px-4 text-sm font-medium transition-colors',
            tab.all === all
              ? 'border-accent text-accent'
              : 'border-transparent text-muted hover:text-fg',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function CountChips({
  all,
  status,
  onSelect,
}: {
  all: boolean;
  status: ResolvedFilters['status'];
  onSelect: (status: ResolvedFilters['status']) => void;
}) {
  const counts = useQuery({ ...requestCountsQuery(all), placeholderData: keepPreviousData });
  if (!counts.data) return null;
  const { total, byStatus } = counts.data;
  const chip = (selected: boolean) =>
    cx(
      'inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
      selected
        ? 'border-accent bg-accent-soft text-accent'
        : 'border-line bg-surface text-muted hover:border-muted/60 hover:text-fg',
    );
  return (
    <div role="group" aria-label="Filter by status" className="mb-4 flex flex-wrap gap-2">
      <button
        type="button"
        aria-pressed={status === undefined}
        onClick={() => {
          onSelect(undefined);
        }}
        className={chip(status === undefined)}
      >
        All <span className="whitespace-nowrap tabular-nums">{total}</span>
      </button>
      {REQUEST_STATUSES.filter((s) => byStatus[s] > 0 || s === status).map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={status === s}
          onClick={() => {
            onSelect(s);
          }}
          className={chip(status === s)}
        >
          {requestStatusLabel(s)}{' '}
          <span className="whitespace-nowrap tabular-nums">{byStatus[s]}</span>
        </button>
      ))}
    </div>
  );
}

export function RequestsPage({ search }: { search: RequestsSearch }) {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const canViewAll = hasPermission(
    [Permission.VIEW_ALL_REQUESTS, Permission.MANAGE_REQUESTS],
    'or',
  );
  const filters = resolveFilters(search, canViewAll);

  const list = useQuery({
    ...requestListQuery(toListParams(filters)),
    placeholderData: keepPreviousData,
  });

  const go = (next: Partial<ResolvedFilters>, resetPage = true) => {
    void navigate({
      to: '/requests',
      search: toSearch({ ...filters, ...next, ...(resetPage ? { page: 1 } : {}) }),
      replace: true,
    });
  };

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / REQUESTS_PAGE_SIZE));
  const first = total === 0 ? 0 : (filters.page - 1) * REQUESTS_PAGE_SIZE + 1;
  const last = Math.min(total, filters.page * REQUESTS_PAGE_SIZE);
  const filtered = filters.status !== undefined || filters.type !== undefined;

  return (
    <>
      <PageHeader
        title="Requests"
        subtitle={
          filters.all ? 'Everyone’s requests.' : 'What you have asked for and where it stands.'
        }
      />
      <Tabs
        all={filters.all}
        canViewAll={canViewAll}
        onChange={(all) => {
          go({ all, status: undefined });
        }}
      />
      <CountChips
        all={filters.all}
        status={filters.status}
        onSelect={(status) => {
          go({ status });
        }}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted">
          Type
          <select
            value={filters.type ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              go({ type: REQUEST_TYPES.find((t) => t === value) });
            }}
            className={selectClass}
          >
            <option value="">All types</option>
            {REQUEST_TYPES.map((t) => (
              <option key={t} value={t}>
                {REQUEST_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          Sort
          <select
            value={filters.sort}
            onChange={(event) => {
              go({ sort: event.target.value as SortKey });
            }}
            className={selectClass}
          >
            {(Object.keys(SORTS) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {SORTS[key].label}
              </option>
            ))}
          </select>
        </label>
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              go({ status: undefined, type: undefined });
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      <section aria-label="Request list" aria-busy={list.isFetching}>
        {list.isPending ? (
          <Skeletons layout="row" count={5} />
        ) : list.isError ? (
          <CatalogError
            error={list.error}
            onRetry={() => {
              void list.refetch();
            }}
          />
        ) : list.data.items.length === 0 ? (
          <EmptyState
            title={filtered ? 'No requests match' : 'No requests yet'}
            icon={<ListMusic className="size-6" aria-hidden />}
          >
            {filtered
              ? 'Try clearing a filter.'
              : filters.all
                ? 'Nobody has requested anything yet.'
                : 'Search for music and request what is missing from the library.'}
          </EmptyState>
        ) : (
          <>
            <RequestTable requests={list.data.items} showRequester={filters.all} />
            <nav
              aria-label="Pagination"
              className="mt-4 flex items-center justify-between gap-3 text-sm text-muted"
            >
              <p aria-live="polite">
                Showing {first}&ndash;{last} of {total}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  disabled={filters.page <= 1}
                  aria-label="Previous page"
                  onClick={() => {
                    go({ page: filters.page - 1 }, false);
                  }}
                >
                  <ChevronLeft className="size-4" aria-hidden /> Previous
                </Button>
                <span className="whitespace-nowrap tabular-nums">
                  {filters.page} / {pages}
                </span>
                <Button
                  variant="secondary"
                  disabled={filters.page >= pages}
                  aria-label="Next page"
                  onClick={() => {
                    go({ page: filters.page + 1 }, false);
                  }}
                >
                  Next <ChevronRight className="size-4" aria-hidden />
                </Button>
              </div>
            </nav>
          </>
        )}
      </section>
    </>
  );
}
