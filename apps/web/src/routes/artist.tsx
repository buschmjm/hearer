import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { artistAlbumsQuery, artistQuery } from '../api/catalog.ts';
import { CatalogError, Skeletons } from '../components/CatalogState.tsx';
import { BackLink, Chip, SectionTitle } from '../components/DetailParts.tsx';
import { Cover } from '../components/Cover.tsx';
import { QuotaNote, RequestButton } from '../components/RequestButton.tsx';
import { ResultCard } from '../components/ResultCard.tsx';
import { Button } from '../components/ui.tsx';
import { groupReleaseGroups } from '../lib/catalogGroups.ts';
import { creditText, yearOf } from '../lib/format.ts';

export function ArtistPage({ mbid }: { mbid: string }) {
  const artist = useQuery(artistQuery(mbid));
  const albums = useInfiniteQuery(artistAlbumsQuery(mbid));

  if (artist.isPending) return <Skeletons count={1} layout="row" />;
  if (artist.isError) {
    return (
      <>
        <BackLink to="/search" label="Back to search" />
        <CatalogError
          error={artist.error}
          onRetry={() => {
            void artist.refetch();
          }}
        />
      </>
    );
  }
  const a = artist.data;
  const loaded = albums.data?.pages.flatMap((p) => p.items) ?? [];
  const total = albums.data?.pages[0]?.total ?? 0;
  const groups = groupReleaseGroups(loaded);
  const life = a.lifeSpan
    ? [yearOf(a.lifeSpan.begin), a.lifeSpan.ended ? yearOf(a.lifeSpan.end) : 'present']
        .filter(Boolean)
        .join(' – ')
    : null;

  return (
    <>
      <BackLink to="/search" label="Back to search" />
      <header className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <Cover src={null} alt="" kind="artist" className="size-28 sm:size-36" />
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-semibold tracking-tight wrap-break-word sm:text-4xl">
            {a.name}
          </h1>
          {a.disambiguation && <p className="mt-1 text-muted">{a.disambiguation}</p>}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {a.type && <Chip>{a.type}</Chip>}
            {a.country && <Chip>{a.country}</Chip>}
            {life && <Chip>{life}</Chip>}
          </div>
          <div className="mt-4 flex flex-col items-start gap-1.5">
            <RequestButton
              type="artist"
              mbid={a.mbid}
              title={a.name}
              badges={{ inLibrary: a.inLibrary, request: a.request }}
            />
            <QuotaNote />
          </div>
        </div>
      </header>

      <section className="mt-10" aria-label="Releases">
        {albums.isPending ? (
          <Skeletons count={8} />
        ) : albums.isError && loaded.length === 0 ? (
          <CatalogError
            error={albums.error}
            onRetry={() => {
              void albums.refetch();
            }}
          />
        ) : loaded.length === 0 ? (
          <p className="text-sm text-muted">No releases are listed for this artist.</p>
        ) : (
          <div className="space-y-10">
            {groups.map((group) => (
              <div key={group.key}>
                <SectionTitle count={group.items.length}>{group.key}</SectionTitle>
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {group.items.map((rg) => (
                    <li key={rg.mbid} className="flex min-w-0">
                      <ResultCard
                        kind="album"
                        mbid={rg.mbid}
                        title={rg.title}
                        subtitle={creditText(rg.artistCredit, rg.artistName)}
                        meta={[yearOf(rg.firstReleaseDate), ...rg.secondaryTypes]}
                        coverUrl={rg.coverUrl}
                        badges={{ inLibrary: rg.inLibrary, request: rg.request }}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {albums.hasNextPage && (
              <div className="flex flex-col items-center gap-2">
                <Button
                  variant="secondary"
                  loading={albums.isFetchingNextPage}
                  onClick={() => {
                    void albums.fetchNextPage();
                  }}
                >
                  Show more releases
                </Button>
                <p className="text-xs text-muted">
                  Showing {loaded.length.toLocaleString('en')} of {total.toLocaleString('en')}
                </p>
              </div>
            )}
          </div>
        )}
      </section>
    </>
  );
}
