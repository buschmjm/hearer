import type { Track } from '@hearer/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { albumQuery } from '../api/catalog.ts';
import { ArtistCredits } from '../components/ArtistCredits.tsx';
import { CatalogError, Skeletons } from '../components/CatalogState.tsx';
import { Cover } from '../components/Cover.tsx';
import { BackLink, Chip, SectionTitle } from '../components/DetailParts.tsx';
import { QuotaNote, RequestButton } from '../components/RequestButton.tsx';
import { Card } from '../components/ui.tsx';
import { coverAtSize, creditText, formatDuration, yearOf } from '../lib/format.ts';

function TrackRow({ track, albumArtist }: { track: Track; albumArtist: string }) {
  const credit = creditText(track.artistCredit, track.artistName);
  return (
    <li className="flex items-center gap-2.5 px-3 py-2.5 sm:gap-3 sm:px-4">
      <span className="w-6 shrink-0 text-right text-sm text-muted tabular-nums sm:w-7">
        {track.number ?? track.position}
      </span>
      <div className="min-w-0 flex-1">
        <Link
          to="/tracks/$mbid"
          params={{ mbid: track.mbid }}
          className="line-clamp-2 font-medium leading-snug hover:text-accent"
        >
          {track.title}
        </Link>
        {credit && credit !== albumArtist && (
          <p className="truncate text-xs text-muted">
            <ArtistCredits credits={track.artistCredit} fallback={credit} />
          </p>
        )}
      </div>
      <span className="w-12 shrink-0 text-right text-sm text-muted tabular-nums">
        {formatDuration(track.lengthMs)}
      </span>
      <div className="flex shrink-0 justify-end">
        <RequestButton
          type="track"
          mbid={track.mbid}
          title={track.title}
          badges={{ inLibrary: track.inLibrary, request: track.request }}
          size="sm"
        />
      </div>
    </li>
  );
}

export function AlbumPage({ mbid }: { mbid: string }) {
  const album = useQuery(albumQuery(mbid));

  if (album.isPending) return <Skeletons count={1} layout="row" />;
  if (album.isError) {
    return (
      <>
        <BackLink to="/search" label="Back to search" />
        <CatalogError
          error={album.error}
          onRetry={() => {
            void album.refetch();
          }}
        />
      </>
    );
  }
  const a = album.data;
  const release = a.representativeRelease;
  const discs = [...new Set(a.tracks.map((t) => t.discNumber))].sort((x, y) => x - y);
  const totalMs = a.tracks.reduce((sum, t) => sum + (t.lengthMs ?? 0), 0);
  const year = yearOf(a.firstReleaseDate);

  return (
    <>
      <BackLink to="/search" label="Back to search" />
      <header className="flex flex-col gap-6 sm:flex-row">
        <Cover
          src={coverAtSize(a.coverUrl, 500)}
          alt={`Cover of ${a.title}`}
          kind="album"
          className="w-full max-w-72 self-center rounded-2xl shadow-card sm:w-60 sm:self-start lg:w-72"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-accent">
            {[a.primaryType, ...a.secondaryTypes].filter(Boolean).join(' · ') || 'Release'}
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight wrap-break-word sm:text-4xl">
            {a.title}
          </h1>
          {a.disambiguation && <p className="mt-1 text-muted">{a.disambiguation}</p>}
          <p className="mt-2 text-lg text-muted">
            <ArtistCredits credits={a.artistCredit} fallback={a.artistName} />
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {year && <Chip>{year}</Chip>}
            {a.tracks.length > 0 && <Chip>{a.tracks.length} tracks</Chip>}
            {totalMs > 0 && <Chip>{formatDuration(totalMs)}</Chip>}
            {release?.format && <Chip>{release.format}</Chip>}
          </div>
          <div className="mt-5 flex flex-col items-start gap-1.5">
            <RequestButton
              type="album"
              mbid={a.mbid}
              title={a.title}
              badges={{ inLibrary: a.inLibrary, request: a.request }}
            />
            <QuotaNote />
          </div>
        </div>
      </header>

      <section className="mt-10" aria-label="Tracklist">
        <SectionTitle count={a.tracks.length}>Tracklist</SectionTitle>
        {a.tracks.length === 0 ? (
          <p className="text-sm text-muted">MusicBrainz has no tracklist for this release yet.</p>
        ) : (
          <div className="space-y-4">
            {discs.map((disc) => (
              <Card key={disc} className="overflow-hidden">
                {discs.length > 1 && (
                  <h3 className="border-b border-line bg-surface-2 px-4 py-2 text-xs font-semibold tracking-wide text-muted uppercase">
                    Disc {disc}
                  </h3>
                )}
                <ol className="divide-y divide-line">
                  {a.tracks
                    .filter((t) => t.discNumber === disc)
                    .map((track) => (
                      <TrackRow
                        key={`${track.mbid}-${String(track.position)}`}
                        track={track}
                        albumArtist={a.artistName}
                      />
                    ))}
                </ol>
              </Card>
            ))}
          </div>
        )}
        {release && (
          <p className="mt-3 text-xs text-muted">
            Tracklist from &ldquo;{release.title}&rdquo;
            {release.country ? ` (${release.country})` : ''}
            {a.releases.length > 1 ? `, one of ${String(a.releases.length)} releases` : ''}.
          </p>
        )}
      </section>
    </>
  );
}
