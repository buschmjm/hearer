import { JOB_STATUSES, Permission, type JobDto, type JobStatus } from '@hearer/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../api/client.ts';
import {
  JOBS_PAGE_SIZE,
  jobListQuery,
  jobSummaryQuery,
  useDeleteJob,
  useRetryJob,
} from '../api/jobs.ts';
import { PageFrame, RequirePermission } from '../components/admin/PageFrame.tsx';
import { Badge, Pagination, SelectField } from '../components/controls.tsx';
import { Alert, Button, Card, Spinner } from '../components/ui.tsx';
import { toast } from '../lib/toast.ts';

const TONE = {
  queued: 'neutral',
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
  dead: 'danger',
} as const;

const when = (iso: string): string => new Date(iso).toLocaleString();

function Summary() {
  const summary = useQuery(jobSummaryQuery());
  if (summary.isPending) return <Spinner />;
  if (summary.isError) return <Alert>{errorMessage(summary.error)}</Alert>;
  const { totals, schedules } = summary.data;
  return (
    <div className="mb-6 space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {JOB_STATUSES.map((status) => (
          <Card key={status} className="px-4 py-3">
            <p className="text-2xl font-semibold" data-testid={`total-${status}`}>
              {totals[status] ?? 0}
            </p>
            <p className="text-xs text-muted capitalize">{status}</p>
          </Card>
        ))}
      </div>
      {schedules.length > 0 && (
        <details className="rounded-2xl border border-line bg-surface px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Recurring jobs ({schedules.length})
          </summary>
          <ul className="mt-3 divide-y divide-line">
            {schedules.map((s) => (
              <li key={s.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-mono text-xs">{s.type}</span>
                <span className="text-xs text-muted">
                  {s.nextRunAt ? `Next run ${when(s.nextRunAt)}` : 'Waiting for the worker'}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function JobRow({ job }: { job: JobDto }) {
  const [open, setOpen] = useState(false);
  const retry = useRetryJob();
  const remove = useDeleteJob();
  const canRetry = job.status === 'dead' || job.status === 'failed';
  const canDelete = job.status === 'dead' || job.status === 'queued';
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="px-4 py-3">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 md:grid-cols-[1.75rem_minmax(0,2fr)_6.5rem_5.5rem_minmax(0,1.4fr)_4.5rem]">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} details for job ${String(job.id)}`}
          className="rounded p-1 text-muted hover:text-fg"
          onClick={() => {
            setOpen(!open);
          }}
        >
          <Chevron className="size-4" aria-hidden />
        </button>
        <div className="min-w-0">
          <p className="truncate font-mono text-xs font-medium">{job.type}</p>
          <p className="text-xs text-muted">#{job.id}</p>
        </div>
        <span className="justify-self-start">
          <Badge tone={TONE[job.status]}>{job.status}</Badge>
        </span>
        <span className="hidden text-xs text-muted md:block">
          {job.attempts}/{job.maxAttempts} tries
        </span>
        <span className="hidden text-xs text-muted md:block">Runs {when(job.runAfter)}</span>
        <div className="col-start-3 row-start-1 flex justify-end gap-1 md:col-start-6">
          {canRetry && (
            <Button
              variant="ghost"
              className="px-2.5"
              aria-label={`Retry job ${String(job.id)}`}
              loading={retry.isPending}
              onClick={() => {
                retry.mutate(job.id, {
                  onSuccess: () => {
                    toast.success(`Job ${String(job.id)} queued again.`);
                  },
                  onError: (err) => {
                    toast.error(errorMessage(err));
                  },
                });
              }}
            >
              {!retry.isPending && <RotateCcw className="size-4" aria-hidden />}
            </Button>
          )}
          {canDelete && (
            <Button
              variant="ghost"
              className="px-2.5 hover:text-danger"
              aria-label={`Delete job ${String(job.id)}`}
              loading={remove.isPending}
              onClick={() => {
                remove.mutate(job.id, {
                  onSuccess: () => {
                    toast.success(`Job ${String(job.id)} deleted.`);
                  },
                  onError: (err) => {
                    toast.error(errorMessage(err));
                  },
                });
              }}
            >
              {!remove.isPending && <Trash2 className="size-4" aria-hidden />}
            </Button>
          )}
        </div>
      </div>
      <p className="mt-1 pl-9 text-xs text-muted md:hidden">
        {job.attempts}/{job.maxAttempts} tries · runs {when(job.runAfter)}
      </p>
      {open && (
        <div className="mt-3 space-y-3 pl-9">
          {job.lastError ? (
            <div>
              <p className="mb-1 text-xs font-semibold text-muted">Last error</p>
              <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-xs break-words whitespace-pre-wrap">
                {job.lastError}
              </pre>
            </div>
          ) : (
            <p className="text-xs text-muted">No error recorded.</p>
          )}
          <div>
            <p className="mb-1 text-xs font-semibold text-muted">Payload</p>
            <pre className="max-h-48 overflow-auto rounded-lg bg-surface-2 p-3 text-xs break-words whitespace-pre-wrap">
              {JSON.stringify(job.payload, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </li>
  );
}

function JobsContent() {
  const [status, setStatus] = useState<JobStatus | ''>('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const summary = useQuery(jobSummaryQuery());
  const list = useQuery(
    jobListQuery({ status: status || undefined, type: type || undefined, page }),
  );
  const types = [...new Set(summary.data?.counts.map((c) => c.type) ?? [])].sort();

  return (
    <PageFrame title="Jobs" subtitle="Background work. This page refreshes every few seconds.">
      <Summary />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:max-w-md">
        <SelectField
          label="Status"
          value={status}
          placeholder="All"
          options={JOB_STATUSES.map((s) => ({ value: s, label: s }))}
          onChange={(e) => {
            setStatus(e.target.value as JobStatus | '');
            setPage(1);
          }}
        />
        <SelectField
          label="Type"
          value={type}
          placeholder="All"
          options={types.map((t) => ({ value: t, label: t }))}
          onChange={(e) => {
            setType(e.target.value);
            setPage(1);
          }}
        />
      </div>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert>{errorMessage(list.error)}</Alert>
      ) : list.data.items.length === 0 ? (
        <Card className="px-6 py-12 text-center text-sm text-muted">No jobs match.</Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {list.data.items.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </ul>
        </Card>
      )}
      {list.data && (
        <Pagination
          page={page}
          pageSize={JOBS_PAGE_SIZE}
          total={list.data.total}
          onPage={setPage}
        />
      )}
    </PageFrame>
  );
}

export function JobsPage() {
  return (
    <RequirePermission anyOf={[Permission.MANAGE_SETTINGS]}>
      <JobsContent />
    </RequirePermission>
  );
}
