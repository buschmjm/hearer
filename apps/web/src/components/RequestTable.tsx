import type { RequestDto } from '@hearer/shared';
import { Link } from '@tanstack/react-router';
import { cx } from '../lib/cx.ts';
import {
  REQUEST_TYPE_LABELS,
  formatDateTime,
  formatRelative,
  requesterName,
} from '../lib/format.ts';
import { Cover } from './Cover.tsx';
import { Chip } from './DetailParts.tsx';
import { RequestActions } from './RequestActions.tsx';
import { RequestStatusBadge } from './StatusBadge.tsx';

const COLUMNS_WITH_REQUESTER =
  'md:grid-cols-[minmax(0,2.4fr)_5rem_minmax(0,1fr)_9.5rem_7.5rem_17rem]';
const COLUMNS_MINE = 'md:grid-cols-[minmax(0,2.4fr)_5rem_9.5rem_7.5rem_17rem]';

/**
 * Requests as a table on desktop and as cards on phones (one DOM, laid out by CSS, with table
 * roles). Actions follow the viewer's permissions; see `RequestActions`.
 */
export function RequestTable({
  requests,
  showRequester,
}: {
  requests: readonly RequestDto[];
  showRequester: boolean;
}) {
  const columns = showRequester ? COLUMNS_WITH_REQUESTER : COLUMNS_MINE;
  return (
    <div
      role="table"
      aria-label="Requests"
      className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card"
    >
      <div
        role="row"
        className={cx(
          'hidden gap-4 border-b border-line bg-surface-2 px-4 py-2.5 text-xs font-semibold tracking-wide text-muted uppercase md:grid',
          columns,
        )}
      >
        <div role="columnheader">Request</div>
        <div role="columnheader">Type</div>
        {showRequester && <div role="columnheader">Requester</div>}
        <div role="columnheader">Status</div>
        <div role="columnheader">Requested</div>
        <div role="columnheader" className="text-right">
          Actions
        </div>
      </div>
      <div role="rowgroup" className="divide-y divide-line">
        {requests.map((request) => (
          <div
            key={request.id}
            role="row"
            className={cx(
              'flex flex-wrap items-center gap-x-3 gap-y-2.5 p-3.5 md:grid md:gap-4 md:px-4 md:py-3',
              columns,
            )}
          >
            <div role="cell" className="flex min-w-0 basis-full items-center gap-3 md:basis-auto">
              <Cover
                src={request.coverUrl}
                alt=""
                kind={request.type}
                className="size-12 md:size-11"
              />
              <div className="min-w-0">
                <Link
                  to="/requests/$id"
                  params={{ id: request.id }}
                  className="line-clamp-2 font-medium leading-snug hover:text-accent"
                >
                  {request.title}
                </Link>
                {request.artistName && (
                  <p className="truncate text-sm text-muted">{request.artistName}</p>
                )}
              </div>
            </div>
            <div role="cell">
              <Chip>{REQUEST_TYPE_LABELS[request.type]}</Chip>
            </div>
            {showRequester && (
              <div role="cell" className="min-w-0 truncate text-sm text-muted md:text-fg">
                <span className="md:hidden">by </span>
                {requesterName(request.requestedBy)}
              </div>
            )}
            <div role="cell">
              <RequestStatusBadge status={request.status} />
            </div>
            <div role="cell" className="text-sm text-muted">
              <time dateTime={request.createdAt} title={formatDateTime(request.createdAt)}>
                {formatRelative(request.createdAt)}
              </time>
            </div>
            <div role="cell" className="ml-auto flex md:ml-0 md:justify-end">
              <RequestActions request={request} compact />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
