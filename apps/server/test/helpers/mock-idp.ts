import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type CryptoKey } from 'jose';
import { call, type Credentials, type Harness } from './auth.ts';

/**
 * A small but real OpenID provider on 127.0.0.1 (random port): discovery document, JWKS,
 * `/authorize` (302 back with code and state), and `/token` (checks the client credentials, the
 * PKCE S256 verifier, the redirect URI and single use of the code, then returns a signed ID
 * token). The `overrides` knobs let a test break exactly one property of the ID token.
 */

export interface IdpClaims {
  sub: string;
  preferred_username?: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
  picture?: string;
  groups?: string[] | string;
  [claim: string]: unknown;
}

export interface TokenOverrides {
  /** Replace the nonce (null omits the claim). */
  nonce?: string | null;
  aud?: string;
  iss?: string;
  /** Absolute expiry (epoch seconds). */
  exp?: number;
  /** Sign with a different key than the one published in the JWKS. */
  wrongKey?: boolean;
}

export interface MockIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The user the next `/authorize` signs in. */
  user: IdpClaims;
  overrides: TokenOverrides;
  hits: { discovery: number; token: number; jwks: number };
  /** Parameters of the most recent `/authorize` request. */
  lastAuthorize: URLSearchParams | undefined;
  /** Make discovery answer 500. */
  failDiscovery: boolean;
  close: () => Promise<void>;
}

interface CodeRecord {
  nonce: string | null;
  challenge: string;
  redirectUri: string;
  claims: IdpClaims;
  used: boolean;
}

export const DEFAULT_USER: IdpClaims = {
  sub: 'idp-user-1',
  preferred_username: 'alice',
  name: 'Alice Example',
  email: 'alice@example.com',
  email_verified: true,
  picture: 'https://idp.example/alice.png',
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export async function startMockIdp(
  options: { alg?: 'RS256' | 'ES256'; clientId?: string; clientSecret?: string } = {},
): Promise<MockIdp> {
  const alg = options.alg ?? 'RS256';
  const kid = 'test-key-1';
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const other = await generateKeyPair(alg);
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
  const codes = new Map<string, CodeRecord>();
  let issuer = '';

  const idp: MockIdp = {
    issuer: '',
    clientId: options.clientId ?? 'hearer-test',
    clientSecret: options.clientSecret ?? 'test-secret',
    user: { ...DEFAULT_USER },
    overrides: {},
    hits: { discovery: 0, token: 0, jwks: 0 },
    lastAuthorize: undefined,
    failDiscovery: false,
    close: () => Promise.resolve(),
  };

  const signIdToken = async (record: CodeRecord): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const o = idp.overrides;
    const claims: Record<string, unknown> = { ...record.claims };
    const nonce = o.nonce === undefined ? record.nonce : o.nonce;
    if (nonce !== null) claims.nonce = nonce;
    const key: CryptoKey = o.wrongKey ? other.privateKey : privateKey;
    return new SignJWT(claims)
      .setProtectedHeader({ alg, kid })
      .setIssuer(o.iss ?? issuer)
      .setAudience(o.aud ?? idp.clientId)
      .setSubject(record.claims.sub)
      .setIssuedAt(now)
      .setExpirationTime(o.exp ?? now + 300)
      .sign(key);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      idp.hits.discovery++;
      if (idp.failDiscovery) {
        json(res, 500, { error: 'server_error' });
        return;
      }
      json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: [alg],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
      return;
    }
    if (url.pathname === '/jwks') {
      idp.hits.jwks++;
      json(res, 200, { keys: [publicJwk] });
      return;
    }
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      idp.lastAuthorize = q;
      const redirect = q.get('redirect_uri');
      if (q.get('client_id') !== idp.clientId || !redirect || q.get('response_type') !== 'code') {
        json(res, 400, { error: 'invalid_request' });
        return;
      }
      const code = randomBytes(16).toString('hex');
      codes.set(code, {
        nonce: q.get('nonce'),
        challenge: q.get('code_challenge') ?? '',
        redirectUri: redirect,
        claims: { ...idp.user },
        used: false,
      });
      const back = new URL(redirect);
      back.searchParams.set('code', code);
      const state = q.get('state');
      if (state) back.searchParams.set('state', state);
      back.searchParams.set('iss', issuer);
      res.writeHead(302, { location: back.href });
      return void res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      idp.hits.token++;
      const form = await readForm(req);
      let id = form.get('client_id');
      let secret = form.get('client_secret');
      const basic = req.headers.authorization;
      if (basic?.startsWith('Basic ')) {
        const [u, p] = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':');
        id = decodeURIComponent(u ?? '');
        secret = decodeURIComponent(p ?? '');
      }
      if (id !== idp.clientId || secret !== idp.clientSecret) {
        json(res, 401, { error: 'invalid_client' });
        return;
      }
      const record = codes.get(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (
        form.get('grant_type') !== 'authorization_code' ||
        !record ||
        record.used ||
        record.redirectUri !== form.get('redirect_uri') ||
        record.challenge !== challenge
      ) {
        json(res, 400, { error: 'invalid_grant' });
        return;
      }
      record.used = true;
      json(res, 200, {
        access_token: randomBytes(16).toString('hex'),
        token_type: 'Bearer',
        expires_in: 300,
        id_token: await signIdToken(record),
      });
      return;
    }
    json(res, 404, { error: 'not_found' });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      json(res, 500, { error: 'server_error', detail: String(err) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  idp.issuer = issuer;
  idp.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  return idp;
}

/** Store OIDC settings through the real settings API as the signed-in admin. */
export async function configureOidc(
  h: Harness,
  admin: Credentials,
  idp: MockIdp,
  oidc: Record<string, unknown> = {},
): Promise<void> {
  const res = await call(h.app, admin, 'PUT', '/api/v1/settings/auth', {
    localEnabled: true,
    jellyfinEnabled: false,
    oidc: {
      enabled: true,
      issuerUrl: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      allowInsecureHttp: true,
      ...oidc,
    },
  });
  if (res.statusCode !== 200) throw new Error(`configureOidc failed: ${res.body}`);
}

export interface Started {
  res: LightMyRequestResponse;
  /** Absolute IdP authorize URL from the Location header. */
  location: string;
  /** `name=value` for the transaction cookie. */
  tx: string;
}

export async function startLogin(app: FastifyInstance, returnTo?: string): Promise<Started> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/oidc/login',
    query: returnTo === undefined ? {} : { returnTo },
  });
  const cookie = res.cookies.find((c) => c.name === 'hearer_oidc_tx');
  return {
    res,
    location: res.headers.location ?? '',
    tx: cookie ? `${cookie.name}=${cookie.value}` : '',
  };
}

/** Follow the authorize redirect at the mock IdP; returns the callback URL it sends us to. */
export async function authorizeAt(location: string): Promise<string> {
  const res = await fetch(location, { redirect: 'manual' });
  const next = res.headers.get('location');
  if (res.status !== 302 || !next) throw new Error(`authorize failed: ${String(res.status)}`);
  return next;
}

/** Deliver a callback URL (as the browser would) with the transaction cookie. */
export function callback(
  app: FastifyInstance,
  callbackUrl: string,
  tx: string,
  extraHeaders: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const u = new URL(callbackUrl);
  return app.inject({
    method: 'GET',
    url: u.pathname + u.search,
    headers: { ...(tx ? { cookie: tx } : {}), ...extraHeaders },
  });
}

/** Whole flow: login, IdP, callback. */
export async function ssoLogin(
  app: FastifyInstance,
  options: { returnTo?: string } = {},
): Promise<{ started: Started; callbackUrl: string; res: LightMyRequestResponse }> {
  const started = await startLogin(app, options.returnTo);
  const callbackUrl = await authorizeAt(started.location);
  const res = await callback(app, callbackUrl, started.tx);
  return { started, callbackUrl, res };
}

/** `name=value` cookie header for the session cookie set by a callback response. */
export function sessionCookie(res: LightMyRequestResponse): string {
  const c = res.cookies.find((x) => x.name === 'hearer_session');
  return c ? `${c.name}=${c.value}` : '';
}
