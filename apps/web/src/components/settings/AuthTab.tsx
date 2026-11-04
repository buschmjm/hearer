import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import { oidcRedirectQuery, useTestOidc, type OidcDiscoveryResult } from '../../api/settings.ts';
import { CopyButton, Section, TextAreaField } from '../controls.tsx';
import { Alert, Button } from '../ui.tsx';
import { DraftGate, DraftSecret, DraftSwitch, DraftText, SaveBar } from './parts.tsx';
import { useSectionDraft, type SectionDraft } from './useSectionDraft.ts';

function DiscoveryResult({ result }: { result: OidcDiscoveryResult }) {
  if (!result.ok) return <Alert>{result.error ?? 'Discovery failed.'}</Alert>;
  return (
    <div className="rounded-lg border border-success/40 bg-success-soft px-3 py-2.5 text-sm">
      <p className="flex items-center gap-2 font-medium text-success">
        <CheckCircle2 className="size-4" aria-hidden /> Discovery worked
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {result.issuer && (
          <>
            <dt className="text-muted">Issuer</dt>
            <dd className="break-all">{result.issuer}</dd>
          </>
        )}
        {result.authorizationEndpoint && (
          <>
            <dt className="text-muted">Authorize</dt>
            <dd className="break-all">{result.authorizationEndpoint}</dd>
          </>
        )}
        {result.tokenEndpoint && (
          <>
            <dt className="text-muted">Token</dt>
            <dd className="break-all">{result.tokenEndpoint}</dd>
          </>
        )}
        <dt className="text-muted">PKCE (S256)</dt>
        <dd className="flex items-center gap-1">
          {result.pkceS256 === false ? (
            <>
              <XCircle className="size-3.5 text-danger" aria-hidden /> Not advertised
            </>
          ) : (
            'Supported'
          )}
        </dd>
        {result.idTokenAlgs && result.idTokenAlgs.length > 0 && (
          <>
            <dt className="text-muted">Token algorithms</dt>
            <dd>{result.idTokenAlgs.join(', ')}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function OidcSection({ draft }: { draft: SectionDraft }) {
  const redirect = useQuery(oidcRedirectQuery());
  const test = useTestOidc();
  const [result, setResult] = useState<OidcDiscoveryResult>();
  const [testError, setTestError] = useState<string>();
  const enabled = draft.get('oidc.enabled') === true;
  const groups = draft.get('oidc.allowedGroups');
  const issuer = draft.get('oidc.issuerUrl');

  const runTest = () => {
    setResult(undefined);
    setTestError(undefined);
    test.mutate(
      {
        issuerUrl: typeof issuer === 'string' ? issuer : '',
        allowInsecureHttp: draft.get('oidc.allowInsecureHttp') === true,
      },
      {
        onSuccess: setResult,
        onError: (err) => {
          setTestError(errorMessage(err));
        },
      },
    );
  };

  return (
    <Section
      title="Single sign-on (OpenID Connect)"
      description="Works with Keycloak, Authentik, Authelia and other standards-compliant providers."
    >
      <DraftSwitch draft={draft} path="oidc.enabled" label="Enable single sign-on" />
      <div>
        <p className="mb-1.5 text-sm font-medium">Redirect URI</p>
        <div className="flex items-center gap-2">
          <code
            data-testid="redirect-uri"
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-xs break-all"
          >
            {redirect.data?.redirectUri ?? (redirect.isError ? 'Unavailable' : 'Loading…')}
          </code>
          {redirect.data && <CopyButton value={redirect.data.redirectUri} />}
        </div>
        <p className="mt-1.5 text-xs text-muted">
          Register this exact address at your identity provider. It follows the saved Application
          URL.
        </p>
      </div>

      {enabled && (
        <>
          <DraftText
            draft={draft}
            path="oidc.issuerUrl"
            label="Issuer URL"
            type="url"
            placeholder="https://sso.example.com/realms/home"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" loading={test.isPending} onClick={runTest}>
              Test discovery
            </Button>
            <span className="text-xs text-muted">
              Checks the issuer, not the client ID or secret.
            </span>
          </div>
          {testError && <Alert>{testError}</Alert>}
          {result && <DiscoveryResult result={result} />}

          <div className="grid gap-4 sm:grid-cols-2">
            <DraftText draft={draft} path="oidc.clientId" label="Client ID" />
            <DraftSecret draft={draft} path="oidc.clientSecret" label="Client secret" />
            <DraftText draft={draft} path="oidc.scopes" label="Scopes" />
            <DraftText draft={draft} path="oidc.buttonLabel" label="Button label" />
            <DraftText draft={draft} path="oidc.usernameClaim" label="Username claim" />
            <DraftText draft={draft} path="oidc.emailClaim" label="Email claim" />
          </div>
          <DraftSwitch
            draft={draft}
            path="oidc.autoCreateUsers"
            label="Create accounts at first sign-in"
            hint="Off: only people who already have an account can sign in."
          />

          <div className="border-t border-line pt-4">
            <h3 className="mb-3 text-sm font-semibold">Groups</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <DraftText
                draft={draft}
                path="oidc.groupsClaim"
                label="Groups claim"

                hint="For example groups."
              />
              <DraftText
                draft={draft}
                path="oidc.adminGroup"
                label="Administrator group"
                hint="Members become administrators when they sign in."
              />
            </div>
            <TextAreaField
              className="mt-4"
              label="Allowed groups"
              hint="One per line. When set, only members of these groups can sign in."
              error={draft.errors['oidc.allowedGroups']}
              value={Array.isArray(groups) ? groups.map(String).join('\n') : ''}
              onChange={(e) => {
                draft.set(
                  'oidc.allowedGroups',
                  e.target.value
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean),
                );
              }}
            />
          </div>

          <div className="space-y-4 border-t border-line pt-4">
            <h3 className="text-sm font-semibold">Advanced</h3>
            <DraftSwitch
              draft={draft}
              path="oidc.linkExistingByEmail"
              label="Link to existing accounts by email"
              hint="Sign in as the local or Jellyfin account that has the same verified email."
              warning="Anyone who can set that email at your identity provider can take over the matching account. Only enable it if the provider verifies emails and you trust everyone who can sign up there."
            />
            {draft.get('oidc.linkExistingByEmail') === true && (
              <DraftSwitch
                draft={draft}
                path="oidc.linkAdminAccounts"
                label="Also link administrator accounts"
                warning="Administrator accounts become reachable through email matching too."
              />
            )}
            <DraftSwitch
              draft={draft}
              path="oidc.allowInsecureHttp"
              label="Allow an http:// issuer"
              hint="For a provider on a trusted private network."
              warning="Tokens and credentials travel unencrypted. Use only on a network you control."
            />
          </div>
        </>
      )}
    </Section>
  );
}

export function AuthTab() {
  const draft = useSectionDraft('auth');
  return (
    <DraftGate draft={draft}>
      <div className="space-y-5">
        <Section title="Sign-in methods" description="At least one method must stay enabled.">
          <DraftSwitch
            draft={draft}
            path="localEnabled"
            label="Local accounts"
            hint="Username and password stored by Hearer."
          />
          <DraftSwitch
            draft={draft}
            path="jellyfinEnabled"
            label="Jellyfin"
            hint="Sign in with a Jellyfin account (needs the media server configured)."
          />
        </Section>
        <OidcSection draft={draft} />
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
