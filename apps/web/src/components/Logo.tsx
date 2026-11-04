import { cx } from '../lib/cx.ts';

/** The Hearer mark: an ear with sound waves. Same artwork as favicon.svg. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cx('size-9', className)} aria-hidden>
      <defs>
        <linearGradient id="hearer-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b7bff" />
          <stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#hearer-logo)" />
      <path
        d="M24 44c0-6 8-8 8-15a7 7 0 1 0-14 0"
        fill="none"
        stroke="#fff"
        strokeWidth="4.5"
        strokeLinecap="round"
      />
      <path
        d="M38 22a11 11 0 0 1 0 20M45 16a19 19 0 0 1 0 32"
        fill="none"
        stroke="#fff"
        strokeWidth="4"
        strokeLinecap="round"
        opacity=".85"
      />
    </svg>
  );
}

export function Brand({ title, className }: { title: string; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className="text-lg font-semibold tracking-tight">{title}</span>
    </span>
  );
}
