import {
  Permission,
  type MatchCandidate,
  type ReviewBody,
  type UploadDetail,
} from '@hearer/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, RefreshCw, RotateCw, Save, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { useAuth } from '../api/auth.ts';
import { api, errorMessage } from '../api/client.ts';
import { isTransient, uploadActions, uploadDetailQuery, useUploadAction } from '../api/uploads.ts';
import { MatchPicker } from '../components/upload/MatchPicker.tsx';
import { RequestTargetSelect } from '../components/upload/RequestTargetSelect.tsx';
import { StatusBadge } from '../components/upload/StatusBadge.tsx';
import { TagEditor } from '../components/upload/TagEditor.tsx';
import { Alert, Button, Card, PageHeader, Spinner } from '../components/ui.tsx';
import {
  draftFromTags,
  draftsEqual,
  parseDraft,
  sampleFromDraft,
  type TagDraft,
} from '../lib/tagDraft.ts';
import { renderTemplate } from '../lib/template.ts';
import { extensionOf, formatBytes, formatDuration } from '../lib/uploadFiles.ts';

const librarySchema = z.object({ namingTemplate: z.string() });

/** The naming template is part of the settings, which only settings managers may read. */
function useNamingTemplate(enabled: boolean): string | null {
  const { data } = useQuery({
    queryKey: ['settings', 'library', 'naming'],
    enabled,
    retry: false,
    staleTime: 60_000,
    queryFn: () => api('/settings/library', { schema: librarySchema, redirectOn401: false }),
  });
  return data?.namingTemplate ?? null;
}

function Facts({ detail }: { detail: UploadDetail }) {
  const bits = [
    formatBytes(detail.size),
    detail.format?.toUpperCase(),
    detail.codec && detail.codec.toLowerCase() !== detail.format?.toLowerCase()
      ? detail.codec
      : null,
    detail.durationMs !== null ? formatDuration(detail.durationMs / 1000) : null,
    detail.bitrate ? `${String(Math.round(detail.bitrate / 1000))} kbps` : null,
    detail.uploaderName ? `uploaded by ${detail.uploaderName}` : null,
  ].filter(Boolean);
  return <p className="text-sm text-muted">{bits.join(' · ')}</p>;
}

interface ActionsApi {
  busy: boolean;
  error: string | null;
}

function RejectForm({
  onSubmit,
  onCancel,
  busy,
}: {
  onSubmit: (reason: string) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [reason, setReason] = useState('');
  return (
    <form
      className="space-y-3 rounded-xl border border-danger/40 bg-danger-soft p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (reason.trim() !== '') onSubmit(reason.trim());
      }}
    >
      <label className="block text-sm font-medium" htmlFor="reject-reason">
        Why is this being rejected?
      </label>
      <textarea
        id="reject-reason"
        value={reason}
        maxLength={500}
        rows={2}
        onChange={(event) => {
          setReason(event.target.value);
        }}
        className="block w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-base sm:text-sm"
      />
      <div className="flex gap-2">
        <Button type="submit" variant="danger" loading={busy} disabled={reason.trim() === ''}>
          Reject upload
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Keep it
        </Button>
      </div>
    </form>
  );
}

/** The editable part of the review: match, tags, request link, actions. */
function ReviewEditor({ detail }: { detail: UploadDetail }) {
  const { user, hasPermission } = useAuth();
  const isManager = hasPermission(Permission.MANAGE_UPLOADS);
  const isOwner = user?.id === detail.uploaderId;
  const canApprove = isManager || (isOwner && hasPermission(Permission.AUTO_APPROVE_UPLOAD));
  const naming = useNamingTemplate(hasPermission(Permission.MANAGE_SETTINGS));

  const candidates = detail.match?.candidates ?? [];
  const initialTags = detail.chosen ?? candidates[0]?.tags ?? null;
  const initialDraft = useMemo(
    () => draftFromTags(initialTags, detail.match?.existingTags),
    // The server's stored answer is the baseline; later polls must not wipe local edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail.id, detail.match?.analyzedAt],
  );
  const [baseline, setBaseline] = useState<TagDraft>(initialDraft);
  const [draft, setDraft] = useState<TagDraft>(initialDraft);
  const [candidateId, setCandidateId] = useState<string | null>(
    detail.match?.chosenCandidateId ?? candidates[0]?.id ?? null,
  );
  const [targetId, setTargetId] = useState<string | null>(detail.targetRequestId);
  const [shown, setShown] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const parsed = parseDraft(draft);
  const errors = shown && !parsed.ok ? parsed.errors : {};
  const dirty =
    !draftsEqual(draft, baseline) || targetId !== detail.targetRequestId || detail.chosen === null;

  const save = useUploadAction((body: ReviewBody) => uploadActions.save(detail.id, body));
  const approve = useUploadAction(() => uploadActions.approve(detail.id));
  const reject = useUploadAction((reason: string) => uploadActions.reject(detail.id, reason));
  const reanalyze = useUploadAction(() => uploadActions.reanalyze(detail.id));

  const actions: ActionsApi = {
    busy: save.isPending || approve.isPending || reject.isPending || reanalyze.isPending,
    error:
      [save, approve, reject, reanalyze]
        .map((m) => (m.isError ? errorMessage(m.error) : null))
        .find(Boolean) ?? null,
  };

  const saveNow = async (): Promise<boolean> => {
    setShown(true);
    setMessage(null);
    if (!parsed.ok) return false;
    await save.mutateAsync({
      tags: parsed.tags,
      ...(candidateId ? { candidateId } : {}),
      targetRequestId: targetId,
    });
    setBaseline(draft);
    return true;
  };

  const onSave = () => {
    void saveNow()
      .then((ok) => {
        if (ok) setMessage('Review saved.');
      })
      .catch(() => undefined);
  };
  const onApprove = () => {
    void (async () => {
      if (dirty && !(await saveNow())) return;
      setShown(true);
      if (!parsed.ok) return;
      await approve.mutateAsync();
    })().catch(() => undefined);
  };

  const pick = (c: MatchCandidate) => {
    setCandidateId(c.id);
    setDraft(draftFromTags(c.tags));
    setShown(false);
    setMessage(null);
  };

  const preview =
    naming !== null && parsed.ok
      ? renderTemplate(naming, sampleFromDraft(draft, extensionOf(detail.originalName) || 'flac'))
      : null;

  return (
    <div className="space-y-6">
      <section aria-labelledby="matches">
        <h2 id="matches" className="mb-2 text-base font-semibold">
          Matches
        </h2>
        <MatchPicker
          candidates={candidates}
          selectedId={candidateId}
          onSelect={pick}
          fileDurationMs={detail.durationMs}
        />
      </section>

      <section aria-labelledby="tags">
        <h2 id="tags" className="mb-2 text-base font-semibold">
          Tags
        </h2>
        <Card className="p-4">
          <TagEditor draft={draft} onChange={setDraft} errors={errors} />
        </Card>
      </section>

      {preview !== null && (
        <section aria-labelledby="dest">
          <h2 id="dest" className="mb-2 text-base font-semibold">
            Destination
          </h2>
          <p
            data-testid="destination-preview"
            className="rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs break-all"
          >
            {preview}
          </p>
        </section>
      )}

      <RequestTargetSelect value={targetId} onChange={setTargetId} />

      {actions.error && <Alert>{actions.error}</Alert>}
      {message && <Alert tone="success">{message}</Alert>}
      {shown && !parsed.ok && (
        <Alert>
          Some tags need attention: {Object.values(parsed.errors).length} problem(s) above.
        </Alert>
      )}
      {!canApprove && (
        <Alert tone="info">
          You can fix the tags and save. An administrator approves the import.
        </Alert>
      )}

      {rejecting ? (
        <RejectForm
          busy={reject.isPending}
          onCancel={() => {
            setRejecting(false);
          }}
          onSubmit={(reason) => {
            reject.mutate(reason);
          }}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={onSave}
            loading={save.isPending}
            disabled={actions.busy}
          >
            <Save className="size-4" aria-hidden />
            Save review
          </Button>
          {canApprove && (
            <Button onClick={onApprove} loading={approve.isPending} disabled={actions.busy}>
              <Check className="size-4" aria-hidden />
              Approve
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={actions.busy}
            onClick={() => {
              reanalyze.mutate();
            }}
          >
            <RefreshCw className="size-4" aria-hidden />
            Reanalyze
          </Button>
          <Button
            variant="ghost"
            className="text-danger"
            disabled={actions.busy}
            onClick={() => {
              setRejecting(true);
            }}
          >
            <X className="size-4" aria-hidden />
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}

function DuplicateBanner({ detail }: { detail: UploadDetail }) {
  const [reason, setReason] = useState('');
  const keep = useUploadAction(() => uploadActions.keep(detail.id, reason.trim() || undefined));
  const reject = useUploadAction((r: string) => uploadActions.reject(detail.id, r));
  return (
    <Alert tone="info" className="border-warn/40 bg-warn-soft text-fg">
      <p className="font-medium">This looks like a duplicate</p>
      <p className="mt-0.5">
        {detail.match?.duplicate?.message ?? 'It is already in the library.'}
      </p>
      {detail.canKeep ? (
        <div className="mt-3 space-y-2">
          <input
            aria-label="Reason for keeping it (optional)"
            placeholder="Why keep it? (optional)"
            value={reason}
            maxLength={500}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            className="block min-h-10 w-full rounded-lg border border-line bg-surface-2 px-3 text-base sm:text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              loading={keep.isPending}
              onClick={() => {
                keep.mutate();
              }}
            >
              Keep as alternate version
            </Button>
            <Button
              variant="ghost"
              className="text-danger"
              loading={reject.isPending}
              onClick={() => {
                reject.mutate('Duplicate of a file that is already in the library');
              }}
            >
              Discard it
            </Button>
          </div>
          {(keep.isError || reject.isError) && (
            <p role="alert" className="text-sm text-danger">
              {errorMessage(keep.error ?? reject.error)}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted">
          Only an administrator can keep a duplicate as an alternate version.
        </p>
      )}
    </Alert>
  );
}

function ImportedSummary({ detail }: { detail: UploadDetail }) {
  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-base font-semibold">In the library</h2>
      {detail.libraryPath ? (
        <p
          data-testid="library-path"
          className="rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs break-all"
        >
          {detail.libraryPath}
        </p>
      ) : (
        <p className="text-sm text-muted">The file was filed into the library.</p>
      )}
      {detail.chosen && (
        <p className="text-sm text-muted">
          {detail.chosen.artist} - {detail.chosen.title} ({detail.chosen.album})
        </p>
      )}
    </Card>
  );
}

function FailedPanel({ detail }: { detail: UploadDetail }) {
  const { hasPermission } = useAuth();
  const retry = useUploadAction(() => uploadActions.retryImport(detail.id));
  const reanalyze = useUploadAction(() => uploadActions.reanalyze(detail.id));
  const reject = useUploadAction((r: string) => uploadActions.reject(detail.id, r));
  const canRetry = hasPermission(Permission.MANAGE_UPLOADS) && detail.chosen !== null;
  return (
    <div className="space-y-3">
      <Alert>{detail.error ?? 'Something went wrong with this upload.'}</Alert>
      <div className="flex flex-wrap gap-2">
        {canRetry && (
          <Button
            loading={retry.isPending}
            onClick={() => {
              retry.mutate();
            }}
          >
            <RotateCw className="size-4" aria-hidden />
            Retry import
          </Button>
        )}
        <Button
          variant="secondary"
          loading={reanalyze.isPending}
          onClick={() => {
            reanalyze.mutate();
          }}
        >
          <RefreshCw className="size-4" aria-hidden />
          Reanalyze
        </Button>
        <Button
          variant="ghost"
          className="text-danger"
          loading={reject.isPending}
          onClick={() => {
            reject.mutate('Failed and discarded');
          }}
        >
          Discard
        </Button>
      </div>
      {[retry, reanalyze, reject].map(
        (m, i) =>
          m.isError && (
            <p key={i} role="alert" className="text-sm text-danger">
              {errorMessage(m.error)}
            </p>
          ),
      )}
    </div>
  );
}

export function UploadReviewPage({ id }: { id: string }) {
  const query = useQuery(uploadDetailQuery(id));

  if (query.isPending) return <Spinner label="Loading upload" />;
  if (query.isError) {
    return (
      <>
        <PageHeader title="Upload" />
        <Alert>{errorMessage(query.error)}</Alert>
        <p className="mt-4 text-sm">
          <Link to="/uploads" className="text-accent hover:underline">
            Back to uploads
          </Link>
        </p>
      </>
    );
  }

  const detail = query.data;
  const group = detail.match?.group ?? null;
  return (
    <>
      <p className="mb-2 text-sm">
        <Link to="/uploads" className="text-muted hover:text-fg">
          Uploads
        </Link>
      </p>
      <header className="mb-6 space-y-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 text-2xl font-semibold tracking-tight break-all">
            {detail.originalName}
          </h1>
          <StatusBadge status={detail.status} />
        </div>
        <Facts detail={detail} />
        {detail.batchId && group && (
          <p className="text-sm">
            Part of the album <span className="font-medium">{group.title}</span>.{' '}
            <Link
              to="/uploads/batch/$batchId"
              params={{ batchId: detail.batchId }}
              className="font-medium text-accent hover:underline"
            >
              Review the whole album
            </Link>
          </p>
        )}
      </header>

      <div className="space-y-6">
        {isTransient(detail.status) && (
          <Alert tone="info">
            {detail.status === 'IMPORTING' || detail.status === 'APPROVED'
              ? 'Importing into the library. This page updates by itself.'
              : 'Analyzing the file. This page updates by itself.'}
          </Alert>
        )}
        {detail.status === 'DUPLICATE' && <DuplicateBanner detail={detail} />}
        {detail.status === 'NEEDS_REVIEW' && <ReviewEditor detail={detail} />}
        {detail.status === 'IMPORTED' && <ImportedSummary detail={detail} />}
        {detail.status === 'FAILED' && <FailedPanel detail={detail} />}
        {detail.status === 'REJECTED' && (
          <Alert>{detail.error ?? 'This upload was rejected.'}</Alert>
        )}
      </div>
    </>
  );
}
