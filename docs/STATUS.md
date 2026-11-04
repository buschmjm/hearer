# Hearer — status log

Append-only handoff log, one entry per batch (see [PLAN.md](./PLAN.md), "Handoff packet").

## H-01 — Monorepo skeleton + OSS files

**Status:** done

**Shipped:**

- Tooling: root `package.json` (private, ESM, `pnpm@10.34.9`, Node >=24), `pnpm-workspace.yaml` (`apps/*`, `packages/*`, plus a `catalog` that pins shared dev tool versions), `.npmrc` (`save-exact`, `engine-strict`), `tsconfig.base.json`, flat `eslint.config.js` (typescript-eslint strict + stylistic, type-aware via `projectService`), Prettier config/ignore, `.editorconfig`, `.gitignore`, `.nvmrc`.
- `packages/shared` (`@hearer/shared`): `APP_NAME`, `REPO_URL`, `APP_VERSION`, `userAgent()` (the MusicBrainz UA format), Vitest config and 2 tests.
- OSS files: `README.md`, `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md`, issue forms (bug, feature, adapter, config), PR template, `renovate.json`.
- `docs/PLAN.md` and `docs/DECISIONS.md` copied with links fixed, homelab-only links removed, and plan §0 rewritten as "done, reference for forks" (H-23 noted as living in `homelab-infra`). Substance otherwise unchanged. Prettier re-flowed table whitespace only.

**Verify:** `pnpm i --frozen-lockfile && pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm format:check`

```text
 Test Files  1 passed (1)
      Tests  2 passed (2)
> hearer@0.0.0 format:check /home/user/hearer
> prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

typecheck and lint printed no errors.

**Design choices**

- `@hearer/shared` exports its **TypeScript source** (`"exports": "./src/index.ts"`), with no build step. Vite and Vitest consume TS directly. For the Node server, tsx/Node type stripping handles it in dev, and the production image (H-05) should bundle the server (for example tsdown/esbuild) so shared gets inlined. This avoids a build-order dependency and dist/src drift in a workspace. Consequence: relative imports inside packages use explicit `.ts` extensions (`allowImportingTsExtensions` + `noEmit`). If a package ever needs a published, compiled dist, switch to conditional exports then.
- Base tsconfig uses `NodeNext`; `apps/web` should override with `module: ESNext`, `moduleResolution: Bundler`, `lib: [ES2023, DOM, DOM.Iterable]`, `types: []` plus vite types.
- `exactOptionalPropertyTypes` is enabled and works. It may cause friction with some library types (Drizzle, zod inference); relax per package if needed, not globally.
- Each package declares its own `eslint`, `typescript` and `vitest` devDependencies (via `catalog:`) so `pnpm -r <script>` finds the binaries. Root holds the lint config deps and Prettier.
- pnpm 10 blocks dependency build scripts by default. H-02/H-03 must add `onlyBuiltDependencies` (or `pnpm approve-builds`) for `better-sqlite3`, `argon2` and `esbuild`.

**Pinned versions (checked with `pnpm view` on 2026-11-04)**

Only the "installed" rows are in the lockfile now; the rest are the versions later batches should pin.

| package                   | version  | notes                                                                                                                                                                                                        |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| typescript                | 6.0.3    | installed. **Latest is 7.0.2 (native port), but typescript-eslint 8.72.1 peers `typescript <6.1.0`, so 7.x is unsupported for type-aware lint. Pinned to 6.0.3. Revisit when typescript-eslint supports 7.** |
| typescript-eslint         | 8.72.1   | installed. Supports eslint 8/9/10.                                                                                                                                                                           |
| eslint                    | 10.14.0  | installed. Needs Node `^20.19 \|\| ^22.13 \|\| >=24`. Flat config only.                                                                                                                                      |
| @eslint/js                | 10.0.1   | installed. Peer eslint ^10.                                                                                                                                                                                  |
| globals                   | 17.14.0  | installed.                                                                                                                                                                                                   |
| prettier                  | 3.9.10   | installed.                                                                                                                                                                                                   |
| vitest                    | 5.1.0    | installed. Peer vite `^6.4 \|\| ^7 \|\| ^8`, so vite 8.3.5 is compatible. Node `^22.12 \|\| ^24 \|\| >=26`.                                                                                                  |
| @types/node               | 24.19.2  | installed, matching the Node 24 runtime. `latest` is 26.6.6, which is wrong for Node 24.                                                                                                                     |
| fastify                   | 5.12.8   | matches plan (Fastify 5).                                                                                                                                                                                    |
| fastify-type-provider-zod | 7.0.0    | **Major 7: peers `zod >=4.1.5`, `fastify ^5.5`, `@fastify/swagger >=9.5.1`, `openapi-types ^12`.** Zod 3 is not supported; use zod 4. Add `@fastify/swagger` for OpenAPI generation.                         |
| zod                       | 4.6.7    | Zod 4 API (for example `z.email()`, `z.treeifyError`, `error` param) differs from v3; the plan's "zod schemas everywhere" must be written for v4.                                                            |
| drizzle-orm               | 0.45.4   | `latest` dist-tag is 0.45.4; 1.0 is only beta/rc (`1.0.0-rc.5`). Use 0.45.4 and migrate later. `better-sqlite3 >=7` peer.                                                                                    |
| drizzle-kit               | 0.31.11  | matches drizzle-orm 0.45.x.                                                                                                                                                                                  |
| better-sqlite3            | 13.0.3   | native build script needs approval (see above). Node >=20.19. Major 13: check prebuilt binaries for node 24 alpine (musl, arm64) in H-05.                                                                    |
| vite                      | 8.3.5    | Vite 8 (rolldown-based). Node `^20.19 \|\| >=22.12`. Vitest 5 supports it.                                                                                                                                   |
| react / react-dom         | 19.3.1   | matches plan.                                                                                                                                                                                                |
| @tanstack/react-router    | 1.170.46 | peers react >=18.                                                                                                                                                                                            |
| @tanstack/react-query     | 5.105.3  |                                                                                                                                                                                                              |
| tailwindcss               | 4.3.4    | v4; use with `@tailwindcss/vite` (not yet looked up; pin at H-16).                                                                                                                                           |
| @tus/server               | 2.4.7    | Node >=22. `@tus/file-store` 2.1.2 is the matching store.                                                                                                                                                    |
| @tus/file-store           | 2.1.2    |                                                                                                                                                                                                              |
| tus-js-client             | 4.3.1    | not deprecated.                                                                                                                                                                                              |
| node-taglib-sharp         | 6.0.3    | Node >=22.                                                                                                                                                                                                   |
| openid-client             | 6.8.9    | v6 is a rewrite (functional API: `discovery()`, `authorizationCodeGrant()`), not the v5 `Issuer`/`Client` classes. H-08 must use v6.                                                                         |
| music-metadata            | 12.3.4   | ESM-only, Node >=22.                                                                                                                                                                                         |
| pino                      | 10.4.0   | Fastify 5 bundles its own pino use; pin if used directly.                                                                                                                                                    |
| argon2                    | 0.45.2   | native build script needs approval.                                                                                                                                                                          |

Nothing in the plan's stack is deprecated or missing. Incompatibilities to know about: TypeScript 7 vs typescript-eslint (handled by pinning 6.0.3) and the zod 4 requirement of fastify-type-provider-zod 7.

**Deviations:** none. DECISIONS.md was not amended (only link and wording fixes in the copied docs). The plan's Node pin is `>=24`, as specified. `apps/` is empty (git does not track empty directories), so the workspace glob has no app yet.

**Next:** H-02 (server bootstrap, config, health).

**Open questions:**

- The GitHub repo URL `https://github.com/buschmjm/hearer` is hard-coded in README, issue templates and `REPO_URL` (it is the real upstream, not a homelab value).
- `APP_VERSION` is a constant `0.0.0`; release tooling (H-22, release-please) should update it.

## H-02 — Server bootstrap + config + health

**Status:** done

**Shipped:**

- `apps/server` (package `server`, so `pnpm --filter server <script>` works). Scripts: `dev` (`node --watch src/index.ts`, native type stripping, `erasableSyntaxOnly` on), `build` (esbuild bundle to `dist/index.js`, `@hearer/shared` inlined), `start`, `test`, `lint`, `typecheck`.
- `src/config.ts`: `loadConfig(env = process.env)` (pure, zod 4), `Config` type, `ConfigError` listing every bad variable. Vars: `NODE_ENV`, `HOST`, `PORT`, `BASE_URL`, `DATA_DIR`, `MUSIC_DIR`, `STAGING_DIR`, `LOG_LEVEL`, `LOG_FORMAT`, `HEARER_SECRET` (optional, min 16 chars), `TRUST_PROXY` (true/false/hop count). Empty strings count as unset.
- `src/app.ts`: `buildApp(config, deps?)` with the zod type provider, pino (redacts authorization/cookie headers, optional pretty output), `@fastify/swagger` OpenAPI 3 at `/api/v1/openapi.json`, uniform `{error:{code,message,details?}}` errors (zod validation 400, JSON 404, 500 with the message hidden), UUID request ids (echoed in `x-request-id`, an incoming one is honored). `deps.routes` lets later batches register plugins under `/api/v1`; `deps.healthChecks` feeds the health `checks` map.
- `src/routes/health.ts`: `GET /api/v1/health` returns `{status: ok|degraded, version, uptimeSeconds, checks}`. H-03 passes a `db` check via `healthChecks`.
- `src/index.ts`: SIGTERM/SIGINT graceful close with a 10 s forced-exit timeout; readable message and exit 1 on bad config or startup failure.
- Catalog pins added: fastify 5.12.8, fastify-type-provider-zod 7.0.0, zod 4.6.7, pino 10.4.0, pino-pretty 13.2.0, @fastify/swagger 9.9.3, esbuild 0.28.2. Root `pnpm.onlyBuiltDependencies: [esbuild]`.

**Verify:** `pnpm --filter server test && pnpm -r lint && pnpm -r typecheck && pnpm -r test && pnpm format:check`

Smoke: `pnpm build && PORT=5199 node dist/index.js`, then `curl /api/v1/health` returned `{"status":"ok","version":"0.0.0","uptimeSeconds":1.52,"checks":{}}`; unknown route gave the JSON 404; SIGTERM logged "shutting down" and exited; `PORT=abc` exited 1 with a readable message. `node src/index.ts` (dev path) also served health.

**Deviations:** none; DECISIONS.md not amended. `pino-pretty` is a runtime dependency (used as a stream, so it bundles). Fastify's numeric `trustProxy` is expressed as a hop function because its types omit numbers. `requestIdLogLabel` and `disableRequestLogging` are deprecated in Fastify 5.12, so they are not used (default `reqId` label is the same).

**Next:** H-03

**Open questions:** none. The esbuild bundle is 2.7 MB because of swagger and pino-pretty; fine for the image. Native deps added in H-03 (better-sqlite3, argon2) must be marked `--external` in the build script.

## H-03a — Shared enums/permissions/settings catalog, DB schema, migration, client

**Status:** done

**Shipped:**

- `packages/shared/src/enums.ts`: request types/statuses, upload statuses, job statuses (`queued|running|succeeded|failed|dead`), auth types, library item kinds, notification agents and events as `const` arrays plus derived types. Helpers map notification events to and from a bitmask (`notification_targets.events`).
- `packages/shared/src/permissions.ts`: `Permission` bits (PLAN list), `ALL_PERMISSIONS`, `DEFAULT_USER_PERMISSIONS` (`REQUEST|REQUEST_ALBUM|UPLOAD`), `hasPermission(userPerms, required, {type:'and'|'or'})` (ADMIN passes everything; `required` may be a bit, a combined mask or an array), `permissionNames`, `isValidPermissionMask`.
- `packages/shared/src/settings.ts`: typed catalog `SETTINGS_CATALOG` for `general`, `auth`, `mediaServer`, `library`, `uploads`, `metadata`, `fulfillment`. Each key has a zod 4 schema (every field defaulted, so `parse({})` is the default), plus the object paths of its secrets (`auth.oidc.clientSecret`, `mediaServer.apiKey`, `metadata.acoustIdApiKey`, `fulfillment.lidarr.apiKey`). Exports `SettingsKey`, `SettingsValue<K>`, `SettingsInput<K>`, `settingsDefault`, `REDACTED_SECRET`. `shared` now depends on `zod`.
- `apps/server/src/db/schema.ts`: all 11 PLAN tables, ms timestamps (`timestamp_ms`, SQL default `unixepoch('subsec')*1000` so raw inserts work), exported `$inferSelect/$inferInsert` row types.
- `apps/server/drizzle/0000_init.sql` + `meta/` (generated by drizzle-kit), `drizzle.config.ts`.
- `src/db/client.ts` (`openDatabase(dataDir | ':memory:')`: creates the dir, `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`; `pingDatabase`), `src/db/migrate.ts` (`runMigrations`, `resolveMigrationsFolder` finds `./drizzle` next to the bundle or `../../drizzle` in dev).
- Scripts: `db:generate` (drizzle-kit generate), `db:check` (`scripts/db-check.ts`: runs `drizzle-kit check`, then generates into a scratch copy of the migrations and fails if a new migration appears). Build now `rm -rf dist`, bundles with `--external:better-sqlite3`, then copies `drizzle/` to `dist/drizzle`.
- Deps (catalog-pinned, exact): drizzle-orm 0.45.4, better-sqlite3 13.0.3 (production dep, approved in `pnpm.onlyBuiltDependencies`; builds fine on Node 24), drizzle-kit 0.31.11, @types/better-sqlite3 9.6.0. `.gitignore` gets `.db-check-*/`.
- Tests: `test/db.test.ts` (all tables exist and match the exported schema, idempotent migrate, pragmas, FK enforcement, file DB creates the data dir + WAL + persists, defaults/JSON round trip, unique constraints, cascade/set-null behaviors incl. the requests<->uploads cycle), `packages/shared/test/permissions.test.ts`.

**Verify:** `pnpm --filter server test && pnpm --filter server db:check`

```text
 Test Files  5 passed (5)
      Tests  63 passed (63)
db:check ok: schema matches 1 committed migration(s)
```

`db:check` was proven to fail: adding a column to `schema.ts` made it exit 1 with "src/db/schema.ts has changes that are not in the committed migrations", and reverting made it pass. Note drizzle-kit exits 0 on some errors, so the script also requires its "No schema changes" message.

**Schema additions beyond the PLAN table (small, implied):**

- `users`: `notify_prefs` (json: `{events, email?}`, per-user opt-in; no separate table, null means app defaults), `last_login_at`, `updated_at`; quota columns are nullable (null = use the `general` default). Username uniqueness is case-insensitive (`unique(lower(username))`); `unique(auth_type, external_id)` allows many NULL external ids (local accounts).
- `sessions`: `created_at`, `last_seen_at`. `api_keys`: `prefix` (display), `created_at`, unique `hash`. `settings`/`notification_targets`: `updated_at`; `notification_targets` also `name`, `created_at`.
- `mb_cache`: `ttl_seconds`. `requests`: `parent_mbid` (release group of a track request, for Lidarr), `decided_at`. No separate `requested_at`: `created_at` is that instant.
- `request_events`: integer autoincrement `id`; `actor_id` FK (null = system) instead of a free-text actor.
- `uploads`: `tus_id` (unique), `created_at/updated_at`. `jobs`: `priority`, `unique_key` (partial unique index while `queued|running`, so recurring jobs de-dupe), `finished_at`, `updated_at`; integer autoincrement id.
- ON DELETE: user deletion cascades to sessions, api_keys, requests, uploads; `requests.decided_by`, `request_events.actor_id` set null; `requests.fulfilled_by_upload_id` and `uploads.target_request_id` set null; request deletion cascades to events.

**Deviations:** none from DECISIONS.md (not amended). `db:check` and the migration folder resolution are my own design.

**Next:** H-03b (same batch, second half), then H-04.

**Open questions:** none.

## H-03b — Secrets, settings service, wiring

**Status:** done

**Shipped:**

- `apps/server/src/lib/secrets.ts`: `SecretBox` (AES-256-GCM, key derived from the key material with HKDF-SHA256, random 12-byte IV per call, format `enc:v1:` + base64url(iv|tag|ciphertext), tamper/truncation/wrong-key raise `SecretError`). `loadSecretKeyMaterial({secret, dataDir})` uses `HEARER_SECRET` when set, otherwise generates 32 random bytes into `${DATA_DIR}/secret.key` (mode 0600, exclusive create so concurrent starts agree, loose perms on an existing file are tightened, an empty file is an error) and reuses it.
- `apps/server/src/services/settings.ts`: `SettingsService` with `get`, `set`, `getAll`, `getPublic`, `invalidate`. Validates on read and write (`SettingsValidationError` on a bad write; a corrupt/invalid stored value gives the default plus a logged warning). Secrets are encrypted in the DB row and decrypted on get; in-memory cache, invalidated on set; callers get clones. `getPublic` replaces set secrets with `********` and unset with `''`. Writing `********` back keeps the stored secret (so the UI can echo public values). If a stored secret cannot be decrypted (key changed), only that field is blanked with a warning; the rest of the setting is kept.
- Wiring: `buildApp(config, deps)` accepts `deps.db` (and `deps.secrets`); with no `deps.db` it creates a migrated `:memory:` database closed with the app (so existing tests never touch `/data`). It decorates the app with `app.hearer = { database, secrets, settings }` and adds the `db` health check (`select 1`; merged with `deps.healthChecks`). `index.ts` opens `DATA_DIR/hearer.db`, migrates, loads/generates the secret key, builds the app, and closes the DB on shutdown or startup failure.
- Tests: `test/secrets.test.ts`, `test/settings.test.ts`, health tests extended (db check ok, degraded when the DB is closed, a supplied DB is not closed by the app).

**Verify:** `pnpm -r lint && pnpm -r typecheck && pnpm -r test && pnpm format:check` plus build and smoke.

```text
packages/shared test:       Tests  11 passed (11)
apps/server test:       Test Files  5 passed (5)
apps/server test:       Tests  63 passed (63)
All matched files use Prettier code style!
```

Smoke: `pnpm build`, then `DATA_DIR=<tmp>/data PORT=5198 node dist/index.js` returned `{"status":"ok",...,"checks":{"db":{"status":"ok"}}}`; the data dir (missing beforehand) then held `hearer.db` and `secret.key` (0600); a second start reused both. `node src/index.ts` (dev) also works. `dist/drizzle` is created by the build.

**Deviations:** none; DECISIONS.md not amended.

**Next:** H-04 (job runner), H-06 (auth; use `hasPermission`/`Permission` and `app.hearer.settings`).

**Open questions:** none. Note `buildApp` without `deps.db` uses an ephemeral secret when `HEARER_SECRET` is unset; production always goes through `index.ts`.
