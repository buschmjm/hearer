import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useState } from 'react';
import { useAuth } from '../api/auth.ts';
import { requestTargetsQuery, uploadConfigQuery, uploadListQuery } from '../api/uploads.ts';
import { RequestTargetSelect } from '../components/upload/RequestTargetSelect.tsx';
import { Dropzone } from '../components/upload/Dropzone.tsx';
import { UploadRow } from '../components/upload/UploadRows.tsx';
import { useUploadItems } from '../components/upload/useUploadManager.ts';
import { Alert, Button, Card, PageHeader, Spinner } from '../components/ui.tsx';
import { readTosAccepted, writeTosAccepted } from '../lib/tos.ts';
import { uploadManager } from '../lib/uploadManager.ts';

export function TosNotice({
  accepted,
  onChange,
}: {
  accepted: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Before you upload</h2>
      <p className="mt-1 text-sm text-muted">
        Only upload music you have the right to store: your own recordings, music you bought or
        ripped from media you own, or files you are licensed to keep. Do not upload content you do
        not own. Uploads are visible to the administrators of this server, and files that are not
        music, or that you may not store, will be removed.
      </p>
      <div className="mt-3 flex items-start gap-2.5">
        <input
          id={id}
          type="checkbox"
          checked={accepted}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
          className="mt-0.5 size-4 accent-[var(--accent)]"
        />
        <label htmlFor={id} className="text-sm">
          I have the right to store the music I upload.
        </label>
      </div>
    </Card>
  );
}

export function UploadPage() {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const config = useQuery(uploadConfigQuery());
  const targets = useQuery(requestTargetsQuery());
  const items = useUploadItems();
  const [tosChoice, setTos] = useState<boolean | null>(null);
  const tos = tosChoice ?? readTosAccepted(userId);
  const [target, setTarget] = useState('');
  const unfinished = useQuery(
    uploadListQuery({ all: false, status: 'RECEIVING', limit: 50, offset: 0 }),
  );

  useEffect(() => {
    if (config.data) uploadManager.configure(config.data);
  }, [config.data]);

  const waiting = unfinished.data?.total ?? 0;
  const running = items.some((i) => i.state === 'uploading' || i.state === 'queued');
  const batches = new Map<string, number>();
  for (const i of items) {
    if (i.state === 'finished') batches.set(i.batchId, (batches.get(i.batchId) ?? 0) + 1);
  }
  const multi = [...batches].filter(([, count]) => count > 1);
  const requests = targets.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Upload"
        subtitle="Add music to the library. Files are matched against MusicBrainz and checked before they are filed."
      />
      <div className="space-y-4">
        <TosNotice
          accepted={tos}
          onChange={(value) => {
            setTos(value);
            writeTosAccepted(userId, value);
          }}
        />

        {requests.length > 0 && (
          <Card className="p-4">
            <RequestTargetSelect
              value={target === '' ? null : target}
              onChange={(id) => {
                setTarget(id ?? '');
              }}
            />
            <p className="mt-1.5 text-xs text-muted">
              Files you drop below are linked to this request once they are imported.
            </p>
          </Card>
        )}

        {config.isPending && <Spinner label="Loading upload limits" />}
        {config.isError && (
          <Alert>Could not load the upload limits. Reload the page to retry.</Alert>
        )}
        {config.data && (
          <Dropzone
            config={config.data}
            manager={uploadManager}
            targetRequestId={target === '' ? null : target}
            disabled={!tos}
            disabledHint="Tick the box above to enable uploads."
          />
        )}

        {waiting > 0 && !running && (
          <Alert tone="info">
            {waiting === 1
              ? 'One earlier upload did not finish.'
              : `${String(waiting)} earlier uploads did not finish.`}{' '}
            Drop the same {waiting === 1 ? 'file' : 'files'} again and they will carry on where they
            stopped.
          </Alert>
        )}

        {items.length > 0 && (
          <section aria-label="Uploads in this session">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">This session</h2>
              <Button
                variant="ghost"
                className="min-h-8 px-2 text-xs"
                onClick={() => {
                  uploadManager.clearDone();
                }}
              >
                Clear finished
              </Button>
            </div>
            <ul className="space-y-2">
              {items.map((item) => (
                <UploadRow key={item.id} item={item} manager={uploadManager} />
              ))}
            </ul>
            {multi.map(([batchId, count]) => (
              <p key={batchId} className="mt-3 text-sm">
                <Link
                  to="/uploads/batch/$batchId"
                  params={{ batchId }}
                  className="font-medium text-accent hover:underline"
                >
                  Review these {count} files together
                </Link>
              </p>
            ))}
            <p className="mt-3 text-sm text-muted">
              <Link to="/uploads" className="text-accent hover:underline">
                See all your uploads
              </Link>
            </p>
          </section>
        )}
      </div>
    </>
  );
}
