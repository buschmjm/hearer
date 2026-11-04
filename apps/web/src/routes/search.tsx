import type { SearchResponse, SearchType } from '@hearer/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Search as SearchIcon, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { searchQuery } from '../api/catalog.ts';
import { CatalogError, EmptyState, Skeletons } from '../components/CatalogState.tsx';
import { ResultCard } from '../components/ResultCard.tsx';
import { Button, PageHeader } from '../components/ui.tsx';
import { cx } from '../lib/cx.ts';
import { creditText, formatDuration, yearOf } from '../lib/format.ts';

export const SEARCH_DEBOUNCE_MS = 400;

const TABS: { type: SearchType; label: string }[] = [
  { type: 'artist', label: 'Artists' },
  { type: 'album', label: 'Albums' },
  { type: 'track', label: 'Tracks' },
];

function Results({ pages }: { pages: SearchResponse[] }) {
  const items = pages.flatMap((page) => {
    switch (page.type) {
      case 'artist':
        return page.items.map((a) => (
          <ResultCard
            key={a.mbid}
            kind="artist"
            mbid={a.mbid}
            title={a.name}
            subtitle={a.disambiguation || undefined}
            meta={[a.type, a.country]}
            badges={{ inLibrary: a.inLibrary, request: a.request }}
          />
        ));
      case 'album':
        return page.items.map((a) => (
          <ResultCard
            key={a.mbid}
            kind="album"
            mbid={a.mbid}
            title={a.title}
            subtitle={creditText(a.artistCredit, a.artistName)}
            meta={[yearOf(a.firstReleaseDate), a.primaryType, ...a.secondaryTypes]}
            coverUrl={a.coverUrl}
            badges={{ inLibrary: a.inLibrary, request: a.request }}
          />
        ));
      case 'track':
        return page.items.map((t) => (
          <ResultCard
            key={t.mbid}
            kind="track"
            mbid={t.mbid}
            title={t.title}
            subtitle={creditText(t.artistCredit, t.artistName)}
            meta={[
              t.releaseGroup?.title,
              yearOf(t.firstReleaseDate),
              t.lengthMs === null ? null : formatDuration(t.lengthMs),
            ]}
            coverUrl={t.coverUrl ?? t.releaseGroup?.coverUrl}
            badges={{ inLibrary: t.inLibrary, request: t.request }}
          />
        ));
    }
  });
  const tile = pages[0]?.type === 'album';
  return (
    <ul
      className={cx(
        'grid gap-3',
        tile ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4' : 'grid-cols-1 md:grid-cols-2',
      )}
    >
      {items.map((card) => (
        <li key={card.key} className="flex min-w-0">
          {card}
        </li>
      ))}
    </ul>
  );
}

export function SearchPage({
  q = '',
  type = 'album',
}: {
  q?: string | undefined;
  type?: SearchType;
}) {
  const navigate = useNavigate();
  const [text, setText] = useState(q);
  // The last q this page itself put in the URL, so only outside changes (back button, the home
  // search) overwrite what is being typed.
  const pushed = useRef(q);

  useEffect(() => {
    if (q !== pushed.current) {
      pushed.current = q;
      setText(q);
    }
  }, [q]);

  const commit = (value: string, nextType: SearchType = type) => {
    const trimmed = value.trim();
    pushed.current = trimmed;
    void navigate({
      to: '/search',
      search: {
        ...(trimmed ? { q: trimmed } : {}),
        ...(nextType === 'album' ? {} : { type: nextType }),
      },
      replace: true,
    });
  };

  // Debounced URL sync: typing updates ?q= 400 ms after the last keystroke.
  useEffect(() => {
    if (text.trim() === q) return;
    const timer = window.setTimeout(() => {
      commit(text);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commit only closes over type/navigate
  }, [text, q, type]);

  const term = q.trim();
  const query = useInfiniteQuery({ ...searchQuery(type, term), enabled: term !== '' });
  const pages = query.data?.pages ?? [];
  const total = pages[0]?.total ?? 0;

  return (
    <>
      <PageHeader title="Search" subtitle="Find an artist, album or song in the music catalog." />

      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          commit(text);
        }}
      >
        <label htmlFor="search-input" className="sr-only">
          Search music
        </label>
        <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface p-1.5 shadow-card focus-within:border-accent">
          <SearchIcon className="ml-3 size-5 shrink-0 text-muted" aria-hidden />
          <input
            id="search-input"
            type="search"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
            placeholder="Artist, album or song"
            autoComplete="off"
            className="min-h-11 min-w-0 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-muted/70 [&::-webkit-search-cancel-button]:hidden"
          />
          {text !== '' && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setText('');
                commit('');
              }}
              className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </div>
      </form>

      <div role="tablist" aria-label="Result type" className="mt-5 flex gap-1 border-b border-line">
        {TABS.map((tab) => {
          const selected = tab.type === type;
          return (
            <button
              key={tab.type}
              type="button"
              role="tab"
              id={`tab-${tab.type}`}
              aria-selected={selected}
              aria-controls="search-results"
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                commit(text, tab.type);
              }}
              onKeyDown={(event) => {
                const dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                if (dir === 0) return;
                event.preventDefault();
                const next = TABS[(TABS.indexOf(tab) + dir + TABS.length) % TABS.length];
                if (next) {
                  commit(text, next.type);
                  document.getElementById(`tab-${next.type}`)?.focus();
                }
              }}
              className={cx(
                '-mb-px min-h-11 border-b-2 px-4 text-sm font-medium transition-colors',
                selected
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted hover:text-fg',
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <section
        id="search-results"
        role="tabpanel"
        aria-labelledby={`tab-${type}`}
        aria-busy={query.isFetching}
        className="mt-5"
      >
        {term === '' ? (
          <EmptyState title="What are you in the mood for?">
            Type an artist, an album or a song title above. Results appear as you type.
          </EmptyState>
        ) : query.isPending ? (
          <Skeletons layout={type === 'album' ? 'tile' : 'row'} />
        ) : query.isError && pages.length === 0 ? (
          <CatalogError
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : total === 0 ? (
          <EmptyState title="No results">
            Nothing matched &ldquo;{term}&rdquo;. Check the spelling or try another tab.
          </EmptyState>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted" aria-live="polite">
              {total.toLocaleString('en')} {total === 1 ? 'result' : 'results'}
            </p>
            <Results pages={pages} />
            {query.isError && (
              <div className="mt-4">
                <CatalogError
                  error={query.error}
                  onRetry={() => {
                    void query.fetchNextPage();
                  }}
                />
              </div>
            )}
            {query.hasNextPage && (
              <div className="mt-6 flex justify-center">
                <Button
                  variant="secondary"
                  loading={query.isFetchingNextPage}
                  onClick={() => {
                    void query.fetchNextPage();
                  }}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}
