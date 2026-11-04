import { Permission, UPLOAD_STATUSES, type UploadDto, type UploadStatus } from '@hearer/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Disc3 } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../api/auth.ts';
import { uploadListQuery } from '../api/uploads.ts';
import { StatusBadge } from '../components/upload/StatusBadge.tsx';
import { Alert, Button, Card, PageHeader, Spinner } from '../components/ui.tsx';
import { cx } from '../lib/cx.ts';
import { formatBytes } from '../lib/uploadFiles.ts';
import { groupByBatch, statusLabel } from '../lib/uploadStatus.ts';

const PAGE_SIZE = 25;

const when = (iso: string): string => new Date(iso).toLocaleString();

function UploadLine({ upload, showUploader }: { upload: UploadDto; showUploader: boolean }) {
  return (
    <li>
      <Link
        to="/uploads/$id"
        params={{ id: upload.id }}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2"
      >
        <span className="min-w-0 flex-1 basis-48">
          <span className="block truncate text-sm font-medium">{upload.originalName}</span>
          <span className="block truncate text-xs text-muted">
            {formatBytes(upload.size)}
            {showUploader && upload.uploaderName ? ` · ${upload.uploaderName}` : ''}
            {` · ${when(upload.createdAt)}`}
          </span>
        </span>
        <StatusBadge status={upload.status} />
      </Link>
    </li>
  );
}

export function UploadsPage() {
  const { hasPermission, isLoading } = useAuth();
  const canAll = hasPermission(Permission.MANAGE_UPLOADS);
  const canMine = hasPermission(Permission.UPLOAD);
  const [tab, setTab] = useState<'mine' | 'all' | null>(null);
  const [status, setStatus] = useState<UploadStatus | ''>('');
  const [offset, setOffset] = useState(0);
  const view = tab ?? (canMine ? 'mine' : 'all');
  const params = {
    all: view === 'all',
    status: status === '' ? undefined : status,
    limit: PAGE_SIZE,
    offset,
  };
  const list = useQuery({ ...uploadListQuery(params, true), enabled: !isLoading });
  const total = list.data?.total ?? 0;
  const groups = groupByBatch(list.data?.items ?? []);

  return (
    <>
      <PageHeader
        title="Uploads"
        subtitle="Track what you uploaded and review what needs a decision."
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {canAll && canMine && (
          <div
            role="tablist"
            aria-label="Whose uploads"
            className="flex rounded-lg bg-surface-2 p-1"
          >
            {(['mine', 'all'] as const).map((id) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={view === id}
                onClick={() => {
                  setTab(id);
                  setOffset(0);
                }}
                className={cx(
                  'min-h-9 rounded-md px-4 text-sm font-medium',
                  view === id ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
                )}
              >
                {id === 'mine' ? 'Mine' : 'All'}
              </button>
            ))}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Status</span>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as UploadStatus | '');
              setOffset(0);
            }}
            className="min-h-10 rounded-lg border border-line bg-surface-2 px-2 text-sm"
          >
            <option value="">Any</option>
            {UPLOAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </label>
        {canMine && (
          <Link
            to="/upload"
            className="ml-auto inline-flex min-h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            Upload music
          </Link>
        )}
      </div>

      {list.isPending && <Spinner label="Loading uploads" />}
      {list.isError && <Alert>Could not load uploads. {list.error.message}</Alert>}
      {list.data && groups.length === 0 && (
        <Card className="px-6 py-12 text-center text-sm text-muted">
          {status === '' ? 'No uploads yet.' : `No uploads with status "${statusLabel(status)}".`}
        </Card>
      )}
      <div className="space-y-4">
        {groups.map((group) => (
          <Card key={group.key} className="overflow-hidden">
            {group.batchId !== null && group.items.length > 1 && (
              <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-2/50 px-4 py-2">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Disc3 className="size-4 text-muted" aria-hidden />
                  Batch of {group.items.length}
                </span>
                <Link
                  to="/uploads/batch/$batchId"
                  params={{ batchId: group.batchId }}
                  className="text-sm font-medium text-accent hover:underline"
                >
                  Review batch
                </Link>
              </div>
            )}
            <ul className="divide-y divide-line">
              {group.items.map((u) => (
                <UploadLine key={u.id} upload={u} showUploader={view === 'all'} />
              ))}
            </ul>
          </Card>
        ))}
      </div>

      {total > PAGE_SIZE && (
        <nav aria-label="Pagination" className="mt-4 flex items-center justify-between">
          <Button
            variant="secondary"
            disabled={offset === 0}
            onClick={() => {
              setOffset(Math.max(0, offset - PAGE_SIZE));
            }}
          >
            <ChevronLeft className="size-4" aria-hidden />
            Previous
          </Button>
          <span className="text-sm text-muted">
            {offset + 1}-{Math.min(total, offset + PAGE_SIZE)} of {total}
          </span>
          <Button
            variant="secondary"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => {
              setOffset(offset + PAGE_SIZE);
            }}
          >
            Next
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </nav>
      )}
    </>
  );
}
