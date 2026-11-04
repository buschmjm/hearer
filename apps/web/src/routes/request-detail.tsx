import type { RequestDto } from '@hearer/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { requestDetailQuery } from '../api/requests.ts';
import { CatalogError, Skeletons } from '../components/CatalogState.tsx';
import { Cover } from '../components/Cover.tsx';
import { BackLink, Chip, SectionTitle } from '../components/DetailParts.tsx';
import { RequestActions } from '../components/RequestActions.tsx';
import { RequestStatusBadge } from '../components/StatusBadge.tsx';
import { Timeline } from '../components/Timeline.tsx';
import { Alert, Card } from '../components/ui.tsx';
import {
  REQUEST_TYPE_LABELS,
  formatDateTime,
  formatRelative,
  requesterName,
} from '../lib/format.ts';

/** Where to read about the thing that was requested. */
function CatalogLinks({ request }: { request: RequestDto }) {
  const link = 'inline-flex items-center gap-1.5 text-sm text-accent hover:underline';
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2">
      {request.type === 'album' && (
        <Link to="/albums/$mbid" params={{ mbid: request.mbid }} className={link}>
          <ExternalLink className="size-3.5" aria-hidden /> View album
        </Link>
      )}
      {request.type === 'artist' && (
        <Link to="/artists/$mbid" params={{ mbid: request.mbid }} className={link}>
          <ExternalLink className="size-3.5" aria-hidden /> View artist
        </Link>
      )}
      {request.type === 'track' && (
        <Link to="/tracks/$mbid" params={{ mbid: request.mbid }} className={link}>
          <ExternalLink className="size-3.5" aria-hidden /> View track
        </Link>
      )}
      {request.type === 'track' && request.parentMbid && (
        <Link to="/albums/$mbid" params={{ mbid: request.parentMbid }} className={link}>
          <ExternalLink className="size-3.5" aria-hidden /> View album
        </Link>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-wide text-muted uppercase">{label}</dt>
      <dd className="mt-0.5 text-sm wrap-break-word">{children}</dd>
    </div>
  );
}

export function RequestDetailPage({ id }: { id: string }) {
  const detail = useQuery(requestDetailQuery(id));

  if (detail.isPending) return <Skeletons count={1} layout="row" />;
  if (detail.isError) {
    return (
      <>
        <BackLink to="/requests" label="Back to requests" />
        <CatalogError
          error={detail.error}
          onRetry={() => {
            void detail.refetch();
          }}
        />
      </>
    );
  }
  const request = detail.data;
  const decided = request.decidedBy ? requesterName(request.decidedBy) : null;

  return (
    <>
      <BackLink to="/requests" label="Back to requests" />
      <header className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <Cover
          src={request.coverUrl}
          alt=""
          kind={request.type}
          className="size-32 self-center sm:size-40 sm:self-start"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Chip>{REQUEST_TYPE_LABELS[request.type]}</Chip>
            <RequestStatusBadge status={request.status} />
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight wrap-break-word sm:text-3xl">
            {request.title}
          </h1>
          {request.artistName && <p className="mt-1 text-lg text-muted">{request.artistName}</p>}
          <div className="mt-4">
            <RequestActions request={request} />
          </div>
          <div className="mt-4">
            <CatalogLinks request={request} />
          </div>
        </div>
      </header>

      {request.status === 'DECLINED' && request.declineReason && (
        <Alert className="mt-6">
          <p className="font-medium">Declined{decided ? ` by ${decided}` : ''}</p>
          <p className="mt-0.5 whitespace-pre-wrap">{request.declineReason}</p>
        </Alert>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <section aria-label="Timeline">
          <SectionTitle count={request.events.length}>Timeline</SectionTitle>
          <Card className="p-4 sm:p-5">
            <Timeline events={request.events} />
          </Card>
        </section>
        <section aria-label="Details">
          <SectionTitle>Details</SectionTitle>
          <Card className="p-4 sm:p-5">
            <dl className="space-y-4">
              <Fact label="Requested by">{requesterName(request.requestedBy)}</Fact>
              <Fact label="Requested">
                <time dateTime={request.createdAt} title={formatDateTime(request.createdAt)}>
                  {formatRelative(request.createdAt)}
                </time>
              </Fact>
              <Fact label="Last update">
                <time dateTime={request.updatedAt} title={formatDateTime(request.updatedAt)}>
                  {formatRelative(request.updatedAt)}
                </time>
              </Fact>
              {request.providerId && <Fact label="Fulfilled by">{request.providerId}</Fact>}
              {decided && <Fact label="Decided by">{decided}</Fact>}
            </dl>
          </Card>
        </section>
      </div>
    </>
  );
}
