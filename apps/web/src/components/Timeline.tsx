import type { RequestEventDto } from '@hearer/shared';
import { ArrowRight } from 'lucide-react';
import { formatDateTime, formatRelative } from '../lib/format.ts';
import { RequestStatusBadge } from './StatusBadge.tsx';

const actorName = (actor: RequestEventDto['actor']): string =>
  actor ? (actor.displayName ?? actor.username) : 'System';

/** The request's status history, oldest first: from to status, who, a note and when. */
export function Timeline({ events }: { events: readonly RequestEventDto[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted">No activity recorded yet.</p>;
  }
  return (
    <ol aria-label="Request timeline" className="relative space-y-5">
      {events.map((event, index) => (
        <li key={event.id} className="relative flex gap-3">
          {index < events.length - 1 && (
            <span
              aria-hidden
              className="absolute top-5 bottom-[-1.25rem] left-[0.4375rem] w-px bg-line"
            />
          )}
          <span
            aria-hidden
            className="relative mt-1.5 size-3.5 shrink-0 rounded-full border-2 border-accent bg-surface"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {event.fromStatus ? (
                <>
                  <RequestStatusBadge status={event.fromStatus} />
                  <ArrowRight className="size-3.5 text-muted" aria-label="changed to" role="img" />
                </>
              ) : (
                <span className="text-sm text-muted">Created as</span>
              )}
              <RequestStatusBadge status={event.toStatus} />
            </div>
            <p className="mt-1 text-xs text-muted">
              {actorName(event.actor)} &middot;{' '}
              <time dateTime={event.at} title={formatDateTime(event.at)}>
                {formatRelative(event.at)}
              </time>
            </p>
            {event.note && (
              <p className="mt-1.5 rounded-lg bg-surface-2 px-3 py-2 text-sm wrap-break-word">
                {event.note}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
