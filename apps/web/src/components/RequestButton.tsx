import {
  Permission,
  quotaExceededDetailsSchema,
  type Badges,
  type RequestBadge,
  type RequestType,
} from '@hearer/shared';
import { Lock, Plus } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../api/auth.ts';
import { ApiError, errorMessage } from '../api/client.ts';
import { useCreateRequest, useRequestQuota } from '../api/requests.ts';
import { cx } from '../lib/cx.ts';
import { ACTIVE_REQUEST_STATUSES, formatDateTime, quotaSummary } from '../lib/format.ts';
import { LibraryBadge, RequestStatusBadge, StatusBadge } from './StatusBadge.tsx';
import { useToast } from './Toast.tsx';
import { Button } from './ui.tsx';

const REQUIRED_PERMISSION: Record<RequestType, number> = {
  track: Permission.REQUEST,
  album: Permission.REQUEST_ALBUM,
  artist: Permission.REQUEST_ARTIST,
};

const NOUN: Record<RequestType, string> = { track: 'track', album: 'album', artist: 'artist' };

/** A line of text under a primary request button telling people how many requests they have. */
export function QuotaNote({ className }: { className?: string }) {
  const { hasPermission } = useAuth();
  const canRequest = hasPermission(Object.values(REQUIRED_PERMISSION), 'or');
  const { data } = useRequestQuota(canRequest);
  const text = quotaSummary(data);
  if (!text) return null;
  return <p className={cx('text-xs text-muted', className)}>{text}</p>;
}

interface RequestButtonProps {
  type: RequestType;
  mbid: string;
  /** What is being requested, for messages and the accessible name. */
  title: string;
  badges: Badges;
  size?: 'sm' | 'md';
  className?: string;
}

interface Override {
  /** The server badge this override was made on top of; a changed badge makes it stale. */
  base: string;
  request?: RequestBadge;
  inLibrary?: boolean;
}

const badgeKey = (badges: Badges) =>
  `${badges.inLibrary}:${badges.request?.id ?? '-'}:${badges.request?.status ?? '-'}`;

/**
 * Permission-aware request control. Shows what already exists instead of a button (in library,
 * requested, approved, available...), updates optimistically on click and rolls back on error,
 * and turns the 409/429 answers into the right state or message.
 */
export function RequestButton({
  type,
  mbid,
  title,
  badges,
  size = 'md',
  className,
}: RequestButtonProps) {
  const { hasPermission, isLoading } = useAuth();
  const toast = useToast();
  const create = useCreateRequest();
  const allowed = hasPermission(REQUIRED_PERMISSION[type]);
  const { data: quota } = useRequestQuota(allowed);
  const [override, setOverride] = useState<Override | null>(null);
  const [optimistic, setOptimistic] = useState(false);

  const base = badgeKey(badges);
  const live = override?.base === base ? override : null;
  const request = live?.request ?? badges.request;
  const inLibrary = live?.inLibrary ? 'yes' : badges.inLibrary;
  const small = size === 'sm';

  const holdsSlot =
    request !== null &&
    (ACTIVE_REQUEST_STATUSES.includes(request.status) || request.status === 'AVAILABLE');
  if (inLibrary === 'yes' || holdsSlot) {
    return <StatusBadge badges={{ inLibrary, request: holdsSlot ? request : null }} />;
  }
  if (isLoading) return null;

  const label =
    request?.status === 'DECLINED' || request?.status === 'FAILED'
      ? 'Request again'
      : `Request ${NOUN[type]}`;
  const shortLabel = small ? (label === 'Request again' ? 'Again' : 'Request') : label;

  if (!allowed) {
    const reason = `You do not have permission to request ${NOUN[type]}s.`;
    return (
      <span className={cx('inline-flex flex-wrap items-center gap-1.5', className)}>
        <LibraryBadge value={inLibrary} />
        <span title={reason}>
          <Button
            variant="secondary"
            disabled
            aria-label={`${label}: ${title}. ${reason}`}
            className={cx(small && 'min-h-8 px-3 text-xs')}
          >
            <Lock className="size-3.5" aria-hidden />
            <span>{shortLabel}</span>
          </Button>
        </span>
      </span>
    );
  }

  const quotaText = quotaSummary(quota);
  const tooltip = `Request ${title}${quotaText ? ` — ${quotaText}` : ''}`;

  const submit = () => {
    setOptimistic(true);
    create.mutate(
      { type, mbid },
      {
        onSuccess: (created) => {
          setOverride({ base, request: { id: created.id, status: created.status } });
          toast.push({
            tone: 'success',
            title: created.status === 'PENDING' ? 'Request sent' : 'Request approved',
            message:
              created.status === 'PENDING'
                ? `${title} is waiting for approval.`
                : `${title} was approved automatically.`,
          });
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'already_requested') {
            const details = err.details as { requestId?: unknown; status?: unknown } | undefined;
            const parsed =
              typeof details?.requestId === 'string' && typeof details.status === 'string'
                ? ({ id: details.requestId, status: details.status } as RequestBadge)
                : undefined;
            setOverride({
              base,
              request: parsed ?? { id: 'existing', status: 'PENDING' },
            });
            toast.push({ tone: 'info', title: 'Already requested', message: err.message });
          } else if (err instanceof ApiError && err.code === 'already_available') {
            setOverride({ base, inLibrary: true });
            toast.push({
              tone: 'info',
              title: 'Already in the library',
              message: `${title} is available already.`,
            });
          } else if (err instanceof ApiError && err.code === 'quota_exceeded') {
            const parsed = quotaExceededDetailsSchema.safeParse(err.details);
            const reset =
              parsed.success && parsed.data.resetsAt
                ? ` Your next request frees up ${formatDateTime(parsed.data.resetsAt)}.`
                : '';
            toast.push({
              tone: 'error',
              title: 'Request limit reached',
              message: `${parsed.success ? `You have used ${String(parsed.data.used)} of ${String(parsed.data.limit)} requests.` : err.message}${reset}`,
            });
          } else {
            toast.push({
              tone: 'error',
              title: 'Could not send request',
              message: errorMessage(err),
            });
          }
        },
        onSettled: () => {
          setOptimistic(false);
        },
      },
    );
  };

  // Optimistic: show the requested state while the POST is in flight.
  if (optimistic) {
    return <RequestStatusBadge status="PENDING" context="catalog" className="opacity-70" />;
  }

  return (
    <span className={cx('inline-flex flex-wrap items-center gap-1.5', className)}>
      <LibraryBadge value={inLibrary} />
      <Button
        variant={small ? 'secondary' : 'primary'}
        title={tooltip}
        aria-label={`${label}: ${title}`}
        onClick={submit}
        className={cx(small && 'min-h-8 px-3 text-xs')}
      >
        <Plus className="size-3.5" aria-hidden />
        {shortLabel}
      </Button>
    </span>
  );
}
