import { zodFieldErrors } from '../../lib/values.ts';
import { setupAdminRequestSchema } from '@hearer/shared';
import { useState, type SyntheticEvent } from 'react';
import { ApiError, errorMessage } from '../../api/client.ts';
import { useCreateAdmin } from '../../api/setup.ts';
import { Alert, Button, Field } from '../ui.tsx';
import { StepActions, type StepProps } from './shared.tsx';

export function AdminStep({ onNext }: Pick<StepProps, 'onNext'>) {
  const create = useCreateAdmin();
  const [form, setForm] = useState({
    username: '',
    displayName: '',
    email: '',
    password: '',
    confirm: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [key]: event.target.value }));
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const parsed = setupAdminRequestSchema.safeParse({
      username: form.username,
      password: form.password,
      email: form.email.trim() === '' ? undefined : form.email.trim(),
      displayName: form.displayName.trim() === '' ? undefined : form.displayName.trim(),
    });
    const next = parsed.success ? {} : zodFieldErrors(parsed.error.issues);
    if (form.confirm !== form.password) next.confirm = 'Passwords do not match.';
    setErrors(next);
    if (!parsed.success || next.confirm) return;
    create.mutate(parsed.data, { onSuccess: onNext });
  };

  const serverFieldErrors = create.error instanceof ApiError ? create.error.fieldErrors : {};
  const fieldError = (key: string) => errors[key] ?? serverFieldErrors[key];

  return (
    <form onSubmit={submit} noValidate>
      <h2 className="text-lg font-semibold">Create the administrator</h2>
      <p className="mt-1 mb-5 text-sm text-muted">
        This local account manages everything. You can add other sign-in methods later.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={form.username}
          onChange={set('username')}
          error={fieldError('username')}
        />
        <Field
          label="Display name (optional)"
          autoComplete="name"
          value={form.displayName}
          onChange={set('displayName')}
          error={fieldError('displayName')}
        />
        <Field
          className="sm:col-span-2"
          label="Email (optional)"
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={set('email')}
          error={fieldError('email')}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 8 characters."
          value={form.password}
          onChange={set('password')}
          error={fieldError('password')}
        />
        <Field
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          value={form.confirm}
          onChange={set('confirm')}
          error={fieldError('confirm')}
        />
      </div>
      {create.error && !Object.keys(serverFieldErrors).length && (
        <Alert className="mt-4">{errorMessage(create.error)}</Alert>
      )}
      <StepActions>
        <span />
        <Button type="submit" loading={create.isPending}>
          Create account and continue
        </Button>
      </StepActions>
    </form>
  );
}
