import { Permission } from '@hearer/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dropzone } from '../src/components/upload/Dropzone.tsx';
import { type UploadManager } from '../src/lib/uploadManager.ts';
import { readTosAccepted, writeTosAccepted } from '../src/lib/tos.ts';
import { METHODS_LOCAL, STATUS_DONE, meReply, mockApi, renderApp } from './helpers.tsx';
import { UP_ID, upload } from './uploadFixtures.ts';

const MIB = 1024 * 1024;

afterEach(() => {
  vi.unstubAllGlobals();
});

const config = {
  tusPath: '/api/v1/uploads/tus',
  maxChunkSizeBytes: 50 * MIB,
  maxFileSizeMb: 1,
  allowedFormats: ['flac', 'mp3'],
  quota: { limitMb: 10, days: 7, usedBytes: 0, remainingBytes: 1500 * 1024, unlimited: false },
};

const sized = (name: string, size: number): File => {
  const f = new File(['x'], name);
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

function fakeManager() {
  const add = vi.fn();
  return { manager: { add, queuedBytes: 0 } as unknown as UploadManager, add };
}

describe('Dropzone', () => {
  it('hands accepted files to the manager and lists the rejected ones', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { manager, add } = fakeManager();
    render(<Dropzone config={config} manager={manager} targetRequestId="req-9" />);
    await user.upload(screen.getByLabelText('Audio files'), [
      sized('good.flac', 1000),
      sized('notes.txt', 10),
      sized('big.mp3', 2 * MIB),
    ]);
    expect(add).toHaveBeenCalledTimes(1);
    const [files, options] = add.mock.calls[0] as [File[], { targetRequestId: string }];
    expect(files.map((f) => f.name)).toEqual(['good.flac']);
    expect(options.targetRequestId).toBe('req-9');
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('notes.txt')).toBeInTheDocument();
    expect(alert).toHaveTextContent(/\.txt/);
    expect(alert).toHaveTextContent(/big\.mp3.*limit/);
  });

  it('rejects files over the remaining quota', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { manager, add } = fakeManager();
    render(<Dropzone config={config} manager={manager} targetRequestId={null} />);
    await user.upload(screen.getByLabelText('Audio files'), [
      sized('a.flac', 900 * 1024),
      sized('b.flac', 900 * 1024),
    ]);
    expect((add.mock.calls[0] as [File[]])[0].map((f) => f.name)).toEqual(['a.flac']);
    expect(screen.getByRole('alert')).toHaveTextContent(/b\.flac.*quota/);
  });

  it('does not call the manager when everything is rejected', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { manager, add } = fakeManager();
    render(<Dropzone config={config} manager={manager} targetRequestId={null} />);
    await user.upload(screen.getByLabelText('Audio files'), [sized('x.pdf', 5)]);
    expect(add).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('accepts a drop', async () => {
    const { manager, add } = fakeManager();
    render(<Dropzone config={config} manager={manager} targetRequestId={null} />);
    fireEvent.drop(screen.getByTestId('dropzone'), {
      dataTransfer: { files: [sized('d.flac', 10)], items: [] },
    });
    await waitFor(() => {
      expect(add).toHaveBeenCalled();
    });
  });

  it('ignores input while disabled', () => {
    const { manager } = fakeManager();
    render(
      <Dropzone
        config={config}
        manager={manager}
        targetRequestId={null}
        disabled
        disabledHint="Accept the notice first."
      />,
    );
    expect(screen.getByLabelText('Audio files')).toBeDisabled();
    expect(screen.getByText('Accept the notice first.')).toBeInTheDocument();
  });
});

describe('ToS memory', () => {
  it('is remembered per user and survives blocked storage', () => {
    expect(readTosAccepted('u1')).toBe(false);
    writeTosAccepted('u1', true);
    expect(readTosAccepted('u1')).toBe(true);
    expect(readTosAccepted('u2')).toBe(false);
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readTosAccepted('u1')).toBe(false);
    spy.mockRestore();
  });
});

describe('upload page', () => {
  const routes = (extra: Parameters<typeof mockApi>[0] = {}) =>
    mockApi({
      'GET /api/v1/setup/status': { json: STATUS_DONE },
      'GET /api/v1/auth/methods': { json: METHODS_LOCAL },
      'GET /api/v1/auth/me': meReply(Permission.UPLOAD | Permission.REQUEST),
      'GET /api/v1/uploads/config': { json: config },
      'GET /api/v1/uploads': { json: { items: [], total: 0, offset: 0, limit: 50 } },
      'GET /api/v1/requests': {
        json: {
          items: [
            {
              id: '44444444-4444-4444-8444-444444444444',
              type: 'album',
              mbid: 'b1392450-e666-3926-a536-22c65f834433',
              parentMbid: null,
              title: 'OK Computer',
              artistName: 'Radiohead',
              coverUrl: null,
              status: 'AWAITING_UPLOAD',
              requestedBy: null,
              decidedBy: null,
              decidedAt: null,
              declineReason: null,
              providerId: 'manual',
              fulfilledByUploadId: null,
              createdAt: '2026-03-01T00:00:00.000Z',
              updatedAt: '2026-03-01T00:00:00.000Z',
            },
          ],
          total: 1,
          offset: 0,
          limit: 100,
        },
      },
      ...extra,
    });

  it('shows the notice, keeps the dropzone off until it is accepted, and remembers the answer', async () => {
    const user = userEvent.setup();
    const { calls } = routes();
    const { unmount } = renderApp('/upload');
    expect(await screen.findByText(/Only upload music you have the right to store/)).toBeVisible();
    const input = await screen.findByLabelText('Audio files');
    expect(input).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /right to store/ }));
    expect(screen.getByLabelText('Audio files')).toBeEnabled();
    expect(localStorage.getItem('hearer.uploadTos.u1')).toBe('1');
    // The request selector lists waiting requests.
    expect(
      await screen.findByRole('option', { name: /OK Computer - Radiohead/ }),
    ).toBeInTheDocument();
    const query = calls.find((c) => c.path === '/api/v1/requests');
    expect(query).toBeDefined();
    unmount();
    vi.unstubAllGlobals();
    routes();
    renderApp('/upload');
    await waitFor(() => {
      expect(screen.getByLabelText('Audio files')).toBeEnabled();
    });
  });

  it('hides the request selector when the requests API is not available to the user', async () => {
    routes({
      'GET /api/v1/requests': {
        status: 403,
        json: { error: { code: 'forbidden', message: 'no' } },
      },
    });
    renderApp('/upload');
    await screen.findByLabelText('Audio files');
    expect(screen.queryByText('Fulfills request')).not.toBeInTheDocument();
  });
});

describe('uploads list', () => {
  const base = (permissions: number, extra: Parameters<typeof mockApi>[0] = {}) =>
    mockApi({
      'GET /api/v1/setup/status': { json: STATUS_DONE },
      'GET /api/v1/auth/methods': { json: METHODS_LOCAL },
      'GET /api/v1/auth/me': meReply(permissions),
      ...extra,
    });

  it('groups by batch, links to review and shows the All tab only to managers', async () => {
    const batch = '33333333-3333-4333-8333-333333333333';
    const items = [
      upload({ id: UP_ID, batchId: batch, originalName: 'one.flac' }),
      upload({
        id: '55555555-5555-4555-8555-555555555555',
        batchId: batch,
        originalName: 'two.flac',
        status: 'IMPORTED',
      }),
      upload({
        id: '66666666-6666-4666-8666-666666666666',
        originalName: 'solo.mp3',
        status: 'FAILED',
      }),
    ];
    const { calls } = base(Permission.UPLOAD, {
      'GET /api/v1/uploads': { json: { items, total: 3, offset: 0, limit: 25 } },
    });
    renderApp('/uploads');
    expect(await screen.findByText('Batch of 2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review batch' })).toHaveAttribute(
      'href',
      `/uploads/batch/${batch}`,
    );
    expect(screen.getByRole('link', { name: /one\.flac/ })).toHaveAttribute(
      'href',
      `/uploads/${UP_ID}`,
    );
    expect(screen.getByRole('link', { name: /two\.flac/ })).toHaveTextContent('In library');
    expect(screen.getByRole('link', { name: /solo\.mp3/ })).toHaveTextContent('Failed');
    expect(screen.queryByRole('tab', { name: 'All' })).not.toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/v1/uploads')).toBeDefined();
  });

  it("lets a manager switch to everyone's uploads and filter by status", async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    mockApi({
      'GET /api/v1/setup/status': { json: STATUS_DONE },
      'GET /api/v1/auth/methods': { json: METHODS_LOCAL },
      'GET /api/v1/auth/me': meReply(Permission.UPLOAD | Permission.MANAGE_UPLOADS),
      'GET /api/v1/uploads': () => {
        seen.push(new URL(String(fetchedUrl()), 'http://x').search);
        return { json: { items: [], total: 0, offset: 0, limit: 25 } };
      },
    });
    renderApp('/uploads');
    await screen.findByText('No uploads yet.');
    await user.click(screen.getByRole('tab', { name: 'All' }));
    await user.selectOptions(screen.getByLabelText('Status'), 'NEEDS_REVIEW');
    await screen.findByText(/No uploads with status "Needs review"/);
    expect(seen.some((q) => q.includes('all=1') && q.includes('status=NEEDS_REVIEW'))).toBe(true);
  });

  it('paginates', async () => {
    const user = userEvent.setup();
    const offsets: string[] = [];
    mockApi({
      'GET /api/v1/setup/status': { json: STATUS_DONE },
      'GET /api/v1/auth/methods': { json: METHODS_LOCAL },
      'GET /api/v1/auth/me': meReply(Permission.UPLOAD),
      'GET /api/v1/uploads': () => {
        offsets.push(new URL(String(fetchedUrl()), 'http://x').searchParams.get('offset') ?? '');
        return { json: { items: [upload()], total: 60, offset: 0, limit: 25 } };
      },
    });
    renderApp('/uploads');
    await screen.findByText('1-25 of 60');
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await screen.findByText('26-50 of 60');
    expect(offsets).toContain('25');
  });
});

/** The URL of the most recent mocked fetch call. */
function fetchedUrl(): unknown {
  const mock = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock;
  return mock.calls[mock.calls.length - 1]?.[0];
}
