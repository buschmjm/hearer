import { num, str } from '../../lib/values.ts';
import { permissionNames } from '@hearer/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useAuth } from '../../api/auth.ts';
import { errorMessage } from '../../api/client.ts';
import { sectionQuery, setupStatusQuery, useCompleteSetup } from '../../api/setup.ts';
import { renderTemplate } from '../../lib/template.ts';
import { Alert, Button, Spinner } from '../ui.tsx';
import { StepActions } from './shared.tsx';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-sm text-muted sm:w-44">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

export function ReviewStep({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { user } = useAuth();
  const status = useQuery(setupStatusQuery());
  const [general, mediaServer, library, uploads] = useQueries({
    queries: [
      sectionQuery('general'),
      sectionQuery('mediaServer'),
      sectionQuery('library'),
      sectionQuery('uploads'),
    ],
  });
  const complete = useCompleteSetup();

  if ([general, mediaServer, library, uploads].some((q) => q.isPending) || status.isPending) {
    return <Spinner />;
  }
  const loadError = [general, mediaServer, library, uploads].find((q) => q.isError)?.error;
  if (loadError) return <Alert>{errorMessage(loadError)}</Alert>;
  const g = general.data ?? {};
  const m = mediaServer.data ?? {};
  const l = library.data ?? {};
  const u = uploads.data ?? {};
  const dirs = status.data?.directories;
  const ready = dirs ? dirs.library.writable && dirs.staging.writable : false;
  const perms = permissionNames(num(g.defaultPermissions));

  return (
    <div>
      <h2 className="text-lg font-semibold">Review and finish</h2>
      <p className="mt-1 mb-4 text-sm text-muted">
        Check everything, then finish. You can change all of this later.
      </p>
      <dl className="divide-y divide-line rounded-xl border border-line px-4">
        <Row label="Administrator">{user?.username ?? '-'}</Row>
        <Row label="Application title">{str(g.appTitle)}</Row>
        <Row label="Application URL">{str(g.applicationUrl) || 'Not set'}</Row>
        <Row label="Default permissions">{perms.length ? perms.join(', ') : 'None'}</Row>
        <Row label="Media server">
          {str(m.url) ? `Jellyfin at ${str(m.url)}` : 'Not configured (you can add it later)'}
        </Row>
        <Row label="Library folder">{dirs?.library.path ?? '-'}</Row>
        <Row label="Staging folder">{dirs?.staging.path ?? '-'}</Row>
        <Row label="Naming template">
          <span className="font-mono">{str(l.namingTemplate)}</span>
          <span className="block font-mono text-xs text-muted">
            {renderTemplate(str(l.namingTemplate))}
          </span>
        </Row>
        <Row label="Max upload size">{str(u.maxFileSizeMb)} MB</Row>
      </dl>
      {!ready && (
        <Alert className="mt-4">
          The library and staging folders are not both writable yet. Go back and check them.
        </Alert>
      )}
      {complete.error && <Alert className="mt-4">{errorMessage(complete.error)}</Alert>}
      <StepActions>
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button
          loading={complete.isPending}
          disabled={!ready}
          onClick={() => {
            complete.mutate(undefined, { onSuccess: onDone });
          }}
        >
          Finish setup
        </Button>
      </StepActions>
    </div>
  );
}
