import { loginRequestSchema } from '@hearer/shared';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { authMethodsQuery, useSignIn } from '../api/auth.ts';
import { errorMessage } from '../api/client.ts';
import { AuthShell } from '../components/AuthShell.tsx';
import { Alert, Button, Card, Field, Spinner } from '../components/ui.tsx';
import { cx } from '../lib/cx.ts';
import { oidcErrorMessage } from '../lib/oidcErrors.ts';
import { safeReturnTo } from '../lib/returnTo.ts';

type Kind = 'local' | 'jellyfin';

function CredentialsForm({ kind, onDone }: { kind: Kind; onDone: () => void }) {
  const signIn = useSignIn(kind);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const parsed = loginRequestSchema.safeParse({ username, password });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        next[key] = key === 'username' ? 'Enter your username.' : 'Enter your password.';
      }
      setErrors(next);
      return;
    }
    setErrors({});
    signIn.mutate(parsed.data, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field
        label={kind === 'jellyfin' ? 'Jellyfin username' : 'Username'}
        name="username"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        value={username}
        error={errors.username}
        onChange={(event) => {
          setUsername(event.target.value);
        }}
      />
      <Field
        label={kind === 'jellyfin' ? 'Jellyfin password' : 'Password'}
        name="password"
        type={show ? 'text' : 'password'}
        autoComplete="current-password"
        value={password}
        error={errors.password}
        onChange={(event) => {
          setPassword(event.target.value);
        }}
        trailing={
          <button
            type="button"
            aria-label={show ? 'Hide password' : 'Show password'}
            onClick={() => {
              setShow((v) => !v);
            }}
            className="grid size-9 place-items-center rounded-md text-muted hover:text-fg"
          >
            {show ? (
              <EyeOff className="size-4" aria-hidden />
            ) : (
              <Eye className="size-4" aria-hidden />
            )}
          </button>
        }
      />
      {signIn.error && <Alert>{errorMessage(signIn.error)}</Alert>}
      <Button type="submit" className="w-full" loading={signIn.isPending}>
        Sign in
      </Button>
    </form>
  );
}

export function LoginPage({
  returnTo,
  error,
}: {
  returnTo?: string | undefined;
  error?: string | undefined;
}) {
  const router = useRouter();
  const methods = useQuery(authMethodsQuery());
  const [tab, setTab] = useState<Kind>('local');
  const destination = safeReturnTo(returnTo);

  const finish = () => {
    // `destination` was validated as a same-site path and may carry a query string.
    router.history.push(destination ?? '/');
  };

  if (methods.isPending) {
    return (
      <AuthShell title="Hearer">
        <Spinner />
      </AuthShell>
    );
  }
  if (methods.isError) {
    return (
      <AuthShell title="Hearer">
        <Alert>{errorMessage(methods.error)}</Alert>
      </AuthShell>
    );
  }

  const { appTitle, local, jellyfin, oidc } = methods.data;
  const kinds: Kind[] = [
    ...(local ? (['local'] as const) : []),
    ...(jellyfin ? (['jellyfin'] as const) : []),
  ];
  const active: Kind | undefined = kinds.includes(tab) ? tab : kinds[0];
  const oidcHref = `/api/v1/auth/oidc/login${destination ? `?returnTo=${encodeURIComponent(destination)}` : ''}`;
  const callbackError = oidcErrorMessage(error);

  return (
    <AuthShell title={appTitle}>
      <Card className="p-6 sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 mb-5 text-sm text-muted">Welcome back. Pick up where you left off.</p>

        {callbackError && <Alert className="mb-4">{callbackError}</Alert>}

        {kinds.length > 1 && (
          <div
            role="tablist"
            aria-label="Sign-in method"
            className="mb-5 grid grid-cols-2 rounded-lg border border-line bg-surface-2 p-0.5"
          >
            {kinds.map((kind) => (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={active === kind}
                onClick={() => {
                  setTab(kind);
                }}
                className={cx(
                  'min-h-9 rounded-md text-sm font-medium transition-colors',
                  active === kind ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
                )}
              >
                {kind === 'local' ? 'Local account' : 'Jellyfin'}
              </button>
            ))}
          </div>
        )}

        {active && <CredentialsForm key={active} kind={active} onDone={finish} />}

        {oidc.enabled && (
          <>
            {active && (
              <div className="my-5 flex items-center gap-3 text-xs text-muted" aria-hidden>
                <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
              </div>
            )}
            <a
              href={oidcHref}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface-2 text-sm font-medium hover:border-muted/60"
            >
              <KeyRound className="size-4" aria-hidden />
              {oidc.buttonLabel}
            </a>
          </>
        )}

        {!active && !oidc.enabled && (
          <Alert tone="info">No sign-in method is enabled. Ask an administrator.</Alert>
        )}
      </Card>
    </AuthShell>
  );
}
