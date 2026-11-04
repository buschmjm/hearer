import { Permission, type UploadDetail } from '@hearer/shared';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Save } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../api/auth.ts';
import { ApiError, errorMessage } from '../api/client.ts';
import { uploadActions, uploadDetailQuery, uploadKeys, uploadListQuery } from '../api/uploads.ts';
import { StatusBadge } from '../components/upload/StatusBadge.tsx';
import { Alert, Button, Card, PageHeader, Spinner } from '../components/ui.tsx';
import { cx } from '../lib/cx.ts';

interface Row {
  detail: UploadDetail;
  disc: number;
  track: number;
}

const numberOrNull = (s: string): number | null =>
  /^\d{1,4}$/u.test(s.trim()) && Number(s) >= 1 ? Number(s) : null;

/**
 * Album view of an upload batch: the album the files were matched to, a track map with
 * editable numbers, and "Approve all".
 */
export function UploadBatchPage({ batchId }: { batchId: string }) {
  const qc = useQueryClient();
  const { user, hasPermission } = useAuth();
  const isManager = hasPermission(Permission.MANAGE_UPLOADS);
  const list = useQuery(uploadListQuery({ all: isManager, batchId, limit: 200, offset: 0 }, true));
  const details = useQueries({
    queries: (list.data?.items ?? []).map((u) => uploadDetailQuery(u.id)),
  });
  const [edits, setEdits] = useState<Record<string, { disc?: string; track?: string }>>({});
  const [busy, setBusy] = useState<'save' | 'approve' | null>(null);
  const [result, setResult] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  if (list.isPending) return <Spinner label="Loading batch" />;
  if (list.isError) {
    return (
      <>
        <PageHeader title="Album" />
        <Alert>{errorMessage(list.error)}</Alert>
      </>
    );
  }
  const loaded = details.map((d) => d.data).filter((d): d is UploadDetail => d !== undefined);
  if (list.data.items.length === 0) {
    return (
      <>
        <PageHeader title="Album" />
        <Alert tone="info">This batch has no uploads you can see.</Alert>
      </>
    );
  }
  const group = loaded.map((d) => d.match?.group ?? null).find((g) => g !== null) ?? null;

  const rows: Row[] = loaded
    .map((detail) => {
      const mapped = group?.tracks.find((t) => t.uploadId === detail.id);
      const edit = edits[detail.id];
      return {
        detail,
        disc:
          numberOrNull(edit?.disc ?? '') ?? detail.chosen?.discNumber ?? mapped?.discNumber ?? 1,
        track:
          numberOrNull(edit?.track ?? '') ?? detail.chosen?.trackNumber ?? mapped?.trackNumber ?? 0,
      };
    })
    .sort(
      (a, b) =>
        a.disc - b.disc ||
        a.track - b.track ||
        a.detail.originalName.localeCompare(b.detail.originalName),
    );

  const seen = new Map<string, number>();
  for (const r of rows) {
    const key = `${String(r.disc)}-${String(r.track)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const clash = (r: Row): boolean => (seen.get(`${String(r.disc)}-${String(r.track)}`) ?? 0) > 1;

  const hasClash = rows.some(clash);
  const editable = (d: UploadDetail): boolean => d.status === 'NEEDS_REVIEW' && d.chosen !== null;
  const changed = rows.filter((r) => {
    const e = edits[r.detail.id];
    if (!e || !editable(r.detail) || !r.detail.chosen) return false;
    return r.disc !== r.detail.chosen.discNumber || r.track !== r.detail.chosen.trackNumber;
  });
  const reviewable = loaded.filter((d) => d.status === 'NEEDS_REVIEW');
  const canApprove =
    isManager ||
    (hasPermission(Permission.AUTO_APPROVE_UPLOAD) &&
      loaded.every((d) => d.uploaderId === user?.id));

  const run = async (kind: 'save' | 'approve', work: () => Promise<string>) => {
    setBusy(kind);
    setResult(null);
    try {
      setResult({ tone: 'success', text: await work() });
    } catch (err) {
      setResult({
        tone: 'error',
        text: err instanceof ApiError ? err.message : errorMessage(err),
      });
    } finally {
      await qc.invalidateQueries({ queryKey: uploadKeys.all });
      setBusy(null);
    }
  };

  const saveNumbers = () =>
    run('save', async () => {
      for (const r of changed) {
        const chosen = r.detail.chosen;
        if (!chosen) continue;
        const candidateId = r.detail.match?.chosenCandidateId;
        await uploadActions.save(r.detail.id, {
          tags: { ...chosen, discNumber: r.disc, trackNumber: r.track },
          ...(candidateId ? { candidateId } : {}),
          targetRequestId: r.detail.targetRequestId,
        });
      }
      setEdits({});
      return `Saved track numbers for ${String(changed.length)} file(s).`;
    });

  const approveAll = () =>
    run('approve', async () => {
      if (changed.length > 0) {
        for (const r of changed) {
          const chosen = r.detail.chosen;
          if (!chosen) continue;
          await uploadActions.save(r.detail.id, {
            tags: { ...chosen, discNumber: r.disc, trackNumber: r.track },
            targetRequestId: r.detail.targetRequestId,
          });
        }
        setEdits({});
      }
      const res = await uploadActions.batchApprove(batchId);
      const skipped = res.skipped.length > 0 ? `, ${String(res.skipped.length)} skipped` : '';
      return `Approved ${String(res.approved.length)} file(s)${skipped}.`;
    });

  const unmatched = new Set(group?.unmatchedUploadIds ?? []);

  return (
    <>
      <p className="mb-2 text-sm">
        <Link to="/uploads" className="text-muted hover:text-fg">
          Uploads
        </Link>
      </p>
      <PageHeader
        title={group ? group.title : 'Upload batch'}
        subtitle={
          group
            ? `${group.artist} · ${String(group.tracks.length)} of ${String(group.trackTotal)} tracks uploaded`
            : `${String(list.data.items.length)} files uploaded together`
        }
      />
      {!group && loaded.length === list.data.items.length && (
        <Alert tone="info" className="mb-4">
          These files were not matched to a single album, so each is reviewed on its own.
        </Alert>
      )}
      <Card className="overflow-hidden">
        <ul className="divide-y divide-line" aria-label="Track map">
          {rows.map((r) => {
            const e = edits[r.detail.id];
            const can = editable(r.detail);
            return (
              <li key={r.detail.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="flex items-center gap-2">
                  {(group?.tracks.some((t) => t.discNumber > 1) ?? false) && (
                    <input
                      aria-label={`Disc for ${r.detail.originalName}`}
                      inputMode="numeric"
                      disabled={!can}
                      value={e?.disc ?? String(r.disc)}
                      onChange={(event) => {
                        setEdits({ ...edits, [r.detail.id]: { ...e, disc: event.target.value } });
                      }}
                      className="min-h-10 w-12 rounded-lg border border-line bg-surface-2 px-2 text-center text-sm disabled:opacity-60"
                    />
                  )}
                  <input
                    aria-label={`Track number for ${r.detail.originalName}`}
                    inputMode="numeric"
                    disabled={!can}
                    value={e?.track ?? String(r.track === 0 ? '' : r.track)}
                    onChange={(event) => {
                      setEdits({ ...edits, [r.detail.id]: { ...e, track: event.target.value } });
                    }}
                    className={cx(
                      'min-h-10 w-14 rounded-lg border bg-surface-2 px-2 text-center text-sm disabled:opacity-60',
                      clash(r) ? 'border-danger' : 'border-line',
                    )}
                  />
                </div>
                <div className="min-w-0 flex-1 basis-40">
                  <Link
                    to="/uploads/$id"
                    params={{ id: r.detail.id }}
                    className="block truncate text-sm font-medium hover:underline"
                  >
                    {r.detail.chosen?.title ?? r.detail.originalName}
                  </Link>
                  <span className="block truncate text-xs text-muted">
                    {r.detail.originalName}
                    {unmatched.has(r.detail.id) && ' · not on this album'}
                    {clash(r) && ' · same number as another file'}
                  </span>
                </div>
                <StatusBadge status={r.detail.status} />
              </li>
            );
          })}
        </ul>
      </Card>
      {loaded.length < list.data.items.length && (
        <p className="mt-2 text-xs text-muted">Loading the remaining files...</p>
      )}

      <div className="mt-4 space-y-3">
        {result && <Alert tone={result.tone}>{result.text}</Alert>}
        {hasClash && (
          <Alert>Two files share a track number. Fix the numbers before approving.</Alert>
        )}
        {reviewable.length > 0 && !canApprove && (
          <Alert tone="info">
            An administrator approves the import once you have saved the tags.
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={changed.length === 0 || busy !== null}
            loading={busy === 'save'}
            onClick={() => {
              void saveNumbers();
            }}
          >
            <Save className="size-4" aria-hidden />
            Save track numbers
          </Button>
          {canApprove && (
            <Button
              disabled={reviewable.length === 0 || hasClash || busy !== null}
              loading={busy === 'approve'}
              onClick={() => {
                void approveAll();
              }}
            >
              <Check className="size-4" aria-hidden />
              Approve all
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
