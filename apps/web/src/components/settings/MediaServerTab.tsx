import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, errorMessage } from '../../api/client.ts';
import {
  libraryStatusQuery,
  useLibrarySync,
  useTestMediaServerConfig,
  type LibraryStatus,
} from '../../api/settings.ts';
import { jobDtoSchema, type MediaServerTestResult } from '@hearer/shared';
import { toast } from '../../lib/toast.ts';
import { Section } from '../controls.tsx';
import { Alert, Button, Field } from '../ui.tsx';
import { DraftGate, DraftSecret, DraftText, SaveBar } from './parts.tsx';
import { useSectionDraft, type SectionDraft } from './useSectionDraft.ts';

interface Mapping {
  serverPath: string;
  localPath: string;
}

function MappingsEditor({ draft }: { draft: SectionDraft }) {
  const raw = draft.get('pathMappings');
  const rows: Mapping[] = Array.isArray(raw) ? (raw as Mapping[]) : [];
  const write = (next: Mapping[]) => {
    draft.set('pathMappings', next);
  };
  return (
    <div>
      <p className="mb-1 text-sm font-medium">Path mappings</p>
      <p className="mb-3 text-xs text-muted">
        Only needed when the media server sees the music under a different path than Hearer does
        (for example <code>/data/music</code> there, <code>/music</code> here).
      </p>
      <div className="space-y-3">
        {rows.map((row, index) => (
          <div key={index} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field
              className="min-w-0 flex-1"
              label={`Media server path ${String(index + 1)}`}
              placeholder="/data/music"
              spellCheck={false}
              value={row.serverPath}
              error={draft.errors[`pathMappings.${String(index)}.serverPath`]}
              onChange={(e) => {
                write(rows.map((r, i) => (i === index ? { ...r, serverPath: e.target.value } : r)));
              }}
            />
            <Field
              className="min-w-0 flex-1"
              label={`Hearer path ${String(index + 1)}`}
              placeholder="/music"
              spellCheck={false}
              value={row.localPath}
              error={draft.errors[`pathMappings.${String(index)}.localPath`]}
              onChange={(e) => {
                write(rows.map((r, i) => (i === index ? { ...r, localPath: e.target.value } : r)));
              }}
            />
            <Button
              variant="ghost"
              aria-label={`Remove mapping ${String(index + 1)}`}
              onClick={() => {
                write(rows.filter((_, i) => i !== index));
              }}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          onClick={() => {
            write([...rows, { serverPath: '', localPath: '' }]);
          }}
        >
          <Plus className="size-4" aria-hidden /> Add mapping
        </Button>
      </div>
    </div>
  );
}

const when = (ms: number | null): string => (ms === null ? 'never' : new Date(ms).toLocaleString());

function LibraryIndex({ status }: { status: LibraryStatus }) {
  const qc = useQueryClient();
  const sync = useLibrarySync();
  const [running, setRunning] = useState<'incremental' | 'full'>();
  const { state, counts } = status;

  /** Follow the queued job until it finishes, then refresh the numbers. */
  const follow = async (jobId: number, mode: 'incremental' | 'full') => {
    setRunning(mode);
    try {
      for (let i = 0; i < 600; i++) {
        const job = await api(`/jobs/${String(jobId)}`, { schema: jobDtoSchema });
        if (job.status === 'succeeded' || job.status === 'dead' || job.status === 'failed') {
          if (job.status === 'succeeded') toast.success('Library sync finished.');
          else toast.error(job.lastError?.split('\n')[0] ?? 'Library sync failed.');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (err) {
      if (!(err instanceof ApiError)) toast.error(errorMessage(err));
    } finally {
      setRunning(undefined);
      void qc.invalidateQueries({ queryKey: libraryStatusQuery().queryKey });
    }
  };

  const start = (mode: 'incremental' | 'full') => {
    sync.mutate(mode, {
      onSuccess: ({ jobId }) => {
        toast.info(mode === 'full' ? 'Full sync queued.' : 'Sync queued.');
        void follow(jobId, mode);
      },
      onError: (err) => {
        toast.error(errorMessage(err));
      },
    });
  };

  return (
    <Section
      title="Library index"
      description="Hearer keeps a copy of the media server's music index to show what is already available."
      actions={
        <div className="flex gap-2">
          <Button
            variant="secondary"
            disabled={!status.configured || running !== undefined || sync.isPending}
            loading={running === 'incremental'}
            onClick={() => {
              start('incremental');
            }}
          >
            {running !== 'incremental' && <RefreshCw className="size-4" aria-hidden />} Sync now
          </Button>
          <Button
            variant="secondary"
            disabled={!status.configured || running !== undefined || sync.isPending}
            loading={running === 'full'}
            onClick={() => {
              start('full');
            }}
          >
            Full sync
          </Button>
        </div>
      }
    >
      {!status.configured && (
        <Alert tone="info">Save a media server URL and API key to enable syncing.</Alert>
      )}
      <dl className="grid grid-cols-3 gap-3 text-center">
        {(
          [
            ['Artists', counts.artist],
            ['Albums', counts.album],
            ['Tracks', counts.track],
          ] as const
        ).map(([label, n]) => (
          <div key={label} className="rounded-lg border border-line bg-surface-2 px-2 py-3">
            <dd className="text-xl font-semibold">{n.toLocaleString()}</dd>
            <dt className="text-xs text-muted">{label}</dt>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted">
        Last quick sync: {when(state.lastIncrementalAt)}. Last full sync: {when(state.lastFullAt)}.
        {state.lastCounts && (
          <>
            {' '}
            The last run saw {state.lastCounts.seen.toLocaleString()} items and removed{' '}
            {state.lastCounts.removed.toLocaleString()}.
          </>
        )}
      </p>
      {state.lastError && <Alert>Last sync failed: {state.lastError}</Alert>}
    </Section>
  );
}

export function MediaServerTab() {
  const draft = useSectionDraft('mediaServer');
  const status = useQuery(libraryStatusQuery());
  const test = useTestMediaServerConfig();
  const [result, setResult] = useState<MediaServerTestResult>();
  const [testError, setTestError] = useState<string>();

  const runTest = () => {
    setResult(undefined);
    setTestError(undefined);
    test.mutate(draft.value, {
      onSuccess: setResult,
      onError: (err) => {
        setTestError(errorMessage(err));
      },
    });
  };

  return (
    <DraftGate draft={draft}>
      <div className="space-y-5">
        <Section title="Jellyfin" description="Used for sign-in, the library index and rescans.">
          <DraftText
            draft={draft}
            path="url"
            label="Server URL"
            type="url"
            placeholder="http://jellyfin:8096"
            hint="The address Hearer itself uses to reach Jellyfin."
          />
          <DraftSecret
            draft={draft}
            path="apiKey"
            label="API key"
            hint="Create one in Jellyfin under Dashboard, API Keys."
          />
          <DraftText
            draft={draft}
            path="externalUrl"
            label="External URL"
            type="url"
            placeholder="https://jellyfin.example.com"
            hint="Optional. The address your users open, for “Open in Jellyfin” links."
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" loading={test.isPending} onClick={runTest}>
              Test connection
            </Button>
            <span className="text-xs text-muted">Tests the values above without saving them.</span>
          </div>
          {testError && <Alert>{testError}</Alert>}
          {result?.ok && result.server && (
            <Alert tone="success">
              <span className="flex items-center gap-1.5 font-medium">
                <CheckCircle2 className="size-4" aria-hidden /> Connected to {result.server.name}{' '}
                (Jellyfin {result.server.version})
              </span>
              {result.server.warning && <span className="mt-1 block">{result.server.warning}</span>}
            </Alert>
          )}
          {result && !result.ok && (
            <Alert>{result.error?.message ?? 'The connection failed.'}</Alert>
          )}
        </Section>

        <Section title="Paths">
          <MappingsEditor draft={draft} />
        </Section>

        {status.data && <LibraryIndex status={status.data} />}

        <SaveBar
          dirty={draft.dirty}
          saving={draft.saving}
          error={draft.formError}
          onSave={() => void draft.save()}
          onCancel={draft.reset}
        />
      </div>
    </DraftGate>
  );
}
