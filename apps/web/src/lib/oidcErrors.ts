/** `?error=` codes the OIDC callback redirects with (see the server's oidc routes). */
export const OIDC_ERRORS: Record<string, string> = {
  access_denied: 'The identity provider denied the sign-in.',
  not_allowed: 'Your account is not allowed to sign in to this app.',
  signup_disabled: 'New accounts cannot be created with single sign-on. Ask an administrator.',
  link_denied: 'This email already belongs to another account that cannot be linked.',
  oidc_disabled: 'Single sign-on is turned off.',
  oidc_unavailable: 'The identity provider is not reachable right now. Try again shortly.',
  invalid_transaction: 'The sign-in attempt was not valid. Please start again.',
  transaction_expired: 'The sign-in took too long. Please start again.',
  transaction_replayed: 'That sign-in link was already used. Please start again.',
  state_mismatch: 'The sign-in could not be verified. Please start again.',
  login_failed: 'Single sign-on failed. Please try again.',
};

export function oidcErrorMessage(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return OIDC_ERRORS[code] ?? 'Sign-in failed. Please try again.';
}
