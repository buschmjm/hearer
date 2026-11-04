import { str } from '../../lib/values.ts';
import { useState, type SyntheticEvent } from 'react';
import { z } from 'zod';
import { ApiError, errorMessage } from '../../api/client.ts';
import { useSaveSection, useTestMediaServer, type SectionValues } from '../../api/setup.ts';
import { Alert, Button, Field } from '../ui.tsx';
import { SectionLoader, StepActions, type StepProps } from './shared.tsx';

const URL_MESSAGE = 'Enter a full URL, for example http://jellyfin:8096';
const urlSchema = z.url({ message: URL_MESSAGE });

function MediaServerForm({ initial, onNext, onBack }: StepProps & { initial: SectionValues }) {
  const save = useSaveSection('mediaServer');
  const test = useTestMediaServer();
  const [url, setUrl] = useState(str(initial.url));
  const [apiKey, setApiKey] = useState(str(initial.apiKey));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!urlSchema.safeParse(url.trim()).success) next.url = URL_MESSAGE;
    if (apiKey.trim() === '') next.apiKey = 'Enter an API key (Jellyfin dashboard, API keys).';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const runTest = () => {
    if (!validate()) return;
    test.mutate({ url: url.trim(), apiKey: apiKey.trim() });
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!validate()) return;
    save.mutate({ url: url.trim(), apiKey: apiKey.trim() }, { onSuccess: onNext });
  };

  const result = test.data;
  const saveError =
    save.error instanceof ApiError && save.error.code === 'media_server_test_failed'
      ? save.error.message
      : save.error
        ? errorMessage(save.error)
        : undefined;

  return (
    <form onSubmit={submit} noValidate>
      <h2 className="text-lg font-semibold">Media server</h2>
      <p className="mt-1 mb-5 text-sm text-muted">
        Connect Jellyfin so Hearer can see your library and ask it to rescan after imports.
      </p>
      <div className="space-y-4">
        <Field
          label="Jellyfin URL"
          type="url"
          inputMode="url"
          placeholder="http://jellyfin:8096"
          autoCapitalize="none"
          spellCheck={false}
          hint="The address Hearer's server uses to reach Jellyfin."
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
          }}
          error={errors.url}
        />
        <Field
          label="API key"
          type="password"
          autoComplete="off"
          hint="Create one in Jellyfin under Dashboard, API keys. A saved key shows as asterisks."
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
          }}
          error={errors.apiKey}
        />
        <div>
          <Button variant="secondary" onClick={runTest} loading={test.isPending}>
            Test connection
          </Button>
        </div>
        {result?.ok && result.server && (
          <Alert tone="success">
            Connected to {result.server.name} (Jellyfin {result.server.version}).
            {result.server.warning ? ` ${result.server.warning}` : ''}
          </Alert>
        )}
        {result && !result.ok && (
          <Alert>{result.error?.message ?? 'The connection test failed.'}</Alert>
        )}
        {test.error && <Alert>{errorMessage(test.error)}</Alert>}
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
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button variant="ghost" onClick={onNext}>
            Skip for now
          </Button>
          <Button type="submit" loading={save.isPending}>
            Save and continue
          </Button>
        </div>
      </StepActions>
    </form>
  );
}

export function MediaServerStep(props: StepProps) {
  return (
    <SectionLoader section="mediaServer">
      {(values) => <MediaServerForm initial={values} {...props} />}
    </SectionLoader>
  );
}
