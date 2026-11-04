import { str, num, zodFieldErrors } from '../../lib/values.ts';
import { SETTINGS_CATALOG } from '@hearer/shared';
import { useState, type SyntheticEvent } from 'react';
import { ApiError, errorMessage } from '../../api/client.ts';
import { useSaveSection, type SectionValues } from '../../api/setup.ts';
import { DEFAULT_PERMISSION_CHOICES } from '../../lib/permissionChoices.ts';
import { Alert, Button, Field } from '../ui.tsx';
import { SectionLoader, StepActions, type StepProps } from './shared.tsx';

function GeneralForm({ initial, onNext, onBack }: StepProps & { initial: SectionValues }) {
  const save = useSaveSection('general');
  const [title, setTitle] = useState(str(initial.appTitle, 'Hearer'));
  const [url, setUrl] = useState(str(initial.applicationUrl));
  const [perms, setPerms] = useState(num(initial.defaultPermissions));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const values = { appTitle: title, applicationUrl: url.trim(), defaultPermissions: perms };
    const parsed = SETTINGS_CATALOG.general.schema.safeParse({ ...initial, ...values });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    save.mutate({ ...values, appTitle: title.trim() }, { onSuccess: onNext });
  };

  const serverErrors = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const err = (key: string) => errors[key] ?? serverErrors[key];

  return (
    <form onSubmit={submit} noValidate>
      <h2 className="text-lg font-semibold">General</h2>
      <p className="mt-1 mb-5 text-sm text-muted">
        How the app presents itself and what new users may do.
      </p>
      <div className="space-y-4">
        <Field
          label="Application title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
          }}
          error={err('appTitle')}
        />
        <Field
          label="Application URL (optional)"
          type="url"
          inputMode="url"
          placeholder="https://music.example.com"
          hint="The address people use to reach this app. Used in links and single sign-on redirects."
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
          }}
          error={err('applicationUrl')}
        />
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Default permissions for new users</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {DEFAULT_PERMISSION_CHOICES.map(({ bit, label, hint }) => (
              <label
                key={bit}
                className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5 has-checked:border-accent"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-(--accent)"
                  checked={(perms & bit) === bit}
                  onChange={(e) => {
                    setPerms((p) => (e.target.checked ? p | bit : p & ~bit));
                  }}
                />
                <span>
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block text-xs text-muted">{hint}</span>
                </span>
              </label>
            ))}
          </div>
          {err('defaultPermissions') && (
            <p role="alert" className="mt-1.5 text-xs text-danger">
              {err('defaultPermissions')}
            </p>
          )}
        </fieldset>
      </div>
      {save.error && !Object.keys(serverErrors).length && (
        <Alert className="mt-4">{errorMessage(save.error)}</Alert>
      )}
      <StepActions>
        {onBack ? (
          <Button variant="secondary" onClick={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" loading={save.isPending}>
          Continue
        </Button>
      </StepActions>
    </form>
  );
}

export function GeneralStep(props: StepProps) {
  return (
    <SectionLoader section="general">
      {(values) => <GeneralForm initial={values} {...props} />}
    </SectionLoader>
  );
}
