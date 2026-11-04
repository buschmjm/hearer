import { CredentialsForm } from '../../routes/login.tsx';

/** Shown when the admin exists but this browser has no session (resuming a half-done setup). */
export function SetupSignIn() {
  return (
    <div className="mx-auto max-w-sm">
      <h2 className="text-lg font-semibold">Sign in to continue setup</h2>
      <p className="mt-1 mb-5 text-sm text-muted">
        The administrator account already exists. Sign in with it to finish the remaining steps.
      </p>
      <CredentialsForm kind="local" onDone={() => undefined} />
    </div>
  );
}
