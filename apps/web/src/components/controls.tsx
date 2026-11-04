import { REDACTED_SECRET } from '@hearer/shared';
import { Check, ChevronLeft, ChevronRight, Copy } from 'lucide-react';
import { useId, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { cx } from '../lib/cx.ts';
import { Button, Field } from './ui.tsx';

/** On/off setting: label and hint on the left, a switch on the right. */
export function Switch({
  label,
  hint,
  checked,
  onChange,
  disabled,
  warning,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Shown in amber under the hint while the switch is on. */
  warning?: ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
          <span className="block text-sm font-medium">{label}</span>
          {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
        </label>
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={checked}
          disabled={disabled}
          onClick={() => {
            onChange(!checked);
          }}
          className={cx(
            'relative mt-0.5 h-6 w-11 shrink-0 rounded-full border border-line transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-50',
            checked ? 'bg-accent' : 'bg-surface-2',
          )}
        >
          <span
            aria-hidden
            className={cx(
              'absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform',
              checked ? 'translate-x-5' : '',
            )}
          />
        </button>
      </div>
      {checked && warning && (
        <p className="mt-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
          {warning}
        </p>
      )}
    </div>
  );
}

interface SelectFieldProps extends Omit<ComponentProps<'select'>, 'id' | 'children'> {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  options: readonly { value: string | number; label: string }[];
  /** An empty first option, shown when the value is unset. */
  placeholder?: string;
}

export function SelectField({
  label,
  hint,
  error,
  options,
  placeholder,
  className,
  ...rest
}: SelectFieldProps) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        className={cx(
          'block min-h-11 w-full rounded-lg border bg-surface-2 px-3 text-base text-fg sm:text-sm',
          error ? 'border-danger' : 'border-line hover:border-muted/60',
        )}
        {...rest}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  className,
  ...rest
}: Omit<ComponentProps<'textarea'>, 'id'> & {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
}) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        className={cx(
          'block min-h-24 w-full rounded-lg border bg-surface-2 px-3 py-2 text-base text-fg sm:text-sm',
          error ? 'border-danger' : 'border-line hover:border-muted/60',
        )}
        {...rest}
      />
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A secret value. The server never sends a stored secret, only the mask. While the mask is
 * showing the field is locked; sending the mask back keeps the stored secret, an empty string
 * removes it, anything else replaces it.
 */
export function SecretField({
  label,
  hint,
  error,
  value,
  onChange,
  stored = false,
  disabled,
  placeholder,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  value: string;
  onChange: (next: string) => void;
  /** A secret is saved on the server, so "Keep saved" can restore the mask. */
  stored?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const masked = value === REDACTED_SECRET;
  if (masked) {
    return (
      <div>
        <p className="mb-1.5 text-sm font-medium">{label}</p>
        <div className="flex items-center gap-2">
          <div
            aria-label={`${label} (saved)`}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-sm text-muted"
          >
            <span aria-hidden className="tracking-widest">
              ••••••••
            </span>
            <span className="text-xs">Saved</span>
          </div>
          <Button
            variant="secondary"
            disabled={disabled}
            aria-label={`Replace ${label}`}
            onClick={() => {
              onChange('');
              queueMicrotask(() => input.current?.focus());
            }}
          >
            Replace
          </Button>
        </div>
        {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
      </div>
    );
  }
  return (
    <div>
      <Field
        ref={input}
        label={label}
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        error={error}
        hint={stored && value === '' ? 'The saved value will be removed when you save.' : hint}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
      {stored && (
        <button
          type="button"
          className="mt-1.5 text-xs font-medium text-accent hover:underline"
          onClick={() => {
            onChange(REDACTED_SECRET);
          }}
        >
          Keep the saved value
        </button>
      )}
    </div>
  );
}

type BadgeTone = 'neutral' | 'accent' | 'success' | 'danger' | 'warn';
const BADGE: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-muted border-line',
  accent: 'bg-accent-soft text-accent border-transparent',
  success: 'bg-success-soft text-success border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
};

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        BADGE[tone],
      )}
    >
      {children}
    </span>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      aria-label={copied ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => {
              setCopied(false);
            }, 2000);
          })
          .catch(() => {
            setCopied(false);
          });
      }}
    >
      {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-between gap-3 px-1 pt-3 text-sm text-muted"
    >
      <span>
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => {
            onPage(page - 1);
          }}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <span aria-live="polite">
          Page {page} of {pages}
        </span>
        <Button
          variant="ghost"
          aria-label="Next page"
          disabled={page >= pages}
          onClick={() => {
            onPage(page + 1);
          }}
        >
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}

/** A titled group of settings inside a card. */
export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
