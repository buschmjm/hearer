import type { UploadStatus } from '@hearer/shared';
import { cx } from '../../lib/cx.ts';
import { STATUS_TONES } from '../../lib/uploadStatus.ts';

export function StatusBadge({ status }: { status: UploadStatus }) {
  const { label, tone } = STATUS_TONES[status];
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        tone,
      )}
    >
      {label}
    </span>
  );
}
