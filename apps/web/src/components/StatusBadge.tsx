import type { Badges, InLibrary, RequestStatus } from '@hearer/shared';
import {
  CheckCircle2,
  CircleDashed,
  Clock,
  Hourglass,
  Library,
  Loader2,
  Upload,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { cx } from '../lib/cx.ts';
import { requestStatusLabel } from '../lib/format.ts';

type Tone = 'success' | 'warn' | 'danger' | 'accent' | 'muted';

const TONES: Record<Tone, string> = {
  success: 'bg-success-soft text-success',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  accent: 'bg-accent-soft text-accent',
  muted: 'bg-surface-2 text-muted',
};

const STATUS_STYLE: Record<RequestStatus, { tone: Tone; Icon: LucideIcon }> = {
  PENDING: { tone: 'warn', Icon: Clock },
  APPROVED: { tone: 'accent', Icon: CheckCircle2 },
  PROCESSING: { tone: 'accent', Icon: Loader2 },
  AWAITING_UPLOAD: { tone: 'accent', Icon: Upload },
  PARTIALLY_AVAILABLE: { tone: 'success', Icon: Hourglass },
  AVAILABLE: { tone: 'success', Icon: CheckCircle2 },
  DECLINED: { tone: 'danger', Icon: XCircle },
  FAILED: { tone: 'danger', Icon: XCircle },
  CANCELLED: { tone: 'muted', Icon: CircleDashed },
};

function Pill({
  tone,
  Icon,
  children,
  className,
}: {
  tone: Tone;
  Icon: LucideIcon;
  children: string;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {children}
    </span>
  );
}

/** A request's status as a pill. `catalog` says "Requested" for PENDING; `queue` says "Pending". */
export function RequestStatusBadge({
  status,
  context = 'queue',
  className,
}: {
  status: RequestStatus;
  context?: 'catalog' | 'queue';
  className?: string;
}) {
  const { tone, Icon } = STATUS_STYLE[status];
  return (
    <Pill tone={tone} Icon={Icon} {...(className ? { className } : {})}>
      {requestStatusLabel(status, context)}
    </Pill>
  );
}

export function LibraryBadge({ value }: { value: InLibrary }) {
  if (value === 'no') return null;
  return value === 'yes' ? (
    <Pill tone="success" Icon={Library}>
      In library
    </Pill>
  ) : (
    <Pill tone="warn" Icon={Library}>
      Possibly in library
    </Pill>
  );
}

/**
 * Library + request state for a catalog item. "In library" wins over a request that has since
 * become AVAILABLE (they say the same thing); a possible match is shown next to any request.
 */
export function StatusBadge({ badges, className }: { badges: Badges; className?: string }) {
  const request = badges.request;
  const showRequest = request && !(badges.inLibrary === 'yes' && request.status === 'AVAILABLE');
  if (badges.inLibrary === 'no' && !showRequest) return null;
  return (
    <span className={cx('inline-flex flex-wrap items-center gap-1.5', className)}>
      <LibraryBadge value={badges.inLibrary} />
      {showRequest && <RequestStatusBadge status={request.status} context="catalog" />}
    </span>
  );
}
