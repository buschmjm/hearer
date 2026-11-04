import { Permission } from '@hearer/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestButton } from '../src/components/RequestButton.tsx';
import { quotaReply, requestDto } from './catalogFixtures.ts';
import { apiError } from './helpers.tsx';
import { renderWithProviders } from './renderUtils.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const NONE = { inLibrary: 'no', request: null } as const;

const album = (badges: Parameters<typeof RequestButton>[0]['badges'] = NONE) => (
  <RequestButton type="album" mbid="rg-ok" title="OK Computer" badges={badges} />
);

describe('RequestButton', () => {
  it('creates a request, shows it immediately and confirms with a toast', async () => {
    const user = userEvent.setup();
    await renderWithProviders(album(), Permission.REQUEST_ALBUM, {
      'GET /api/v1/requests/quota': quotaReply(),
      'POST /api/v1/requests': { status: 201, json: requestDto() },
    });
    const button = await screen.findByRole('button', { name: 'Request album: OK Computer' });
    await user.click(button);
    expect(await screen.findByText('Requested')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Request album/ })).not.toBeInTheDocument();
    expect(await screen.findByText('Request sent')).toBeInTheDocument();
  });

  it('posts the type and mbid with the csrf token and refreshes catalog + request queries', async () => {
    const user = userEvent.setup();
    const calls: { body: unknown; csrf: string | undefined }[] = [];
    const view = await renderWithProviders(album(), Permission.REQUEST_ALBUM, {
      'GET /api/v1/requests/quota': quotaReply(),
      'POST /api/v1/requests': (call) => {
        calls.push({ body: call.body, csrf: call.headers['x-csrf-token'] });
        return { status: 201, json: requestDto({ status: 'APPROVED' }) };
      },
    });
    const invalidate = vi.spyOn(view.queryClient, 'invalidateQueries');
    await user.click(await screen.findByRole('button', { name: /Request album/ }));
    await screen.findByText('Approved');
    expect(calls).toEqual([{ body: { type: 'album', mbid: 'rg-ok' }, csrf: 'csrf-1' }]);
    expect(await screen.findByText('Request approved')).toBeInTheDocument();
    await waitFor(() => {
      const keys = invalidate.mock.calls.map((c) => (c[0]?.queryKey as string[])[0]);
      expect(keys).toEqual(expect.arrayContaining(['requests', 'catalog']));
    });
  });

  it('rolls the optimistic state back when the request fails', async () => {
    const user = userEvent.setup();
    await renderWithProviders(album(), Permission.REQUEST_ALBUM, {
      'GET /api/v1/requests/quota': quotaReply(),
      'POST /api/v1/requests': apiError(500, 'internal_error', 'Boom'),
    });
    await user.click(await screen.findByRole('button', { name: /Request album/ }));
    expect(await screen.findByText('Could not send request')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Request album/ })).toBeEnabled();
    expect(screen.queryByText('Requested')).not.toBeInTheDocument();
  });

  it('shows the existing request on 409 already_requested', async () => {
    const user = userEvent.setup();
    await renderWithProviders(album(), Permission.REQUEST_ALBUM, {
      'GET /api/v1/requests/quota': quotaReply(),
      'POST /api/v1/requests': apiError(
        409,
        'already_requested',
        'This has already been requested',
        {
          requestId: 'req-9',
          status: 'PROCESSING',
        },
      ),
    });
    await user.click(await screen.findByRole('button', { name: /Request album/ }));
    expect(await screen.findByText('Processing')).toBeInTheDocument();
    expect(await screen.findByText('Already requested')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Request album/ })).not.toBeInTheDocument();
  });

  it('shows "In library" on 409 already_available', async () => {
    const user = userEvent.setup();
    await renderWithProviders(album(), Permission.REQUEST_ALBUM, {
      'GET /api/v1/requests/quota': quotaReply(),
      'POST /api/v1/requests': apiError(409, 'already_available', 'This is already in the library'),
    });
    await user.click(await screen.findByRole('button', { name: /Request album/ }));
    expect(await screen.findByText('Already in the library')).toBeInTheDocument();
    expect(screen.getAllByText('In library').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Request album/ })).not.toBeInTheDocument();
  });

  it('explains the limit and reset time on 429 quota_exceeded and keeps the button', async () => {
    const user = userEvent.setup();
    await renderWithProviders(album(), Permission.REQUEST_ALBUM, {
      'GET /api/v1/requests/quota': quotaReply(),
      'POST /api/v1/requests': apiError(429, 'quota_exceeded', 'Request limit reached', {
        limit: 5,
        used: 5,
        resetsAt: '2026-11-08T10:00:00.000Z',
      }),
    });
    await user.click(await screen.findByRole('button', { name: /Request album/ }));
    expect(await screen.findByText('Request limit reached')).toBeInTheDocument();
    expect(screen.getByText(/You have used 5 of 5 requests\./)).toBeInTheDocument();
    expect(screen.getByText(/frees up/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Request album/ })).toBeEnabled();
  });

  it('is disabled with an explanation without the matching permission', async () => {
    // REQUEST_ALBUM does not allow tracks.
    await renderWithProviders(
      <RequestButton type="track" mbid="rec-1" title="Airbag" badges={NONE} />,
      Permission.REQUEST_ALBUM,
    );
    const disabled = await screen.findByRole('button', { name: /Request track: Airbag/ });
    expect(disabled).toBeDisabled();
    expect(disabled.closest('span[title]')).toHaveAttribute(
      'title',
      'You do not have permission to request tracks.',
    );
  });

  it('lets ADMIN request anything', async () => {
    await renderWithProviders(
      <RequestButton type="artist" mbid="a-1" title="Radiohead" badges={NONE} />,
      Permission.ADMIN,
      { 'GET /api/v1/requests/quota': quotaReply({ unlimited: true, remaining: null, limit: 0 }) },
    );
    expect(await screen.findByRole('button', { name: /Request artist/ })).toBeEnabled();
  });

  it('shows the quota in the tooltip', async () => {
    await renderWithProviders(album(), Permission.REQUEST_ALBUM, {
      'GET /api/v1/requests/quota': quotaReply(),
    });
    const button = await screen.findByRole('button', { name: /Request album/ });
    await waitFor(() => {
      expect(button).toHaveAttribute('title', expect.stringContaining('3 of 5 requests left'));
    });
  });

  it('renders state instead of a button for existing requests and library items', async () => {
    const cases: [Parameters<typeof RequestButton>[0]['badges'], string][] = [
      [{ inLibrary: 'yes', request: null }, 'In library'],
      [{ inLibrary: 'no', request: { id: '1', status: 'PENDING' } }, 'Requested'],
      [{ inLibrary: 'no', request: { id: '1', status: 'APPROVED' } }, 'Approved'],
      [{ inLibrary: 'no', request: { id: '1', status: 'AWAITING_UPLOAD' } }, 'Awaiting upload'],
      [{ inLibrary: 'no', request: { id: '1', status: 'AVAILABLE' } }, 'Available'],
    ];
    for (const [badges, text] of cases) {
      const { unmount } = await renderWithProviders(album(badges), Permission.REQUEST_ALBUM);
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('offers "Request again" after a decline and flags a possible library match', async () => {
    await renderWithProviders(
      album({ inLibrary: 'possible', request: { id: '1', status: 'DECLINED' } }),
      Permission.REQUEST_ALBUM,
    );
    expect(await screen.findByRole('button', { name: /Request again/ })).toBeEnabled();
    expect(screen.getByText('Possibly in library')).toBeInTheDocument();
  });
});
