import type { Badges, RequestType } from '@hearer/shared';
import { Link } from '@tanstack/react-router';
import { cx } from '../lib/cx.ts';
import { Cover, type CoverKind } from './Cover.tsx';
import { RequestButton } from './RequestButton.tsx';

export interface ResultCardProps {
  kind: CoverKind;
  mbid: string;
  title: string;
  /** Second line: the artist credit for albums and tracks, the disambiguation for artists. */
  subtitle?: string | undefined;
  /** Small facts joined with a dot: year, release type, country, duration. */
  meta?: readonly (string | null | undefined)[];
  coverUrl?: string | null | undefined;
  badges: Badges;
  /** `tile` stacks a big cover on top (albums); `row` puts a small cover on the left. */
  layout?: 'tile' | 'row';
  className?: string;
}

const REQUEST_TYPE: Record<CoverKind, RequestType> = {
  artist: 'artist',
  album: 'album',
  track: 'track',
};

function DetailLink({
  kind,
  mbid,
  children,
  className,
}: {
  kind: CoverKind;
  mbid: string;
  children: React.ReactNode;
  className?: string;
}) {
  switch (kind) {
    case 'artist':
      return (
        <Link to="/artists/$mbid" params={{ mbid }} className={className}>
          {children}
        </Link>
      );
    case 'album':
      return (
        <Link to="/albums/$mbid" params={{ mbid }} className={className}>
          {children}
        </Link>
      );
    case 'track':
      return (
        <Link to="/tracks/$mbid" params={{ mbid }} className={className}>
          {children}
        </Link>
      );
  }
}

/**
 * One catalog hit (artist, album or track): cover with a placeholder fallback, title, credit,
 * facts, library/request badges and a request button. The title links to the detail page; the
 * whole card is not a link so the button stays a real, separate control.
 */
export function ResultCard({
  kind,
  mbid,
  title,
  subtitle,
  meta = [],
  coverUrl,
  badges,
  layout = kind === 'album' ? 'tile' : 'row',
  className,
}: ResultCardProps) {
  const facts = meta.filter((m): m is string => Boolean(m));
  const tile = layout === 'tile';
  return (
    <article
      className={cx(
        'group flex w-full min-w-0 gap-3 rounded-2xl border border-line bg-surface p-3 shadow-card transition-colors hover:border-muted/50',
        tile ? 'flex-col' : 'flex-wrap items-center sm:flex-nowrap',
        className,
      )}
    >
      <DetailLink kind={kind} mbid={mbid} className={tile ? 'block' : 'block shrink-0'}>
        <Cover
          src={coverUrl}
          alt=""
          kind={kind}
          className={tile ? 'w-full' : 'size-16 sm:size-20'}
        />
      </DetailLink>
      <div className={cx('flex min-w-0 flex-1 flex-col gap-1', tile && 'px-0.5')}>
        <DetailLink
          kind={kind}
          mbid={mbid}
          className="line-clamp-2 font-medium leading-snug hover:text-accent"
        >
          {title}
        </DetailLink>
        {subtitle && <p className="truncate text-sm text-muted">{subtitle}</p>}
        {facts.length > 0 && <p className="truncate text-xs text-muted">{facts.join(' · ')}</p>}
      </div>
      <div className={cx(tile ? 'px-0.5 pb-0.5' : 'w-full shrink-0 sm:w-auto')}>
        <RequestButton
          type={REQUEST_TYPE[kind]}
          mbid={mbid}
          title={title}
          badges={badges}
          size="sm"
        />
      </div>
    </article>
  );
}
