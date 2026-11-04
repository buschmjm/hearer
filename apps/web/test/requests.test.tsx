import { DECLINE_REASON_MAX, Permission, type RequestDto } from '@hearer/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeclineDialog } from '../src/components/DeclineDialog.tsx';
import { RequestTable } from '../src/components/RequestTable.tsx';
import { Timeline } from '../src/components/Timeline.tsx';
import { page, requestDto } from './catalogFixtures.ts';
import {
  METHODS_LOCAL,
  STATUS_DONE,
  apiError,
  meReply,
  mockApi,
  renderApp,
  type Handler,
} from './helpers.tsx';
import { renderWithProviders } from './renderUtils.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

const dto = (over: Record<string, unknown> = {}) => requestDto(over) as unknown as RequestDto;

const counts = (byStatus: Record<string, number> = {}) => ({
  json: {
    total: Object.values(byStatus).reduce((a, b) => a + b, 0),
    byStatus: {
      PENDING: 0,
      APPROVED: 0,
      PROCESSING: 0,
      AWAITING_UPLOAD: 0,
      PARTIALLY_AVAILABLE: 0,
      AVAILABLE: 0,
      DECLINED: 0,
      FAILED: 0,
      CANCELLED: 0,
      ...byStatus,
    },
  },
});

const MANAGER = Permission.MANAGE_REQUESTS;
const USER = Permission.REQUEST | Permission.REQUEST_ALBUM;

function table(
  requests: RequestDto[],
  permissions: number,
  extra: Record<string, Handler> = {},
  showRequester = true,
) {
  return renderWithProviders(
    <RequestTable requests={requests} showRequester={showRequester} />,
    permissions,
    extra,
  );
}

const buttonNames = () => screen.queryAllByRole('button').map((b) => b.getAttribute('aria-label'));

describe('RequestTable', () => {
  it('shows cover, title, artist, type, requester, status and a relative date', async () => {
    await table([dto({ createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() })], USER);
    const row = screen.getAllByRole('row')[1];
    if (!row) throw new Error('no data row');
    expect(within(row).getByRole('link', { name: 'OK Computer' })).toHaveAttribute(
      'href',
      '/requests/req-1',
    );
    expect(within(row).getByText('Radiohead')).toBeInTheDocument();
    expect(within(row).getByText('Album')).toBeInTheDocument();
    expect(within(row).getByText(/Alice/)).toBeInTheDocument();
    expect(within(row).getByText('Pending')).toBeInTheDocument();
    expect(within(row).getByText('3 days ago')).toBeInTheDocument();
    expect(row.querySelector('img')).not.toBeNull();
  });

  it('hides the requester column on "my requests"', async () => {
    await table([dto()], USER, {}, false);
    expect(screen.queryByRole('columnheader', { name: 'Requester' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    });
  });

  it('gives a manager Approve, Decline and Cancel on a pending request', async () => {
    await table(
      [dto({ requestedBy: { id: 'other', username: 'bob', displayName: null, avatar: null } })],
      MANAGER,
    );
    expect(buttonNames()).toEqual([
      'Approve OK Computer',
      'Decline OK Computer',
      'Cancel OK Computer',
    ]);
  });

  it("gives the owner only Cancel, and nothing on someone else's request", async () => {
    // The mocked session user is u1 (the default requester).
    const first = await table([dto()], USER);
    expect(buttonNames()).toEqual(['Cancel OK Computer']);
    first.unmount();
    await table(
      [dto({ requestedBy: { id: 'u2', username: 'bob', displayName: null, avatar: null } })],
      Permission.VIEW_ALL_REQUESTS,
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('offers Retry for FAILED (managers), and nothing for final states', async () => {
    await table(
      [
        dto({ id: 'f', status: 'FAILED' }),
        dto({ id: 'a', status: 'AVAILABLE', title: 'Done' }),
        dto({ id: 'd', status: 'DECLINED', title: 'Nope' }),
        dto({ id: 'c', status: 'CANCELLED', title: 'Gone' }),
      ],
      MANAGER,
    );
    expect(buttonNames()).toEqual(['Retry OK Computer', 'Cancel OK Computer']);
  });

  it('approves and refreshes', async () => {
    const user = userEvent.setup();
    const { calls } = mockCalls();
    await table([dto()], MANAGER, {
      'POST /api/v1/requests/req-1/approve': () => {
        calls.push('approve');
        return { json: requestDto({ status: 'APPROVED' }) };
      },
    });
    await user.click(screen.getByRole('button', { name: 'Approve OK Computer' }));
    await screen.findByText('Request approved');
    expect(calls).toEqual(['approve']);
  });

  it('retries a failed request', async () => {
    const user = userEvent.setup();
    let retried = false;
    await table([dto({ status: 'FAILED' })], MANAGER, {
      'POST /api/v1/requests/req-1/retry': () => {
        retried = true;
        return { json: requestDto({ status: 'APPROVED' }) };
      },
    });
    await user.click(screen.getByRole('button', { name: 'Retry OK Computer' }));
    await screen.findByText('Retrying request');
    expect(retried).toBe(true);
  });

  it('confirms before cancelling, then cancels', async () => {
    const user = userEvent.setup();
    let cancelled = 0;
    await table([dto()], USER, {
      'POST /api/v1/requests/req-1/cancel': () => {
        cancelled++;
        return { json: requestDto({ status: 'CANCELLED' }) };
      },
    });
    await user.click(screen.getByRole('button', { name: 'Cancel OK Computer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this request?' });
    expect(cancelled).toBe(0);
    // Backing out does nothing.
    await user.click(within(dialog).getByRole('button', { name: 'Keep request' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(cancelled).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Cancel OK Computer' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel request' }),
    );
    await screen.findByText('Request cancelled');
    expect(cancelled).toBe(1);
  });

  it('shows the server message when an action is refused', async () => {
    const user = userEvent.setup();
    await table([dto()], MANAGER, {
      'POST /api/v1/requests/req-1/approve': apiError(
        409,
        'invalid_transition',
        'A request cannot go from APPROVED to APPROVED',
      ),
    });
    await user.click(screen.getByRole('button', { name: 'Approve OK Computer' }));
    expect(await screen.findByText(/cannot go from APPROVED/)).toBeInTheDocument();
    expect(screen.getByText('Could not approve')).toBeInTheDocument();
  });
});

function mockCalls() {
  return { calls: [] as string[] };
}

describe('DeclineDialog', () => {
  const open = (extra: Record<string, Handler> = {}) => {
    const onClose = vi.fn();
    const view = renderWithProviders(
      <DeclineDialog request={dto()} onClose={onClose} />,
      MANAGER,
      extra,
    );
    return { onClose, view };
  };

  it('is an accessible modal that focuses the reason field', async () => {
    await open().view;
    const dialog = await screen.findByRole('dialog', { name: 'Decline request' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription(/OK Computer will be declined/);
    expect(screen.getByRole('textbox', { name: 'Reason' })).toHaveFocus();
  });

  it('requires a reason (blank and whitespace are rejected, nothing is sent)', async () => {
    const user = userEvent.setup();
    let posted = 0;
    await open({
      'POST /api/v1/requests/req-1/decline': () => {
        posted++;
        return { json: requestDto({ status: 'DECLINED' }) };
      },
    }).view;
    const reason = await screen.findByRole('textbox', { name: 'Reason' });
    await user.click(screen.getByRole('button', { name: 'Decline request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Give a reason');
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    await user.type(reason, '   ');
    await user.click(screen.getByRole('button', { name: 'Decline request' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Give a reason');
    expect(posted).toBe(0);
    // Typing clears the message.
    await user.type(reason, 'x');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('caps the reason at 500 characters and counts them down', async () => {
    const user = userEvent.setup();
    await open().view;
    const reason = await screen.findByRole('textbox', { name: 'Reason' });
    expect(reason).toHaveAttribute('maxlength', String(DECLINE_REASON_MAX));
    expect(screen.getByText('500 characters left')).toBeInTheDocument();
    await user.click(reason);
    await user.paste('a'.repeat(600));
    expect((reason as HTMLTextAreaElement).value).toHaveLength(DECLINE_REASON_MAX);
    expect(screen.getByText('0 characters left')).toBeInTheDocument();
  });

  it('sends the trimmed reason, toasts and closes', async () => {
    const user = userEvent.setup();
    let body: unknown;
    const { onClose } = open({
      'POST /api/v1/requests/req-1/decline': (call) => {
        body = call.body;
        return { json: requestDto({ status: 'DECLINED' }) };
      },
    });
    await user.type(await screen.findByRole('textbox', { name: 'Reason' }), '  Already owned  ');
    await user.click(screen.getByRole('button', { name: 'Decline request' }));
    await screen.findByText('Request declined');
    expect(body).toEqual({ reason: 'Already owned' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a server error and stays open', async () => {
    const user = userEvent.setup();
    const { onClose } = open({
      'POST /api/v1/requests/req-1/decline': apiError(409, 'invalid_transition', 'Too late'),
    });
    await user.type(await screen.findByRole('textbox', { name: 'Reason' }), 'No');
    await user.click(screen.getByRole('button', { name: 'Decline request' }));
    expect(await screen.findByText('Too late')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape and traps Tab inside', async () => {
    const user = userEvent.setup();
    const { onClose } = open();
    await screen.findByRole('dialog');
    const focusable = [
      screen.getByRole('button', { name: 'Close dialog' }),
      screen.getByRole('textbox', { name: 'Reason' }),
      screen.getByRole('button', { name: 'Keep pending' }),
      screen.getByRole('button', { name: 'Decline request' }),
    ];
    expect(focusable[1]).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(focusable[3]).toHaveFocus();
    await user.tab(); // wraps to the first control, never leaves the dialog
    expect(focusable[0]).toHaveFocus();
    await user.tab({ shift: true }); // and back to the last
    expect(focusable[3]).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Timeline', () => {
  it('renders transitions with actor, note and time, oldest first', () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    return renderWithProviders(
      <Timeline
        events={[
          {
            id: 1,
            at: ago(3 * 86_400_000),
            actor: { id: 'u1', username: 'alice', displayName: 'Alice', avatar: null },
            fromStatus: null,
            toStatus: 'PENDING',
            note: null,
          },
          {
            id: 2,
            at: ago(2 * 3_600_000),
            actor: null,
            fromStatus: 'PENDING',
            toStatus: 'DECLINED',
            note: 'Not available in lossless',
          },
        ]}
      />,
      0,
    ).then(() => {
      const items = within(screen.getByRole('list', { name: 'Request timeline' })).getAllByRole(
        'listitem',
      );
      expect(items).toHaveLength(2);
      expect(items[0]).toHaveTextContent('Created as');
      expect(items[0]).toHaveTextContent('Pending');
      expect(items[0]).toHaveTextContent('Alice');
      expect(items[0]).toHaveTextContent('3 days ago');
      expect(items[1]).toHaveTextContent('Pending');
      expect(items[1]).toHaveTextContent('Declined');
      expect(
        within(items[1] ?? document.body).getByRole('img', { name: 'changed to' }),
      ).toBeInTheDocument();
      expect(items[1]).toHaveTextContent('System');
      expect(items[1]).toHaveTextContent('2 hours ago');
      expect(items[1]).toHaveTextContent('Not available in lossless');
    });
  });

  it('says so when there is no activity', async () => {
    await renderWithProviders(<Timeline events={[]} />, 0);
    expect(screen.getByText('No activity recorded yet.')).toBeInTheDocument();
  });
});

function setup(permissions: number, routes: Record<string, Handler>) {
  return mockApi({
    'GET /api/v1/setup/status': { json: STATUS_DONE },
    'GET /api/v1/auth/methods': { json: METHODS_LOCAL },
    'GET /api/v1/auth/me': meReply(permissions),
    ...routes,
  });
}

const listUrls = (fetchMock: ReturnType<typeof mockApi>['fetchMock']) =>
  fetchMock.mock.calls
    .map((c) => c[0] as string)
    .filter((u) => u.startsWith('/api/v1/requests?'))
    .map((u) => new URL(u, 'http://x').searchParams);

describe('requests page', () => {
  it('lists my requests with count chips and no All tab for a plain user', async () => {
    const { fetchMock } = setup(USER, {
      'GET /api/v1/requests': { json: page([dto(), dto({ id: 'req-2', title: 'Kid A' })], 2) },
      'GET /api/v1/requests/counts': counts({ PENDING: 1, AVAILABLE: 1 }),
    });
    renderApp('/requests');
    expect(await screen.findByRole('link', { name: 'Kid A' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'All requests' })).not.toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Filter by status' });
    expect(within(group).getByRole('button', { name: 'All 2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(group).getByRole('button', { name: 'Pending 1' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Available 1' })).toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: /Failed/ })).not.toBeInTheDocument();
    expect(listUrls(fetchMock)[0]?.get('all')).toBe('0');
    // No requester column: these are all mine.
    expect(screen.queryByRole('columnheader', { name: 'Requester' })).not.toBeInTheDocument();
  });

  it("shows the All requests tab to VIEW_ALL_REQUESTS and loads everyone's", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup(Permission.VIEW_ALL_REQUESTS | USER, {
      'GET /api/v1/requests': { json: page([dto()], 1) },
      'GET /api/v1/requests/counts': counts({ PENDING: 1 }),
    });
    const { router } = renderApp('/requests');
    await screen.findByRole('link', { name: 'OK Computer' });
    await user.click(screen.getByRole('tab', { name: 'All requests' }));
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ tab: 'all' });
    });
    expect(await screen.findByRole('columnheader', { name: 'Requester' })).toBeInTheDocument();
    expect(listUrls(fetchMock).some((p) => p.get('all') === '1')).toBe(true);
  });

  it('ignores ?tab=all without permission (never asks the API for everyone)', async () => {
    const { fetchMock } = setup(USER, {
      'GET /api/v1/requests': { json: page([dto()], 1) },
      'GET /api/v1/requests/counts': counts({ PENDING: 1 }),
    });
    renderApp('/requests?tab=all');
    await screen.findByRole('link', { name: 'OK Computer' });
    expect(listUrls(fetchMock).every((p) => p.get('all') === '0')).toBe(true);
  });

  it('filters by status chip and type, and clears filters', async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup(USER, {
      'GET /api/v1/requests': { json: page([dto()], 1) },
      'GET /api/v1/requests/counts': counts({ PENDING: 1, FAILED: 2 }),
    });
    const { router } = renderApp('/requests');
    await user.click(await screen.findByRole('button', { name: 'Failed 2' }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ status: 'FAILED' });
    });
    await user.selectOptions(screen.getByLabelText('Type'), 'album');
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ status: 'FAILED', type: 'album' });
    });
    await user.selectOptions(screen.getByLabelText('Sort'), 'oldest');
    await waitFor(() => {
      const last = listUrls(fetchMock).at(-1);
      expect(last?.get('status')).toBe('FAILED');
      expect(last?.get('type')).toBe('album');
      expect(last?.get('sort')).toBe('createdAt');
      expect(last?.get('order')).toBe('asc');
    });
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ sort: 'oldest' });
    });
  });

  it('paginates', async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup(USER, {
      'GET /api/v1/requests': { json: page([dto()], 45) },
      'GET /api/v1/requests/counts': counts({ PENDING: 45 }),
    });
    const { router } = renderApp('/requests');
    expect(await screen.findByText('Showing 1–20 of 45')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ page: 2 });
    });
    expect(listUrls(fetchMock).at(-1)?.get('offset')).toBe('20');
    expect(await screen.findByText('Showing 21–40 of 45')).toBeInTheDocument();
  });

  it('shows empty and error states', async () => {
    setup(USER, {
      'GET /api/v1/requests': { json: page([], 0) },
      'GET /api/v1/requests/counts': counts(),
    });
    const { unmount } = renderApp('/requests');
    expect(await screen.findByText('No requests yet')).toBeInTheDocument();
    unmount();
    vi.unstubAllGlobals();
    setup(USER, {
      'GET /api/v1/requests': apiError(500, 'internal_error', 'boom'),
      'GET /api/v1/requests/counts': counts(),
    });
    renderApp('/requests?status=FAILED');
    expect(await screen.findByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });
});

describe('request detail page', () => {
  const detail = (over: Record<string, unknown> = {}) => ({
    json: {
      ...requestDto(over),
      events: [
        {
          id: 1,
          at: '2026-11-03T10:00:00.000Z',
          actor: { id: 'u1', username: 'alice', displayName: 'Alice', avatar: null },
          fromStatus: null,
          toStatus: 'PENDING',
          note: null,
        },
        {
          id: 2,
          at: '2026-11-03T11:00:00.000Z',
          actor: { id: 'adm', username: 'admin', displayName: 'Admin', avatar: null },
          fromStatus: 'PENDING',
          toStatus: 'DECLINED',
          note: 'Out of print',
        },
      ],
    },
  });

  it('shows the request, its timeline, the decline reason and links to the album', async () => {
    setup(USER, {
      'GET /api/v1/requests/req-1': detail({
        status: 'DECLINED',
        declineReason: 'Out of print',
        decidedBy: { id: 'adm', username: 'admin', displayName: 'Admin', avatar: null },
      }),
    });
    renderApp('/requests/req-1');
    expect(
      await screen.findByRole('heading', { name: 'OK Computer', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View album/ })).toHaveAttribute(
      'href',
      '/albums/rg-ok',
    );
    expect(
      within(screen.getByRole('list', { name: 'Request timeline' })).getAllByRole('listitem'),
    ).toHaveLength(2);
    expect(screen.getByText('Declined by Admin')).toBeInTheDocument();
    expect(screen.getAllByText('Out of print')).toHaveLength(2);
    expect(screen.getByRole('link', { name: /Back to requests/ })).toBeInTheDocument();
  });

  it('links a track request to the track and its album, with actions for managers', async () => {
    setup(MANAGER, {
      'GET /api/v1/requests/req-1': detail({ type: 'track', mbid: 'rec-1', parentMbid: 'rg-9' }),
    });
    renderApp('/requests/req-1');
    expect(await screen.findByRole('link', { name: /View track/ })).toHaveAttribute(
      'href',
      '/tracks/rec-1',
    );
    expect(screen.getByRole('link', { name: /View album/ })).toHaveAttribute(
      'href',
      '/albums/rg-9',
    );
    expect(screen.getByRole('button', { name: 'Approve OK Computer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline OK Computer' })).toBeInTheDocument();
  });

  it('shows a not-found message for requests you cannot see', async () => {
    setup(USER, { 'GET /api/v1/requests/nope': apiError(404, 'not_found', 'Request not found') });
    renderApp('/requests/nope');
    expect(await screen.findByText(/does not exist/)).toBeInTheDocument();
  });
});

describe('pending badge in the nav', () => {
  it('shows the pending count to managers', async () => {
    setup(MANAGER | USER, { 'GET /api/v1/requests/counts': counts({ PENDING: 4, APPROVED: 2 }) });
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(
      await within(nav).findByRole('link', { name: /^Requests\s*\(4 pending\)$/ }),
    ).toBeInTheDocument();
  });

  it('is not shown, nor requested, for regular users', async () => {
    const { calls } = setup(USER, {});
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getByRole('link', { name: 'Requests' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/v1/requests/counts')).toBe(false);
  });
});
