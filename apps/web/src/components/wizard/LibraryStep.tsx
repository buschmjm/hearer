import { str, zodFieldErrors } from '../../lib/values.ts';
import { SETTINGS_CATALOG } from '@hearer/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { errorMessage } from '../../api/client.ts';
import {
  sectionQuery,
  setupStatusQuery,
  useSaveSection,
  type SectionValues,
} from '../../api/setup.ts';
import {
  SAMPLE_ALBUM_TRACK,
  TEMPLATE_VARIABLES,
  renderTemplate,
  validateTemplate,
} from '../../lib/template.ts';
import { Alert, Button, Field, Spinner } from '../ui.tsx';
import { StepActions, type StepProps } from './shared.tsx';

function DirectoryRow({
  label,
  check,
}: {
  label: string;
  check: { path: string; exists: boolean; writable: boolean; error?: string | undefined };
}) {
  const Icon = check.writable ? CheckCircle2 : XCircle;
  return (
    <li className="flex items-start gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
      <Icon
        className={
          check.writable
            ? 'mt-0.5 size-5 shrink-0 text-success'
            : 'mt-0.5 size-5 shrink-0 text-danger'
        }
        aria-hidden
      />
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {label}{' '}
          <span className="font-normal text-muted">
            {check.writable ? 'is ready' : 'is not ready'}
          </span>
        </p>
        <p className="font-mono text-xs break-all text-muted">{check.path}</p>
        {check.error && <p className="mt-0.5 text-xs text-danger">{check.error}</p>}
      </div>
    </li>
  );
}

function LibraryForm({
  library,
  uploads,
  onNext,
  onBack,
}: StepProps & { library: SectionValues; uploads: SectionValues }) {
  const status = useQuery(setupStatusQuery());
  const saveLibrary = useSaveSection('library');
  const saveUploads = useSaveSection('uploads');
  const [template, setTemplate] = useState(str(library.namingTemplate));
  const [singles, setSingles] = useState(str(library.singlesTemplate));
  const [maxMb, setMaxMb] = useState(str(uploads.maxFileSizeMb, '2048'));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  const dirs = status.data?.directories;
  const dirsReady = dirs?.library.writable === true && dirs.staging.writable;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    const lib = SETTINGS_CATALOG.library.schema.safeParse({
      namingTemplate: template,
      singlesTemplate: singles,
    });
    if (!lib.success) Object.assign(next, zodFieldErrors(lib.error.issues));
    const tProblems = validateTemplate(template);
    if (tProblems[0]) next.namingTemplate = tProblems[0];
    const sProblems = validateTemplate(singles);
    if (sProblems[0]) next.singlesTemplate = sProblems[0];
    const size = Number(maxMb);
    const up = SETTINGS_CATALOG.uploads.schema.safeParse({ ...uploads, maxFileSizeMb: size });
    if (!up.success || !Number.isInteger(size)) {
      next.maxFileSizeMb = 'Enter a whole number of megabytes, 1 or more.';
    }
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await saveLibrary.mutateAsync({ namingTemplate: template, singlesTemplate: singles });
      await saveUploads.mutateAsync({ maxFileSizeMb: size });
      onNext();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        void submit(e);
      }}
      noValidate
    >
      <h2 className="text-lg font-semibold">Library and uploads</h2>
      <p className="mt-1 mb-5 text-sm text-muted">
        Where music is filed, and how uploaded files are named.
      </p>

      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-medium">Folders</h3>
        <Button
          variant="ghost"
          className="min-h-8 px-2"
          loading={status.isFetching}
          onClick={() => {
            void status.refetch();
          }}
        >
          {!status.isFetching && <RefreshCw className="size-4" aria-hidden />} Check again
        </Button>
      </div>
      {dirs ? (
        <ul className="space-y-2">
          <DirectoryRow label="Music library" check={dirs.library} />
          <DirectoryRow label="Staging folder" check={dirs.staging} />
        </ul>
      ) : (
        <Spinner />
      )}
      {dirs && !dirsReady && (
        <Alert tone="info" className="mt-3">
          Both folders must exist and be writable by the server. Fix the mounts or permissions
          (MUSIC_DIR and STAGING_DIR), then check again.
        </Alert>
      )}

      <div className="mt-6 space-y-4">
        <Field
          label="Naming template"
          className="font-mono"
          spellCheck={false}
          autoCapitalize="none"
          value={template}
          onChange={(e) => {
            setTemplate(e.target.value);
          }}
          error={errors.namingTemplate}
        />
        <div className="rounded-lg border border-dashed border-line px-3 py-2.5" aria-live="polite">
          <p className="text-xs text-muted">Preview</p>
          <p data-testid="template-preview" className="font-mono text-sm break-all">
            {renderTemplate(template, SAMPLE_ALBUM_TRACK)}
          </p>
        </div>
        <Field
          label="Template for singles"
          className="font-mono"
          spellCheck={false}
          autoCapitalize="none"
          hint="Used for tracks that match no album."
          value={singles}
          onChange={(e) => {
            setSingles(e.target.value);
          }}
          error={errors.singlesTemplate}
        />
        <p data-testid="singles-preview" className="-mt-2 font-mono text-xs break-all text-muted">
          {renderTemplate(singles, SAMPLE_ALBUM_TRACK)}
        </p>
        <details className="text-xs text-muted">
          <summary className="cursor-pointer text-sm">Template variables</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {Object.entries(TEMPLATE_VARIABLES).map(([name, what]) => (
              <div key={name} className="contents">
                <dt className="font-mono text-fg">{`{${name}}`}</dt>
                <dd>{what}</dd>
              </div>
            ))}
            <dt className="font-mono text-fg">{'{track:02}'}</dt>
            <dd>Zero-padded to 2 digits</dd>
            <dt className="font-mono text-fg">{'{disc:?}'}</dt>
            <dd>Disc number and a dash, only on multi-disc releases</dd>
          </dl>
        </details>
        <Field
          label="Maximum upload size (MB)"
          type="number"
          inputMode="numeric"
          min={1}
          value={maxMb}
          onChange={(e) => {
            setMaxMb(e.target.value);
          }}
          error={errors.maxFileSizeMb}
          hint="Per file. Uploads are sent in small chunks, so proxies with body limits are fine."
        />
      </div>
      {saveError && <Alert className="mt-4">{saveError}</Alert>}
      <StepActions>
        {onBack ? (
          <Button variant="secondary" onClick={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" loading={saving} disabled={!dirsReady}>
          Continue
        </Button>
      </StepActions>
    </form>
  );
}

export function LibraryStep(props: StepProps) {
  const [library, uploads] = useQueries({
    queries: [sectionQuery('library'), sectionQuery('uploads')],
  });
  if (library.isPending || uploads.isPending) return <Spinner />;
  if (library.isError || uploads.isError) {
    return <Alert>{errorMessage(library.error ?? uploads.error)}</Alert>;
  }
  return <LibraryForm library={library.data} uploads={uploads.data} {...props} />;
}
