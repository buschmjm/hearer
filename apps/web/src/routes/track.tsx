import { useQuery } from '@tanstack/react-query';
import { trackQuery } from '../api/catalog.ts';
import { ArtistCredits } from '../components/ArtistCredits.tsx';
import { CatalogError, Skeletons } from '../components/CatalogState.tsx';
import { Cover } from '../components/Cover.tsx';
import { BackLink, Chip, SectionTitle } from '../components/DetailParts.tsx';
import { QuotaNote, RequestButton } from '../components/RequestButton.tsx';
import { ResultCard } from '../components/ResultCard.tsx';
import { coverAtSize, creditText, formatDuration, yearOf } from '../lib/format.ts';

export function TrackPage({ mbid }: { mbid: string }) {
  const track = useQuery(trackQuery(mbid));

  if (track.isPending) return <Skeletons count={1} layout="row" />;
  if (track.isError) {
    return (
      <>
        <BackLink to="/search" label="Back to search" />
        <CatalogError
          error={track.error}
          onRetry={() => {
            void track.refetch();
          }}
        />
      </>
    );
  }
  const t = track.data;
  const cover = t.coverUrl ?? t.releaseGroup?.coverUrl ?? null;
  const year = yearOf(t.firstReleaseDate);

  return (
    <>
      <BackLink to="/search" label="Back to search" />
      <header className="flex flex-col gap-6 sm:flex-row">
        <Cover
          src={cover ? coverAtSize(cover, 500) : null}
          alt={`Cover for ${t.title}`}
          kind="track"
          className="w-full max-w-72 self-center rounded-2xl shadow-card sm:w-60 sm:self-start"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-accent">Track</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight wrap-break-word sm:text-4xl">
            {t.title}
          </h1>
          {t.disambiguation && <p className="mt-1 text-muted">{t.disambiguation}</p>}
          <p className="mt-2 text-lg text-muted">
            <ArtistCredits credits={t.artistCredit} fallback={t.artistName} />
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {t.lengthMs !== null && <Chip>{formatDuration(t.lengthMs)}</Chip>}
            {year && <Chip>{year}</Chip>}
            {t.isrcs.slice(0, 3).map((isrc) => (
              <Chip key={isrc}>ISRC {isrc}</Chip>
            ))}
          </div>
          <div className="mt-5 flex flex-col items-start gap-1.5">
            <RequestButton
              type="track"
              mbid={t.mbid}
              title={t.title}
              badges={{ inLibrary: t.inLibrary, request: t.request }}
            />
            <QuotaNote />
          </div>
        </div>
      </header>

      <section className="mt-10" aria-label="Appears on">
        <SectionTitle count={t.releaseGroups.length}>Appears on</SectionTitle>
        {t.releaseGroups.length === 0 ? (
          <p className="text-sm text-muted">This recording is not on any known release.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {t.releaseGroups.map((rg) => (
              <li key={rg.mbid} className="flex min-w-0">
                <ResultCard
                  kind="album"
                  mbid={rg.mbid}
                  title={rg.title}
                  subtitle={creditText(rg.artistCredit, rg.artistName)}
                  meta={[yearOf(rg.firstReleaseDate), rg.primaryType, ...rg.secondaryTypes]}
                  coverUrl={rg.coverUrl}
                  badges={{ inLibrary: rg.inLibrary, request: rg.request }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
