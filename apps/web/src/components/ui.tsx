import { AlertCircle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import { useId, type ComponentProps, type ReactNode } from 'react';

import { cx } from '../lib/cx.ts';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover shadow-sm',
  secondary: 'bg-surface-2 text-fg border border-line hover:border-muted/60',
  ghost: 'text-muted hover:text-fg hover:bg-surface-2',
  danger: 'bg-danger text-white hover:opacity-90',
};

export function Button({
  variant = 'primary',
  loading = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ComponentProps<'button'> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      type={type}
      disabled={(disabled ?? false) || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

interface FieldProps extends Omit<ComponentProps<'input'>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  /** Trailing element inside the input box (e.g. a show/hide button). */
  trailing?: ReactNode;
}

export function Field({ label, hint, error, trailing, className, ...rest }: FieldProps) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-err` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          className={cx(
            'block min-h-11 w-full rounded-lg border bg-surface-2 px-3 text-base text-fg placeholder:text-muted/70 sm:text-sm',
            'transition-colors focus-visible:outline-2',
            error ? 'border-danger' : 'border-line hover:border-muted/60',
            trailing ? 'pr-11' : '',
          )}
          {...rest}
        />
        {trailing && <div className="absolute inset-y-0 right-1 flex items-center">{trailing}</div>}
      </div>
      {hint && (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function Card({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      className={cx('rounded-2xl border border-line bg-surface shadow-card', className)}
      {...rest}
    />
  );
}

type AlertTone = 'error' | 'success' | 'info';

const ALERT_STYLES: Record<AlertTone, string> = {
  error: 'border-danger/40 bg-danger-soft text-danger',
  success: 'border-success/40 bg-success-soft text-success',
  info: 'border-line bg-surface-2 text-muted',
};
const ALERT_ICONS = { error: AlertCircle, success: CheckCircle2, info: Info } as const;

export function Alert({
  tone = 'error',
  children,
  className,
}: {
  tone?: AlertTone;
  children: ReactNode;
  className?: string;
}) {
  const Icon = ALERT_ICONS[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm',
        ALERT_STYLES[tone],
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 wrap-break-word">{children}</div>
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 p-10 text-muted">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
    </header>
  );
}
