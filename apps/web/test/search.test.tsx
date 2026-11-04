import { Permission } from '@hearer/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResultCard } from '../src/components/ResultCard.tsx';
import { LibraryBadge, RequestStatusBadge, StatusBadge } from '../src/components/StatusBadge.tsx';
import {
  albumSummary,
  artistSummary,
  fetchedUrls,
  quotaReply,
  recordingSummary,
  searchReply,
} from './catalogFixtures.ts';
import { renderWithProviders } from './renderUtils.tsx';
import {
  METHODS_LOCAL,
  STATUS_DONE,
  apiError,
  meReply,
  mockApi,
  renderApp,
  type RecordedCall,
} from './helpers.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(routes: Parameters<typeof mockApi>[0], permissions = Permission.REQUEST_ALBUM) {
  return mockApi({
    'GET /api/v1/setup/status': { json: STATUS_DONE },
    'GET /api/v1/auth/methods': { json: METHODS_LOCAL },
    'GET /api/v1/auth/me': meReply(permissions),
    'GET /api/v1/requests/quota': quotaReply(),
    ...routes,
  });
}

/** The `type` query param of the latest search request (the mock handler sees only the path). */
const searchTypeOf = (fetchMock: ReturnType<typeof mockApi>['fetchMock'], _call: RecordedCall) => {
  const urls = fetchedUrls(fetchMock).filter((u) => u.includes('/search?'));
  return new URL(urls[urls.length - 1] ?? '', 'http://x').searchParams.get('type');
};
const searchCalls = (calls: RecordedCall[]) => calls.filter((c) => c.path === '/api/v1/search');

describe('search page', () => {
  it('shows the prompt without calling the API when there is no query', async () => {
    const { calls } = setup({});
    renderApp('/search');
    expect(await screen.findByText('What are you in the mood for?')).toBeInTheDocument();
    expect(searchCalls(calls)).toHaveLength(0);
  });

  it('debounces typing by 400 ms and syncs the URL', async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({
      'GET /api/v1/search': searchReply('album', [albumSummary()]),
    });
    const { router } = renderApp('/search');
    const box = await screen.findByRole('searchbox', { name: 'Search music' });
    await user.type(box, 'radio');
    // Nothing yet: still inside the debounce window.
    expect(router.state.location.search).toEqual({});
    const urls = () => fetchedUrls(fetchMock).filter((u) => u.includes('/search?'));
    expect(urls()).toHaveLength(0);
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ q: 'radio' });
    });
    expect(await screen.findByText('OK Computer')).toBeInTheDocument();
    // One request for the finished word, none for the keystrokes in between.
    expect(urls()).toHaveLength(1);
    expect(urls()[0]).toContain('q=radio');
    expect(urls()[0]).toContain('type=album');
  });

  it('reads q and type from the URL and switches tabs', async () => {
    const user = userEvent.setup();
    const { calls, fetchMock } = setup({
      'GET /api/v1/search': (call) =>
        searchTypeOf(fetchMock, call) === 'artist'
          ? searchReply('artist', [artistSummary()])
          : searchReply('album', [albumSummary()]),
    });
    const { router } = renderApp('/search?q=radiohead');
    expect(await screen.findByText('OK Computer')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search music' })).toHaveValue('radiohead');
    expect(screen.getByRole('tab', { name: 'Albums' })).toHaveAttribute('aria-selected', 'true');
    expect(searchCalls(calls)).toHaveLength(1);

    // Artists tab: a new request with type=artist, reflected in the URL.
    await user.click(screen.getByRole('tab', { name: 'Artists' }));
    expect(await screen.findByText('Radiohead')).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ q: 'radiohead', type: 'artist' });
    expect(screen.getByRole('tab', { name: 'Artists' })).toHaveAttribute('aria-selected', 'true');
    expect(searchCalls(calls)).toHaveLength(2);
  });

  it('renders track results with duration and album', async () => {
    setup({ 'GET /api/v1/search': searchReply('track', [recordingSummary()]) });
    renderApp('/search?q=paranoid&type=track');
    expect(await screen.findByText('Paranoid Android')).toBeInTheDocument();
    expect(screen.getByText(/OK Computer · 1997 · 6:27/)).toBeInTheDocument();
  });

  it('shows library and request badges on results', async () => {
    setup({
      'GET /api/v1/search': searchReply('album', [
        albumSummary({ mbid: 'a', title: 'In Lib', inLibrary: 'yes' }),
        albumSummary({ mbid: 'b', title: 'Maybe Lib', inLibrary: 'possible' }),
        albumSummary({
          mbid: 'c',
          title: 'Asked For',
          request: { id: 'r1', status: 'PENDING' },
        }),
        albumSummary({
          mbid: 'd',
          title: 'Waiting',
          request: { id: 'r2', status: 'AWAITING_UPLOAD' },
        }),
      ]),
    });
    renderApp('/search?q=x');
    await screen.findByText('In Lib');
    expect(screen.getByText('In library')).toBeInTheDocument();
    expect(screen.getByText('Possibly in library')).toBeInTheDocument();
    expect(screen.getByText('Requested')).toBeInTheDocument();
    expect(screen.getByText('Awaiting upload')).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    setup({ 'GET /api/v1/search': searchReply('album', []) });
    renderApp('/search?q=zzzz');
    expect(await screen.findByText('No results')).toBeInTheDocument();
    expect(screen.getByText(/Nothing matched/)).toBeInTheDocument();
  });

  it('shows a friendly retryable error for 502 metadata_unavailable', async () => {
    const user = userEvent.setup();
    let fail = true;
    setup({
      'GET /api/v1/search': () =>
        fail
          ? apiError(502, 'metadata_unavailable', 'MusicBrainz is unavailable')
          : searchReply('album', [albumSummary()]),
    });
    renderApp('/search?q=radiohead');
    expect(await screen.findByText(/not answering right now/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('OK Computer')).toBeInTheDocument();
  });

  it('loads more results with an increasing offset', async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({
      'GET /api/v1/search': searchReply('album', [albumSummary()], 45),
    });
    renderApp('/search?q=radiohead');
    await screen.findByText('OK Computer');
    expect(screen.getByText('45 results')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => {
      const urls = fetchedUrls(fetchMock).filter((u) => u.includes('/search?'));
      expect(urls).toHaveLength(2);
      expect(urls[1]).toContain('offset=20');
    });
  });

  it('is reachable from the home search box', async () => {
    const user = userEvent.setup();
    setup({ 'GET /api/v1/search': searchReply('album', [albumSummary()]) });
    renderApp('/');
    await user.type(await screen.findByRole('searchbox', { name: 'Search music' }), 'ok{Enter}');
    expect(await screen.findByText('OK Computer')).toBeInTheDocument();
  });
});

describe('ResultCard cover fallback', () => {
  const badges = { inLibrary: 'no', request: null } as const;

  it('swaps in a placeholder when the cover fails to load', async () => {
    await renderWithProviders(
      <ResultCard
        kind="album"
        mbid="rg-ok"
        title="OK Computer"
        coverUrl="https://coverartarchive.org/release-group/rg-ok/front-250"
        badges={badges}
      />,
      Permission.REQUEST_ALBUM,
    );
    const img = document.querySelector('img');
    if (!img) throw new Error('no cover image rendered');
    expect(screen.queryByTestId('cover-fallback')).not.toBeInTheDocument();
    fireEvent.error(img);
    expect(screen.getByTestId('cover-fallback')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows the placeholder straight away without a cover url', async () => {
    await renderWithProviders(
      <ResultCard kind="artist" mbid="a" title="Radiohead" coverUrl={null} badges={badges} />,
      0,
    );
    expect(screen.getByTestId('cover-fallback')).toBeInTheDocument();
  });

  it('links the title to the detail page for each kind', async () => {
    await renderWithProviders(
      <>
        <ResultCard kind="artist" mbid="a1" title="Artist One" badges={badges} />
        <ResultCard kind="album" mbid="b1" title="Album One" badges={badges} />
        <ResultCard kind="track" mbid="t1" title="Track One" badges={badges} />
      </>,
      0,
    );
    expect(screen.getByRole('link', { name: 'Artist One' })).toHaveAttribute('href', '/artists/a1');
    expect(screen.getByRole('link', { name: 'Album One' })).toHaveAttribute('href', '/albums/b1');
    expect(screen.getByRole('link', { name: 'Track One' })).toHaveAttribute('href', '/tracks/t1');
  });

  it('puts the year, type and duration facts on the card', async () => {
    await renderWithProviders(
      <ResultCard
        kind="track"
        mbid="t1"
        title="T"
        subtitle="Someone"
        meta={['1997', null, '3:35']}
        badges={badges}
      />,
      0,
    );
    expect(screen.getByText('1997 · 3:35')).toBeInTheDocument();
    expect(within(screen.getByRole('article')).getByText('Someone')).toBeInTheDocument();
  });
});

describe('StatusBadge', () => {
  it('renders nothing for an unknown, unrequested item', async () => {
    const { container } = await renderWithProviders(
      <StatusBadge badges={{ inLibrary: 'no', request: null }} />,
      0,
    );
    expect(container.querySelector('span')).toBeNull();
  });

  it('prefers "In library" over an AVAILABLE request', async () => {
    await renderWithProviders(
      <StatusBadge badges={{ inLibrary: 'yes', request: { id: '1', status: 'AVAILABLE' } }} />,
      0,
    );
    expect(screen.getByText('In library')).toBeInTheDocument();
    expect(screen.queryByText('Available')).not.toBeInTheDocument();
  });

  it('labels every request status', async () => {
    const labels: [Parameters<typeof RequestStatusBadge>[0]['status'], string][] = [
      ['PENDING', 'Pending'],
      ['APPROVED', 'Approved'],
      ['PROCESSING', 'Processing'],
      ['AWAITING_UPLOAD', 'Awaiting upload'],
      ['PARTIALLY_AVAILABLE', 'Partially available'],
      ['AVAILABLE', 'Available'],
      ['DECLINED', 'Declined'],
      ['FAILED', 'Failed'],
      ['CANCELLED', 'Cancelled'],
    ];
    for (const [status, label] of labels) {
      const { unmount } = await renderWithProviders(<RequestStatusBadge status={status} />, 0);
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
    await renderWithProviders(<RequestStatusBadge status="PENDING" context="catalog" />, 0);
    expect(screen.getByText('Requested')).toBeInTheDocument();
    expect(LibraryBadge({ value: 'no' })).toBeNull();
  });
});
