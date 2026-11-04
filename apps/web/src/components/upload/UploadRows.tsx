import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Pause, Play, RotateCw, X } from 'lucide-react';
import { uploadDetailQuery } from '../../api/uploads.ts';
import { formatBytes, formatDuration } from '../../lib/uploadFiles.ts';
import type { UploadItem, UploadManager } from '../../lib/uploadManager.ts';
import { Button } from '../ui.tsx';
import { StatusBadge } from './StatusBadge.tsx';

function ServerStatus({ uploadId }: { uploadId: string }) {
  const { data, error } = useQuery(uploadDetailQuery(uploadId));
  if (!data) {
    return (
      <span className="text-xs text-muted">{error ? 'Status unavailable' : 'Checking...'}</span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <StatusBadge status={data.status} />
      {data.error && <span className="text-xs text-danger">{data.error}</span>}
      {(data.status === 'NEEDS_REVIEW' ||
        data.status === 'DUPLICATE' ||
        data.status === 'IMPORTED' ||
        data.status === 'FAILED') && (
        <Link
          to="/uploads/$id"
          params={{ id: uploadId }}
          className="text-xs font-medium text-accent hover:underline"
        >
          {data.status === 'NEEDS_REVIEW' ? 'Review' : 'Details'}
        </Link>
      )}
    </span>
  );
}

const iconBtn = 'min-h-9 px-2';

/** One file: progress, speed, ETA, controls, and (once sent) the server-side status. */
export function UploadRow({ item, manager }: { item: UploadItem; manager: UploadManager }) {
  const pct = item.size > 0 ? Math.min(100, Math.floor((item.bytesUploaded / item.size) * 100)) : 0;
  const active = item.state === 'uploading' || item.state === 'paused' || item.state === 'queued';
  return (
    <li className="rounded-xl border border-line bg-surface p-3" data-testid="upload-row">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={item.name}>
            {item.name}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {formatBytes(item.size)}
            {item.state === 'uploading' && item.speed > 0 && (
              <>
                {' · '}
                {formatBytes(item.speed)}/s
                {item.eta !== null && <> · {formatDuration(item.eta)} left</>}
              </>
            )}
            {item.resumed && item.state !== 'finished' && ' · resumed'}
            {item.state === 'queued' && ' · waiting'}
            {item.state === 'paused' && ' · paused'}
            {item.state === 'cancelled' && ' · cancelled'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {item.state === 'uploading' && (
            <Button
              variant="ghost"
              className={iconBtn}
              aria-label={`Pause ${item.name}`}
              onClick={() => {
                manager.pause(item.id);
              }}
            >
              <Pause className="size-4" aria-hidden />
            </Button>
          )}
          {(item.state === 'paused' || item.state === 'error') && (
            <Button
              variant="ghost"
              className={iconBtn}
              aria-label={`Resume ${item.name}`}
              onClick={() => {
                manager.resume(item.id);
              }}
            >
              {item.state === 'error' ? (
                <RotateCw className="size-4" aria-hidden />
              ) : (
                <Play className="size-4" aria-hidden />
              )}
            </Button>
          )}
          {(active || item.state === 'error') && (
            <Button
              variant="ghost"
              className={iconBtn}
              aria-label={`Cancel ${item.name}`}
              onClick={() => {
                manager.cancel(item.id);
              }}
            >
              <X className="size-4" aria-hidden />
            </Button>
          )}
          {item.state === 'finished' && <Check className="size-4 text-success" aria-hidden />}
        </div>
      </div>
      {item.state !== 'finished' && item.state !== 'cancelled' && (
        <div
          role="progressbar"
          aria-label={`Upload progress for ${item.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2"
        >
          <div
            className={
              item.state === 'error' ? 'h-full bg-danger' : 'h-full bg-accent transition-[width]'
            }
            style={{ width: `${String(pct)}%` }}
          />
        </div>
      )}
      {item.state === 'error' && item.error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {item.error}
        </p>
      )}
      {item.state === 'finished' && item.uploadId && (
        <div className="mt-2">
          <ServerStatus uploadId={item.uploadId} />
        </div>
      )}
    </li>
  );
}
