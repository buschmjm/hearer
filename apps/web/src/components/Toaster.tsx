import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { cx } from '../lib/cx.ts';
import { dismissToast, useToasts } from '../lib/toast.ts';

const ICON = { success: CheckCircle2, error: AlertCircle, info: Info } as const;
const TONE = {
  success: 'border-success/40 text-success',
  error: 'border-danger/40 text-danger',
  info: 'border-line text-fg',
} as const;

/** Toast stack, above the mobile tab bar. */
export function Toaster() {
  const toasts = useToasts();
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 bottom-20 z-50 flex flex-col items-center gap-2 lg:bottom-6 lg:items-end lg:right-6 lg:left-auto"
    >
      {toasts.map((item) => {
        const Icon = ICON[item.tone];
        return (
          <div
            key={item.id}
            role={item.tone === 'error' ? 'alert' : 'status'}
            className={cx(
              'pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border bg-surface px-3.5 py-3 text-sm shadow-card',
              TONE[item.tone],
            )}
          >
            <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p className="min-w-0 flex-1 wrap-break-word text-fg">{item.message}</p>
            <button
              type="button"
              aria-label="Dismiss"
              className="-m-1 rounded p-1 text-muted hover:text-fg"
              onClick={() => {
                dismissToast(item.id);
              }}
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
