/**
 * Generic OpenID Connect login (Authorization Code + PKCE S256 + state + nonce) on top of
 * `openid-client` v6. Nothing here is specific to one identity provider.
 *
 * Transaction: `begin()` creates the state, nonce and PKCE verifier and seals them, with the
 * (sanitized) return path and a timestamp, into one AES-256-GCM value (the app's SecretBox) that
 * the route stores in a short-lived httpOnly, SameSite=Lax cookie. SameSite=Lax is required so the
 * browser still sends it on the top-level redirect back from the IdP. `complete()` opens it,
 * checks age and state, marks the state as used (a replay of the same cookie is refused even
 * before the IdP gets a chance to reject the reused code; the record lives in this process, which
 * is enough for the single-instance deployment) and then lets `openid-client` exchange the code
 * and validate the ID token claims (iss, aud, exp, nonce, azp, at_hash...). `openid-client`
 * (like OIDC Core 3.1.3.7 permits) does not check the signature of an ID token that arrived
 * straight from the token endpoint, so Hearer additionally verifies it against the IdP's JWKS
 * with `jose`, pinned to the signing algorithm announced in discovery.
 *
 * Cleartext issuers: `openid-client` refuses `http://` by default. `auth.oidc.allowInsecureHttp`
 * enables its documented `allowInsecureRequests` for discovery and every later request. Intended
 * for an IdP on a trusted private network (and for the test suite's local mock IdP).
 *
 * Account policy (allowed groups, auto-create, linking by email, admin group) lives in
 * `resolveOidcUser` and is documented on the matching `auth.oidc` settings.
 */
import {
  ClientSecretBasic,
  Configuration,
  None,
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type IDToken,
  type ServerMetadata,
} from 'openid-client';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { Permission, type SettingsValue } from '@hearer/shared';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import type { SecretBox } from '../lib/secrets.ts';
import type { SettingsService } from '../services/settings.ts';
import type { UserRow, UsersService } from '../services/users.ts';

export type OidcSettings = SettingsValue<'auth'>['oidc'];

export const OIDC_COOKIE = 'hearer_oidc_tx';
export const OIDC_COOKIE_PATH = '/api/v1/auth/oidc';
export const OIDC_CALLBACK_PATH = '/api/v1/auth/oidc/callback';
export const TRANSACTION_TTL_MS = 10 * 60 * 1000;
export const DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** After a failed discovery, do not hit the IdP again for this long. */
export const DISCOVERY_FAILURE_TTL_MS = 30 * 1000;
const DISCOVERY_TIMEOUT_S = 10;
const MAX_RETURN_TO = 2048;

/** A login failure with a code that is safe to show the user; `detail` is for the log only. */
export class OidcLoginError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ?? code);
    this.name = 'OidcLoginError';
    this.code = code;
  }
}

/**
 * Only same-origin relative paths survive: it must start with a single `/`, with no backslash
 * (browsers treat it as `/`), no control character (the URL parser strips tabs and newlines, so
 * `/\t/evil` would become `//evil`) and it must still resolve to our own origin.
 */
export function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_RETURN_TO) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return '/';
  try {
    const parsed = new URL(value, 'http://hearer.invalid');
    if (parsed.origin !== 'http://hearer.invalid') return '/';
  } catch {
    return '/';
  }
  return value;
}

const transactionSchema = z.object({
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  returnTo: z.string(),
  createdAt: z.number(),
});
type Transaction = z.infer<typeof transactionSchema>;

/** The verified identity, mapped from the ID token according to the settings. */
export interface OidcIdentity {
  sub: string;
  username: string;
  email: string | undefined;
  emailVerified: boolean;
  displayName: string | undefined;
  avatar: string | undefined;
  groups: string[];
  returnTo: string;
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const normalizeGroup = (group: string): string => group.trim().replace(/^\/+/, '');

function readGroups(claims: IDToken, claim: string): string[] {
  if (claim === '') return [];
  const raw = claims[claim];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return list.filter((g): g is string => typeof g === 'string').map(normalizeGroup);
}

/** Letters, digits and `._@+-`, starting alphanumeric, 3-64 chars (the shared username rules). */
function toUsername(candidates: (string | undefined)[], fallback: string): string {
  for (const candidate of [...candidates, fallback]) {
    if (!candidate) continue;
    const cleaned = candidate
      .replace(/[^A-Za-z0-9._@+-]/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 64);
    if (cleaned.length >= 3) return cleaned;
  }
  return `user-${fallback.replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'oidc'}`;
}

export function mapClaims(claims: IDToken, oidc: OidcSettings, returnTo: string): OidcIdentity {
  const email = asString(claims[oidc.emailClaim]);
  const verified = claims.email_verified;
  return {
    sub: claims.sub,
    username: toUsername([asString(claims[oidc.usernameClaim]), email], claims.sub),
    email,
    emailVerified: verified === true || verified === 'true',
    displayName: asString(claims.name),
    avatar: asString(claims.picture),
    groups: readGroups(claims, oidc.groupsClaim),
    returnTo,
  };
}

/** Pick the ID token algorithm the IdP signs with (openid-client assumes RS256 otherwise). */
function idTokenAlg(meta: ServerMetadata): string | undefined {
  const supported = meta.id_token_signing_alg_values_supported;
  if (!supported || supported.length === 0 || supported.includes('RS256')) return undefined;
  return supported.find((alg) => alg !== 'none');
}

interface DiscoveryParams {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  allowInsecureHttp: boolean;
}

/** The library's documented opt-out of its https-only rule; flagged deprecated on purpose. */
// eslint-disable-next-line @typescript-eslint/no-deprecated
const permitHttp: (config: Configuration) => void = allowInsecureRequests;

/** A discovered provider: the client configuration plus what is needed to verify signatures. */
interface Provider {
  config: Configuration;
  jwks: JWTVerifyGetKey;
  alg: string;
  clientId: string;
}

async function runDiscovery(params: DiscoveryParams): Promise<Provider> {
  const auth = params.clientSecret === '' ? None() : ClientSecretBasic(params.clientSecret);
  const options = {
    timeout: DISCOVERY_TIMEOUT_S,
    ...(params.allowInsecureHttp ? { execute: [permitHttp] } : {}),
  };
  const found = await discovery(new URL(params.issuerUrl), params.clientId, {}, auth, options);
  const meta = found.serverMetadata();
  const alg = idTokenAlg(meta);
  let config = found;
  if (alg !== undefined) {
    config = new Configuration(meta, params.clientId, { id_token_signed_response_alg: alg }, auth);
    config.timeout = DISCOVERY_TIMEOUT_S;
    if (params.allowInsecureHttp) permitHttp(config);
  }
  if (!meta.jwks_uri) throw new OidcLoginError('oidc_unavailable', 'IdP publishes no jwks_uri');
  const jwksUrl = new URL(meta.jwks_uri);
  if (jwksUrl.protocol !== 'https:' && !params.allowInsecureHttp) {
    throw new OidcLoginError('oidc_unavailable', 'jwks_uri is not https');
  }
  return {
    config,
    jwks: createRemoteJWKSet(jwksUrl, { timeoutDuration: DISCOVERY_TIMEOUT_S * 1000 }),
    alg: alg ?? 'RS256',
    clientId: params.clientId,
  };
}

export interface DiscoverySummary {
  issuer: string;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  jwksUri: string | null;
  userinfoEndpoint: string | null;
  pkceS256: boolean | null;
  idTokenAlgs: string[];
}

export interface OidcServiceDeps {
  settings: SettingsService;
  secrets: SecretBox;
  config: Pick<Config, 'baseUrl'>;
  /** Clock override (tests). */
  now?: (() => number) | undefined;
}

interface CacheEntry {
  key: string;
  expires: number;
  promise: Promise<Provider>;
}

export class OidcService {
  readonly #settings: SettingsService;
  readonly #secrets: SecretBox;
  readonly #baseUrl: string | undefined;
  readonly #now: () => number;
  #cache: CacheEntry | undefined;
  /** state -> expiry, for transactions already redeemed. */
  readonly #used = new Map<string, number>();

  constructor(deps: OidcServiceDeps) {
    this.#settings = deps.settings;
    this.#secrets = deps.secrets;
    this.#baseUrl = deps.config.baseUrl;
    this.#now = deps.now ?? Date.now;
  }

  get settings(): OidcSettings {
    return this.#settings.get('auth').oidc;
  }

  /** Enabled and configured enough to attempt a login. */
  isEnabled(): boolean {
    const o = this.settings;
    return o.enabled && o.issuerUrl !== '' && o.clientId !== '';
  }

  /** The URL to register at the IdP: the public URL (setting, else BASE_URL, else the request). */
  redirectUri(request: Pick<FastifyRequest, 'protocol' | 'host'>): string {
    const publicUrl = this.#settings.get('general').applicationUrl;
    const base =
      (publicUrl === '' ? undefined : publicUrl) ??
      this.#baseUrl ??
      `${request.protocol}://${request.host}`;
    // Normalized through URL so it equals what openid-client later sends (default ports dropped).
    return new URL(base.replace(/\/+$/, '') + OIDC_CALLBACK_PATH).href;
  }

  /**
   * Discovery with caching. A new `Configuration` is made whenever the relevant settings change;
   * a failure is remembered for a short while so a down IdP is not hammered by every page view.
   */
  #provider(): Promise<Provider> {
    const o = this.settings;
    const params: DiscoveryParams = {
      issuerUrl: o.issuerUrl,
      clientId: o.clientId,
      clientSecret: o.clientSecret,
      allowInsecureHttp: o.allowInsecureHttp,
    };
    const key = JSON.stringify(params);
    const cached = this.#cache;
    if (cached?.key === key && cached.expires > this.#now()) return cached.promise;
    const entry: CacheEntry = {
      key,
      expires: this.#now() + DISCOVERY_TTL_MS,
      promise: runDiscovery(params).catch((err: unknown) => {
        entry.expires = this.#now() + DISCOVERY_FAILURE_TTL_MS;
        throw err;
      }),
    };
    this.#cache = entry;
    return entry.promise;
  }

  /** Step 1: build the IdP redirect and the sealed transaction for the cookie. */
  async begin(
    request: Pick<FastifyRequest, 'protocol' | 'host'>,
    returnTo: unknown,
  ): Promise<{ location: string; cookie: string }> {
    const { config } = await this.#provider();
    const meta = config.serverMetadata();
    if (!meta.supportsPKCE('S256')) {
      throw new OidcLoginError('oidc_unavailable', 'IdP does not advertise PKCE S256');
    }
    const tx: Transaction = {
      state: randomState(),
      nonce: randomNonce(),
      verifier: randomPKCECodeVerifier(),
      returnTo: sanitizeReturnTo(returnTo),
      createdAt: this.#now(),
    };
    const scopes = new Set(this.settings.scopes.split(/\s+/).filter(Boolean));
    scopes.add('openid');
    const url = buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri(request),
      scope: [...scopes].join(' '),
      response_type: 'code',
      code_challenge: await calculatePKCECodeChallenge(tx.verifier),
      code_challenge_method: 'S256',
      state: tx.state,
      nonce: tx.nonce,
    });
    return { location: url.href, cookie: this.#secrets.encrypt(JSON.stringify(tx)) };
  }

  #open(cookie: string | undefined): Transaction {
    if (!cookie) throw new OidcLoginError('invalid_transaction', 'no transaction cookie');
    let tx: Transaction;
    try {
      tx = transactionSchema.parse(JSON.parse(this.#secrets.decrypt(cookie)));
    } catch {
      throw new OidcLoginError('invalid_transaction', 'transaction cookie is not valid');
    }
    const age = this.#now() - tx.createdAt;
    if (age < 0 || age > TRANSACTION_TTL_MS) {
      throw new OidcLoginError('transaction_expired', `transaction is ${String(age)} ms old`);
    }
    return tx;
  }

  /**
   * Step 2: validate the sealed transaction against the callback, exchange the code and verify
   * the ID token. Throws `OidcLoginError` for transaction problems; errors from the exchange or
   * the token validation come from `openid-client` and carry their own (log-only) detail.
   */
  async complete(
    request: Pick<FastifyRequest, 'protocol' | 'host' | 'url'>,
    cookie: string | undefined,
  ): Promise<OidcIdentity> {
    const tx = this.#open(cookie);
    const callback = new URL(this.redirectUri(request));
    callback.search = new URL(request.url, 'http://hearer.invalid').search;
    if (callback.searchParams.get('state') !== tx.state) {
      throw new OidcLoginError('state_mismatch', 'state does not match the transaction');
    }
    this.#consume(tx);
    const { config, jwks, alg, clientId } = await this.#provider();
    const tokens = await authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: tx.verifier,
      expectedState: tx.state,
      expectedNonce: tx.nonce,
    });
    const claims = tokens.claims();
    if (!claims || !tokens.id_token) {
      throw new OidcLoginError('login_failed', 'no ID token in the token response');
    }
    try {
      await jwtVerify(tokens.id_token, jwks, {
        issuer: config.serverMetadata().issuer,
        audience: clientId,
        algorithms: [alg],
      });
    } catch (err) {
      throw new OidcLoginError('login_failed', `ID token signature check failed: ${String(err)}`);
    }
    return mapClaims(claims, this.settings, tx.returnTo);
  }

  #consume(tx: Transaction): void {
    const now = this.#now();
    for (const [state, expires] of this.#used) if (expires <= now) this.#used.delete(state);
    if (this.#used.has(tx.state)) {
      throw new OidcLoginError('transaction_replayed', 'transaction was already used');
    }
    this.#used.set(tx.state, tx.createdAt + TRANSACTION_TTL_MS);
  }

  /** Discovery for a candidate issuer (settings screen "test" button). Never cached. */
  async testDiscovery(issuerUrl: string, allowInsecureHttp: boolean): Promise<DiscoverySummary> {
    const { config } = await runDiscovery({
      issuerUrl,
      clientId: 'hearer-discovery-test',
      clientSecret: '',
      allowInsecureHttp,
    });
    const meta = config.serverMetadata();
    return {
      issuer: meta.issuer,
      authorizationEndpoint: meta.authorization_endpoint ?? null,
      tokenEndpoint: meta.token_endpoint ?? null,
      jwksUri: meta.jwks_uri ?? null,
      userinfoEndpoint: meta.userinfo_endpoint ?? null,
      pkceS256: meta.code_challenge_methods_supported
        ? meta.code_challenge_methods_supported.includes('S256')
        : null,
      idTokenAlgs: meta.id_token_signing_alg_values_supported ?? [],
    };
  }
}

/**
 * Apply the account policy to a verified identity and return the Hearer user to sign in.
 *
 * 1. `allowedGroups` (when set) gates every login.
 * 2. A known `sub` is that user. Profile fields refresh; email only from a verified claim.
 * 3. Otherwise, with `linkExistingByEmail`, a verified email that matches exactly one local or
 *    Jellyfin account signs in as that account (the account itself is not modified, so it keeps
 *    working as before). Administrators are skipped unless `linkAdminAccounts` is on, and several
 *    matches are refused. With the option off (default) the login creates a separate account.
 * 4. Otherwise a new account is created, unless `autoCreateUsers` is off.
 * 5. Members of `adminGroup` are granted ADMIN (never revoked automatically).
 */
export function resolveOidcUser(
  users: UsersService,
  oidc: OidcSettings,
  identity: OidcIdentity,
): UserRow {
  if (oidc.allowedGroups.length > 0) {
    const allowed = new Set(oidc.allowedGroups.map(normalizeGroup));
    if (!identity.groups.some((g) => allowed.has(g))) {
      throw new OidcLoginError('not_allowed', `user ${identity.sub} is not in an allowed group`);
    }
  }
  const verifiedEmail = identity.emailVerified ? identity.email : undefined;
  let user = users.getExternal('oidc', identity.sub);
  if (!user && oidc.linkExistingByEmail && verifiedEmail) {
    const matches = users.findByEmail(verifiedEmail).filter((u) => u.authType !== 'oidc');
    if (matches.length > 1) {
      throw new OidcLoginError('link_denied', `email matches ${String(matches.length)} accounts`);
    }
    const [match] = matches;
    if (match) {
      if ((match.permissions & Permission.ADMIN) !== 0 && !oidc.linkAdminAccounts) {
        throw new OidcLoginError('link_denied', `refusing to link administrator ${match.id}`);
      }
      user = match;
    }
  }
  if (!user) {
    if (!oidc.autoCreateUsers) {
      throw new OidcLoginError('signup_disabled', `no account for ${identity.sub}`);
    }
    user = users.findOrCreateExternalUser('oidc', identity.sub, {
      username: identity.username,
      email: verifiedEmail,
      displayName: identity.displayName,
      avatar: identity.avatar,
    }).user;
  } else if (user.authType === 'oidc') {
    user = users.findOrCreateExternalUser('oidc', identity.sub, {
      username: identity.username,
      email: verifiedEmail,
      displayName: identity.displayName,
      avatar: identity.avatar,
    }).user;
  }
  if (
    oidc.adminGroup !== '' &&
    identity.groups.includes(normalizeGroup(oidc.adminGroup)) &&
    (user.permissions & Permission.ADMIN) === 0
  ) {
    user = users.update(user.id, { permissions: user.permissions | Permission.ADMIN }) ?? user;
  }
  return user;
}
