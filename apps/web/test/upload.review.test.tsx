import { Permission, type UploadDetail } from '@hearer/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatchPicker, durationDeltaForTest } from './matchPickerExports.ts';
import { METHODS_LOCAL, STATUS_DONE, apiError, meReply, mockApi, renderApp } from './helpers.tsx';
import {
  BATCH_ID,
  CAND_A,
  CAND_B,
  MBID,
  REQ_ID,
  UP_ID,
  UP_ID_2,
  detail,
  tags,
  upload,
} from './uploadFixtures.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

const EMPTY_PAGE = { items: [], total: 0, offset: 0, limit: 100 };

function setup(
  permissions: number,
  current: UploadDetail,
  extra: Parameters<typeof mockApi>[0] = {},
) {
  let state = current;
  const api = mockApi({
    'GET /api/v1/setup/status': { json: STATUS_DONE },
    'GET /api/v1/auth/methods': { json: METHODS_LOCAL },
    'GET /api/v1/auth/me': meReply(permissions),
    [`GET /api/v1/uploads/${current.id}`]: () => ({ json: state }),
    'GET /api/v1/requests': { json: EMPTY_PAGE },
    ...extra,
  });
  return {
    ...api,
    set: (next: UploadDetail) => {
      state = next;
    },
  };
}

const body = (call: { body: unknown } | undefined) => call?.body as Record<string, unknown>;

describe('MatchPicker', () => {
  it('shows score, details and source, and reports the choice', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <MatchPicker
        candidates={[CAND_A, CAND_B]}
        selectedId={CAND_A.id}
        onSelect={onSelect}
        fileDurationMs={386_000}
      />,
    );
    const radios = screen.getAllByRole('radio');
    const [first, second] = radios as [HTMLElement, HTMLElement];
    expect(radios).toHaveLength(2);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(within(first).getByRole('meter')).toHaveAttribute('aria-valuenow', '93');
    expect(radios[0]).toHaveTextContent('AcoustID + File tags');
    expect(radios[0]).toHaveTextContent('+1.0 s');
    expect(radios[1]).toHaveTextContent('File tags');
    expect(radios[1]).toHaveTextContent('-102.0 s');
    expect(radios[1]).toHaveTextContent('OK Computer OKNOTOK (1997)');
    await user.click(second);
    expect(onSelect).toHaveBeenCalledWith(CAND_B);
  });

  it('highlights only one of several candidates that share an id', () => {
    render(
      <MatchPicker
        candidates={[CAND_A, CAND_A, CAND_B]}
        selectedId={CAND_A.id}
        onSelect={vi.fn()}
        fileDurationMs={386_000}
      />,
    );
    const checked = screen
      .getAllByRole('radio')
      .filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
  });

  it('says so when there are no candidates and formats the length difference', () => {
    render(
      <MatchPicker candidates={[]} selectedId={null} onSelect={vi.fn()} fileDurationMs={null} />,
    );
    expect(screen.getByText(/No matches were found/)).toBeInTheDocument();
    expect(durationDeltaForTest(1000, 1010)).toBe('same length');
    expect(durationDeltaForTest(null, 1)).toBeNull();
  });
});

describe('cover preview', () => {
  it('falls back to an icon when the image cannot load', async () => {
    setup(Permission.UPLOAD, detail());
    renderApp(`/uploads/${UP_ID}`);
    const img = await screen.findByAltText('Cover art');
    fireEvent.error(img);
    expect(screen.queryByAltText('Cover art')).not.toBeInTheDocument();
    expect(screen.getByTestId('cover-preview')).toHaveTextContent(/Cover Art Archive/);
  });
});

describe('review page', () => {
  it('fills the editor from the chosen candidate, validates, then saves', async () => {
    const user = userEvent.setup();
    const { calls } = setup(Permission.UPLOAD, detail(), {
      [`PUT /api/v1/uploads/${UP_ID}/review`]: {
        json: detail({ chosen: tags({ title: 'Airbag (live)' }) }),
      },
    });
    renderApp(`/uploads/${UP_ID}`);
    const title = await screen.findByLabelText('Title');
    expect(title).toHaveValue('Paranoid Android');
    expect(screen.getByTestId('cover-preview').querySelector('img')).toHaveAttribute(
      'src',
      expect.stringContaining(`/release/${MBID.rel}/`),
    );

    // Picking another match replaces the values.
    await user.click(screen.getByRole('radio', { name: /Airbag/ }));
    expect(screen.getByLabelText('Title')).toHaveValue('Airbag');
    expect(screen.getByLabelText('Track')).toHaveValue('1');

    // Validation uses the shared schema; nothing is sent.
    await user.clear(screen.getByLabelText('Title'));
    await user.clear(screen.getByLabelText('Track'));
    await user.type(screen.getByLabelText('Date'), 'x');
    await user.click(screen.getByRole('button', { name: /Save review/ }));
    expect(await screen.findAllByText('Required')).toHaveLength(2);
    expect(screen.getByText('use YYYY or YYYY-MM-DD')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    await user.type(screen.getByLabelText('Title'), 'Airbag (live)');
    await user.type(screen.getByLabelText('Track'), '1');
    await user.clear(screen.getByLabelText('Date'));
    await user.click(screen.getByRole('button', { name: /Save review/ }));
    await screen.findByText('Review saved.');
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe(`/api/v1/uploads/${UP_ID}/review`);
    expect(put?.headers['x-csrf-token']).toBe('csrf-1');
    expect(body(put).candidateId).toBe(CAND_B.id);
    expect(body(put).targetRequestId).toBeNull();
    expect((body(put).tags as { title: string; trackNumber: number }).title).toBe('Airbag (live)');
    expect((body(put).tags as { trackNumber: number }).trackNumber).toBe(1);
  });

  it('a plain uploader can save and reject but not approve', async () => {
    setup(Permission.UPLOAD, detail());
    renderApp(`/uploads/${UP_ID}`);
    await screen.findByRole('button', { name: /Save review/ });
    expect(screen.queryByRole('button', { name: /^Approve$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reject/ })).toBeInTheDocument();
    expect(screen.getByText(/An administrator approves the import/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry import/ })).not.toBeInTheDocument();
  });

  it('an uploader with AUTO_APPROVE_UPLOAD may approve; approving saves first', async () => {
    const user = userEvent.setup();
    const { calls, set } = setup(
      Permission.UPLOAD | Permission.AUTO_APPROVE_UPLOAD,
      detail({ chosen: null }),
      {
        [`POST /api/v1/uploads/${UP_ID}/approve`]: () => {
          set(detail({ status: 'APPROVED', chosen: tags() }));
          return { json: detail({ status: 'APPROVED', chosen: tags() }) };
        },
        [`PUT /api/v1/uploads/${UP_ID}/review`]: () => ({ json: detail({ chosen: tags() }) }),
      },
    );
    renderApp(`/uploads/${UP_ID}`);
    await user.click(await screen.findByRole('button', { name: /^Approve$/ }));
    await screen.findByText(/Importing into the library/);
    const order = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
    expect(order).toEqual([
      `PUT /api/v1/uploads/${UP_ID}/review`,
      `POST /api/v1/uploads/${UP_ID}/approve`,
    ]);
  });

  it('does not approve when the tags are invalid', async () => {
    const user = userEvent.setup();
    const { calls } = setup(Permission.UPLOAD | Permission.MANAGE_UPLOADS, detail());
    renderApp(`/uploads/${UP_ID}`);
    await user.clear(await screen.findByLabelText('Artist'));
    await user.click(screen.getByRole('button', { name: /^Approve$/ }));
    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('rejects with a reason', async () => {
    const user = userEvent.setup();
    const { calls } = setup(Permission.UPLOAD, detail(), {
      [`POST /api/v1/uploads/${UP_ID}/reject`]: {
        json: detail({ status: 'REJECTED', error: 'Wrong album' }),
      },
    });
    renderApp(`/uploads/${UP_ID}`);
    await user.click(await screen.findByRole('button', { name: /Reject/ }));
    const submit = screen.getByRole('button', { name: 'Reject upload' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Why is this being rejected?'), 'Wrong album');
    await user.click(submit);
    await screen.findByText('Wrong album');
    const post = calls.find((c) => c.method === 'POST');
    expect(body(post)).toEqual({ reason: 'Wrong album' });
  });

  it('reanalyzes', async () => {
    const user = userEvent.setup();
    const { calls } = setup(Permission.UPLOAD, detail(), {
      [`POST /api/v1/uploads/${UP_ID}/reanalyze`]: { json: detail({ status: 'RECEIVED' }) },
    });
    renderApp(`/uploads/${UP_ID}`);
    await user.click(await screen.findByRole('button', { name: /Reanalyze/ }));
    await screen.findByText(/Analyzing the file/);
    expect(calls.some((c) => c.path.endsWith('/reanalyze'))).toBe(true);
  });

  it('links the file to a waiting request', async () => {
    const user = userEvent.setup();
    const { calls } = setup(Permission.UPLOAD, detail(), {
      'GET /api/v1/requests': {
        json: {
          ...EMPTY_PAGE,
          total: 1,
          items: [
            {
              id: REQ_ID,
              type: 'track',
              mbid: MBID.rec1,
              parentMbid: null,
              title: 'Paranoid Android',
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
        },
      },
      [`PUT /api/v1/uploads/${UP_ID}/review`]: { json: detail({ targetRequestId: REQ_ID }) },
    });
    renderApp(`/uploads/${UP_ID}`);
    await user.selectOptions(await screen.findByLabelText('Fulfills request'), REQ_ID);
    await user.click(screen.getByRole('button', { name: /Save review/ }));
    await screen.findByText('Review saved.');
    expect(body(calls.find((c) => c.method === 'PUT')).targetRequestId).toBe(REQ_ID);
  });

  it('shows the destination path to people who can read the library settings', async () => {
    setup(Permission.UPLOAD | Permission.MANAGE_SETTINGS, detail(), {
      'GET /api/v1/settings/library': {
        json: { namingTemplate: '{albumartist}/{album} ({year})/{track:02} - {title}.{ext}' },
      },
    });
    renderApp(`/uploads/${UP_ID}`);
    expect(await screen.findByTestId('destination-preview')).toHaveTextContent(
      'Radiohead/OK Computer (1997)/02 - Paranoid Android.flac',
    );
  });

  it('has no destination section without settings access', async () => {
    setup(Permission.UPLOAD, detail());
    renderApp(`/uploads/${UP_ID}`);
    await screen.findByLabelText('Title');
    expect(screen.queryByTestId('destination-preview')).not.toBeInTheDocument();
  });

  it('shows the duplicate banner and keeps the file when allowed', async () => {
    const user = userEvent.setup();
    const dup = detail({ status: 'DUPLICATE', canKeep: true });
    if (dup.match)
      dup.match.duplicate = { kind: 'sha256', message: 'The same file was uploaded before.' };
    const { calls } = setup(Permission.UPLOAD | Permission.MANAGE_UPLOADS, dup, {
      [`POST /api/v1/uploads/${UP_ID}/keep`]: { json: detail({ status: 'RECEIVED' }) },
    });
    renderApp(`/uploads/${UP_ID}`);
    expect(await screen.findByText('The same file was uploaded before.')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Reason for keeping/), 'live version');
    await user.click(screen.getByRole('button', { name: 'Keep as alternate version' }));
    await screen.findByText(/Analyzing the file/);
    expect(body(calls.find((c) => c.method === 'POST'))).toEqual({ reason: 'live version' });
  });

  it('hides "Keep as alternate version" when the server says the caller cannot', async () => {
    const dup = detail({ status: 'DUPLICATE', canKeep: false });
    setup(Permission.UPLOAD, dup);
    renderApp(`/uploads/${UP_ID}`);
    await screen.findByText('This looks like a duplicate');
    expect(
      screen.queryByRole('button', { name: 'Keep as alternate version' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Only an administrator can keep a duplicate/)).toBeInTheDocument();
  });

  it('offers Retry import to managers for failed imports only', async () => {
    const user = userEvent.setup();
    const failed = detail({ status: 'FAILED', error: 'Disk full', chosen: tags() });
    const { calls } = setup(Permission.UPLOAD | Permission.MANAGE_UPLOADS, failed, {
      [`POST /api/v1/uploads/${UP_ID}/retry-import`]: {
        json: detail({ status: 'APPROVED', chosen: tags() }),
      },
    });
    renderApp(`/uploads/${UP_ID}`);
    expect(await screen.findByText('Disk full')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry import/ }));
    await screen.findByText(/Importing into the library/);
    expect(calls.some((c) => c.path.endsWith('/retry-import'))).toBe(true);
  });

  it('hides Retry import from non-managers', async () => {
    setup(Permission.UPLOAD, detail({ status: 'FAILED', error: 'Disk full', chosen: tags() }));
    renderApp(`/uploads/${UP_ID}`);
    await screen.findByText('Disk full');
    expect(screen.queryByRole('button', { name: /Retry import/ })).not.toBeInTheDocument();
  });

  it('shows the library path once imported', async () => {
    setup(
      Permission.UPLOAD,
      detail({
        status: 'IMPORTED',
        chosen: tags(),
        libraryPath: '/music/Radiohead/OK Computer (1997)/02 - Paranoid Android.flac',
      }),
    );
    renderApp(`/uploads/${UP_ID}`);
    expect(await screen.findByTestId('library-path')).toHaveTextContent(
      '/music/Radiohead/OK Computer (1997)/02 - Paranoid Android.flac',
    );
  });

  it('polls while the upload is analyzing and shows the review when it is ready', async () => {
    const { set } = setup(Permission.UPLOAD, detail({ status: 'ANALYZING', match: null }));
    renderApp(`/uploads/${UP_ID}`);
    await screen.findByText(/Analyzing the file/);
    set(detail());
    await screen.findByLabelText('Title', undefined, { timeout: 5000 });
  }, 10_000);

  it('shows a clean error for an upload that is not visible', async () => {
    mockApi({
      'GET /api/v1/setup/status': { json: STATUS_DONE },
      'GET /api/v1/auth/methods': { json: METHODS_LOCAL },
      'GET /api/v1/auth/me': meReply(Permission.UPLOAD),
      [`GET /api/v1/uploads/${UP_ID}`]: apiError(404, 'not_found', 'Upload not found'),
    });
    renderApp(`/uploads/${UP_ID}`);
    expect(await screen.findByText('Upload not found')).toBeInTheDocument();
  });
});

describe('batch review', () => {
  const groupDetail = (
    id: string,
    name: string,
    track: number,
    over: Partial<UploadDetail> = {},
  ) => {
    const d = detail({
      id,
      batchId: BATCH_ID,
      originalName: name,
      chosen: tags({ title: name, trackNumber: track }),
      ...over,
    });
    if (d.match) {
      d.match.group = {
        releaseMbid: MBID.rel,
        releaseGroupMbid: MBID.rg,
        title: 'OK Computer',
        artist: 'Radiohead',
        trackTotal: 12,
        tracks: [
          { uploadId: UP_ID, recordingMbid: MBID.rec1, discNumber: 1, trackNumber: 1 },
          { uploadId: UP_ID_2, recordingMbid: MBID.rec2, discNumber: 1, trackNumber: 2 },
        ],
        unmatchedUploadIds: [],
      };
    }
    return d;
  };

  const batch = (permissions: number, extra: Parameters<typeof mockApi>[0] = {}) => {
    const a = groupDetail(UP_ID, 'airbag.flac', 1);
    const b = groupDetail(UP_ID_2, 'paranoid.flac', 2);
    return {
      a,
      b,
      ...mockApi({
        'GET /api/v1/setup/status': { json: STATUS_DONE },
        'GET /api/v1/auth/methods': { json: METHODS_LOCAL },
        'GET /api/v1/auth/me': meReply(permissions),
        'GET /api/v1/uploads': {
          json: {
            items: [
              upload({ id: UP_ID, batchId: BATCH_ID }),
              upload({ id: UP_ID_2, batchId: BATCH_ID }),
            ],
            total: 2,
            offset: 0,
            limit: 200,
          },
        },
        [`GET /api/v1/uploads/${UP_ID}`]: { json: a },
        [`GET /api/v1/uploads/${UP_ID_2}`]: { json: b },
        ...extra,
      }),
    };
  };

  it('shows the album with its track map', async () => {
    batch(Permission.UPLOAD | Permission.MANAGE_UPLOADS);
    renderApp(`/uploads/batch/${BATCH_ID}`);
    expect(await screen.findByRole('heading', { name: 'OK Computer' })).toBeInTheDocument();
    expect(screen.getByText('Radiohead · 2 of 12 tracks uploaded')).toBeInTheDocument();
    const rows = await screen.findAllByRole('listitem');
    const map = within(screen.getByRole('list', { name: 'Track map' })).getAllByRole('listitem');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(map[0]).toHaveTextContent('airbag.flac');
    expect(map[1]).toHaveTextContent('paranoid.flac');
  });

  it('saves edited track numbers, then approves everything', async () => {
    const user = userEvent.setup();
    const { calls } = batch(Permission.UPLOAD | Permission.MANAGE_UPLOADS, {
      [`PUT /api/v1/uploads/${UP_ID}/review`]: { json: detail() },
      [`PUT /api/v1/uploads/${UP_ID_2}/review`]: { json: detail() },
      [`POST /api/v1/uploads/batch/${BATCH_ID}/approve`]: {
        json: { approved: [UP_ID, UP_ID_2], skipped: [] },
      },
    });
    renderApp(`/uploads/batch/${BATCH_ID}`);
    const input = await screen.findByLabelText('Track number for paranoid.flac');
    await user.clear(input);
    await user.type(input, '7');
    await user.click(screen.getByRole('button', { name: /Save track numbers/ }));
    await screen.findByText('Saved track numbers for 1 file(s).');
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe(`/api/v1/uploads/${UP_ID_2}/review`);
    expect((body(put).tags as { trackNumber: number }).trackNumber).toBe(7);

    await user.click(screen.getByRole('button', { name: /Approve all/ }));
    await screen.findByText('Approved 2 file(s).');
    expect(calls.some((c) => c.path === `/api/v1/uploads/batch/${BATCH_ID}/approve`)).toBe(true);
  });

  it('blocks approval while two files share a track number', async () => {
    const user = userEvent.setup();
    batch(Permission.UPLOAD | Permission.MANAGE_UPLOADS);
    renderApp(`/uploads/batch/${BATCH_ID}`);
    const input = await screen.findByLabelText('Track number for paranoid.flac');
    await user.clear(input);
    await user.type(input, '1');
    expect(await screen.findByText(/Two files share a track number/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Approve all/ })).toBeDisabled();
    });
  });

  it('hides Approve all from uploaders who may not approve', async () => {
    batch(Permission.UPLOAD);
    renderApp(`/uploads/batch/${BATCH_ID}`);
    await screen.findByLabelText('Track number for airbag.flac');
    expect(screen.queryByRole('button', { name: /Approve all/ })).not.toBeInTheDocument();
    expect(screen.getByText(/An administrator approves the import/)).toBeInTheDocument();
  });
});
