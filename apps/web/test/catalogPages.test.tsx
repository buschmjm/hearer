import { Permission } from '@hearer/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupReleaseGroups } from '../src/lib/catalogGroups.ts';
import { coverAtSize, formatDuration, formatRelative, yearOf } from '../src/lib/format.ts';
import {
  albumDetail,
  albumSummary,
  credit,
  page,
  quotaReply,
  recordingSummary,
  requestDto,
  trackRow,
} from './catalogFixtures.ts';
import { METHODS_LOCAL, STATUS_DONE, apiError, meReply, mockApi, renderApp } from './helpers.tsx';

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

const artistDetail = {
  mbid: 'artist-radiohead',
  name: 'Radiohead',
  sortName: 'Radiohead',
  type: 'Group',
  country: 'GB',
  disambiguation: '',
  score: null,
  lifeSpan: { begin: '1985', end: null, ended: false },
  inLibrary: 'no',
  request: null,
};

describe('artist page', () => {
  const releases = [
    albumSummary({ mbid: 'a1', title: 'Pablo Honey', firstReleaseDate: '1993-02-22' }),
    albumSummary({ mbid: 'a2', title: 'OK Computer', firstReleaseDate: '1997-05-21' }),
    albumSummary({
      mbid: 'e1',
      title: 'My Iron Lung',
      primaryType: 'EP',
      firstReleaseDate: '1994-09-26',
    }),
    albumSummary({
      mbid: 's1',
      title: 'Creep',
      primaryType: 'Single',
      firstReleaseDate: '1992-09-21',
    }),
    albumSummary({ mbid: 'o1', title: 'Radio Session', primaryType: 'Broadcast' }),
    albumSummary({ mbid: 'o2', title: 'Mystery', primaryType: null }),
  ];

  it('groups release groups into Albums, EPs, Singles and Other, newest first', async () => {
    setup({
      'GET /api/v1/artists/artist-radiohead': { json: artistDetail },
      'GET /api/v1/artists/artist-radiohead/albums': { json: page(releases) },
    });
    renderApp('/artists/artist-radiohead');
    await screen.findByRole('heading', { name: 'Radiohead', level: 1 });
    const headings = (await screen.findAllByRole('heading', { level: 2 })).map(
      (h) => h.firstChild?.textContent,
    );
    expect(headings).toEqual(['Albums', 'EPs', 'Singles', 'Other']);

    const albumsSection = screen.getByRole('heading', { name: /^Albums/ }).parentElement;
    if (!albumsSection) throw new Error('missing Albums section');
    const titles = within(albumsSection)
      .getAllByRole('link', { name: /Pablo Honey|OK Computer/ })
      .filter((a) => a.getAttribute('href')?.startsWith('/albums/') && a.textContent)
      .map((a) => a.textContent);
    expect(titles).toEqual(['OK Computer', 'Pablo Honey']);
    expect(screen.getByText('My Iron Lung')).toBeInTheDocument();
    expect(screen.getByText('Creep')).toBeInTheDocument();
    expect(screen.getByText('Radio Session')).toBeInTheDocument();
    expect(screen.getByText('Mystery')).toBeInTheDocument();
  });

  it('has a Request artist button, and each release carries its own control', async () => {
    const user = userEvent.setup();
    const { calls } = setup(
      {
        'GET /api/v1/artists/artist-radiohead': { json: artistDetail },
        'GET /api/v1/artists/artist-radiohead/albums': {
          json: page([albumSummary({ mbid: 'a2', title: 'OK Computer' })]),
        },
        'POST /api/v1/requests': { status: 201, json: requestDto({ type: 'artist' }) },
      },
      Permission.REQUEST_ARTIST | Permission.REQUEST_ALBUM,
    );
    renderApp('/artists/artist-radiohead');
    await user.click(await screen.findByRole('button', { name: 'Request artist: Radiohead' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        type: 'artist',
        mbid: 'artist-radiohead',
      });
    });
    expect(screen.getByRole('button', { name: 'Request album: OK Computer' })).toBeInTheDocument();
    expect(await screen.findByText('3 of 5 requests left (per 7 days)')).toBeInTheDocument();
  });

  it('shows a retryable error when the catalog is down', async () => {
    setup({
      'GET /api/v1/artists/artist-radiohead': apiError(502, 'metadata_unavailable', 'down'),
    });
    renderApp('/artists/artist-radiohead');
    expect(await screen.findByText(/not answering right now/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  it('groups with an unknown type under Other and sinks undated items', () => {
    const groups = groupReleaseGroups([
      albumSummary({ mbid: '1', title: 'B', primaryType: null, firstReleaseDate: null }),
      albumSummary({ mbid: '2', title: 'A', primaryType: 'Other', firstReleaseDate: '2001' }),
    ] as never);
    expect(groups.map((g) => g.key)).toEqual(['Other']);
    expect(groups[0]?.items.map((i) => i.title)).toEqual(['A', 'B']);
  });
});

describe('album page', () => {
  it('shows the 500px cover, meta and the tracklist with durations', async () => {
    setup({ 'GET /api/v1/albums/rg-ok': { json: albumDetail() } });
    renderApp('/albums/rg-ok');
    expect(
      await screen.findByRole('heading', { name: 'OK Computer', level: 1 }),
    ).toBeInTheDocument();
    const cover = screen.getByAltText('Cover of OK Computer');
    expect(cover).toHaveAttribute(
      'src',
      'https://coverartarchive.org/release-group/rg-ok/front-500',
    );
    expect(screen.getByRole('link', { name: 'Radiohead' })).toHaveAttribute(
      'href',
      '/artists/artist-radiohead',
    );
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getAllByText('4:44')).toHaveLength(2);
    expect(within(list).getByText('—')).toBeInTheDocument(); // unknown length
    expect(screen.getByText('1997')).toBeInTheDocument();
  });

  it('requests a single track and the whole album from the same page', async () => {
    const user = userEvent.setup();
    const { calls } = setup(
      {
        'GET /api/v1/albums/rg-ok': {
          json: albumDetail({
            tracks: [
              trackRow(),
              trackRow({
                mbid: 'rec-paranoid',
                title: 'Paranoid Android',
                position: 2,
                inLibrary: 'yes',
              }),
              trackRow({
                mbid: 'rec-lucky',
                title: 'Lucky',
                position: 3,
                request: { id: 'r7', status: 'PENDING' },
              }),
            ],
          }),
        },
        'POST /api/v1/requests': { status: 201, json: requestDto({ type: 'track' }) },
      },
      Permission.REQUEST | Permission.REQUEST_ALBUM,
    );
    renderApp('/albums/rg-ok');
    await user.click(await screen.findByRole('button', { name: 'Request track: Airbag' }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
        { type: 'track', mbid: 'rec-airbag' },
      ]);
    });
    // Per-track state: one in the library, one already requested, only Airbag had a button.
    expect(screen.getByText('In library')).toBeInTheDocument();
    expect(screen.getAllByText('Requested').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryAllByRole('button', { name: /^Request track/ })).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Request album: OK Computer' }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toContainEqual({
        type: 'album',
        mbid: 'rg-ok',
      });
    });
  });

  it('disables track requests without REQUEST but keeps album requests', async () => {
    setup({ 'GET /api/v1/albums/rg-ok': { json: albumDetail() } }, Permission.REQUEST_ALBUM);
    renderApp('/albums/rg-ok');
    const trackButtons = await screen.findAllByRole('button', { name: /Request track/ });
    expect(trackButtons).toHaveLength(3);
    for (const button of trackButtons) expect(button).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Request album: OK Computer' })).toBeEnabled();
  });

  it('groups multi-disc tracklists', async () => {
    setup({
      'GET /api/v1/albums/rg-ok': {
        json: albumDetail({
          tracks: [
            trackRow({ mbid: 't1', title: 'One', discNumber: 1 }),
            trackRow({ mbid: 't2', title: 'Two', discNumber: 2, position: 1 }),
          ],
        }),
      },
    });
    renderApp('/albums/rg-ok');
    expect(await screen.findByRole('heading', { name: 'Disc 1' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Disc 2' })).toBeInTheDocument();
  });

  it('shows the album as In library and an error for an unknown id', async () => {
    setup({ 'GET /api/v1/albums/rg-ok': { json: albumDetail({ inLibrary: 'yes' }) } });
    const { unmount } = renderApp('/albums/rg-ok');
    expect(await screen.findAllByText('In library')).not.toHaveLength(0);
    unmount();
    vi.unstubAllGlobals();
    setup({ 'GET /api/v1/albums/nope': apiError(404, 'not_found', 'Not found') });
    renderApp('/albums/nope');
    expect(await screen.findByText(/does not exist in the catalog/)).toBeInTheDocument();
  });
});

describe('track page', () => {
  it('shows the recording, its releases and a request button', async () => {
    const user = userEvent.setup();
    const { calls } = setup(
      {
        'GET /api/v1/tracks/rec-paranoid': {
          json: {
            ...recordingSummary(),
            isrcs: ['GBAYE9700100'],
            releaseGroups: [albumSummary({ title: 'OK Computer' })],
          },
        },
        'POST /api/v1/requests': { status: 201, json: requestDto({ type: 'track' }) },
      },
      Permission.REQUEST,
    );
    renderApp('/tracks/rec-paranoid');
    expect(
      await screen.findByRole('heading', { name: 'Paranoid Android', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('6:27')).toBeInTheDocument();
    expect(screen.getByText('ISRC GBAYE9700100')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Appears on/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Request track: Paranoid Android' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        type: 'track',
        mbid: 'rec-paranoid',
      });
    });
  });
});

describe('format helpers', () => {
  it('formats durations, years, cover sizes and relative times', () => {
    expect(formatDuration(215_000)).toBe('3:35');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(null)).toBe('—');
    expect(yearOf('1997-05-21')).toBe('1997');
    expect(yearOf(null)).toBeNull();
    expect(coverAtSize('https://x/release-group/1/front-250', 500)).toBe(
      'https://x/release-group/1/front-500',
    );
    const now = Date.parse('2026-11-04T12:00:00Z');
    expect(formatRelative('2026-11-04T11:59:50Z', now)).toBe('just now');
    expect(formatRelative('2026-11-04T09:00:00Z', now)).toBe('3 hours ago');
    expect(formatRelative('2026-11-01T12:00:00Z', now)).toBe('3 days ago');
    expect(credit('A').name).toBe('A');
  });
});
