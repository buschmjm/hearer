import { RefreshCw, SearchX } from 'lucide-react';
import type { ReactNode } from 'react';
import { catalogErrorMessage } from '../lib/catalogErrors.ts';
import { Alert, Button, Card } from './ui.tsx';

export function CatalogError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Card className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <Alert className="w-full border-0 bg-transparent p-0 sm:w-auto sm:flex-1">
        {catalogErrorMessage(error)}
      </Alert>
      <Button variant="secondary" onClick={onRetry}>
        <RefreshCw className="size-4" aria-hidden /> Try again
      </Button>
    </Card>
  );
}

export function EmptyState({
  title,
  children,
  icon,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-accent-soft text-accent">
        {icon ?? <SearchX className="size-6" aria-hidden />}
      </span>
      <p className="font-medium">{title}</p>
      {children && <p className="max-w-sm text-sm text-muted">{children}</p>}
    </Card>
  );
}

/** Pulsing placeholders while a page loads. `layout` mirrors the final grid. */
export function Skeletons({
  count = 8,
  layout = 'tile',
}: {
  count?: number;
  layout?: 'tile' | 'row';
}) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={
        layout === 'tile'
          ? 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4'
          : 'grid grid-cols-1 gap-3 md:grid-cols-2'
      }
    >
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className={
            layout === 'tile'
              ? 'animate-pulse rounded-2xl border border-line bg-surface p-3'
              : 'flex animate-pulse items-center gap-3 rounded-2xl border border-line bg-surface p-3'
          }
        >
          <div
            className={
              layout === 'tile'
                ? 'aspect-square w-full rounded-lg bg-surface-2'
                : 'size-16 shrink-0 rounded-lg bg-surface-2 sm:size-20'
            }
          />
          <div className={layout === 'tile' ? 'mt-3 space-y-2' : 'flex-1 space-y-2'}>
            <div className="h-3.5 w-3/4 rounded bg-surface-2" />
            <div className="h-3 w-1/2 rounded bg-surface-2" />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading</span>
    </div>
  );
}
