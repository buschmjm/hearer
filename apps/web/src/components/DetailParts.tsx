import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { cx } from '../lib/cx.ts';

/** Back button: browser history when there is some, otherwise a fallback link. */
export function BackLink({ to, label }: { to: '/search' | '/requests'; label: string }) {
  const router = useRouter();
  return (
    <Link
      to={to}
      onClick={(event) => {
        if (window.history.length > 1) {
          event.preventDefault();
          router.history.back();
        }
      }}
      className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"
    >
      <ArrowLeft className="size-4" aria-hidden /> {label}
    </Link>
  );
}

/** Pill-shaped fact (release type, country, format). */
export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs text-muted',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function SectionTitle({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <h2 className="mb-3 flex items-baseline gap-2 text-lg font-semibold tracking-tight">
      {children}
      {count !== undefined && (
        <span className="text-sm font-normal text-muted">{count.toLocaleString('en')}</span>
      )}
    </h2>
  );
}
