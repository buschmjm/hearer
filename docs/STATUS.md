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

## H-05 — CI + Dockerfile

**Status:** done (image build and CI run are unverified until GitHub Actions runs)

**Shipped:**

- `docker/Dockerfile`: two stages on `node:24.22.2-alpine3.24` (ARG `NODE_IMAGE`). Build stage: python3/make/g++, corepack pnpm 10.34.9, `pnpm install --frozen-lockfile` with a BuildKit cache mount for the pnpm store, `pnpm --filter server build`, an `apps/web` build that is skipped while the directory does not exist (H-16 needs no Dockerfile change; its `dist` ends up in `/app/public`), then `pnpm --filter server deploy --prod --legacy /out`. A build-time check loads better-sqlite3 from `/out` (falling back to `pnpm rebuild better-sqlite3`) so a missing native binary fails the build. Runtime stage: `apk add ffmpeg chromaprint tini su-exec tzdata`, `/app/dist` + production `node_modules`, the ENV defaults, volumes, `EXPOSE 5055`, a node-fetch `HEALTHCHECK` on `/api/v1/health`, tini entrypoint, OCI labels.
- `docker/entrypoint.sh` (POSIX sh): validates PUID/PGID/UMASK; as root it removes any account holding the requested uid/gid (such as the built-in `node` user), creates `hearer`, chowns `/data` and `/staging` (never `/music`, which only gets a writability warning), applies the umask and execs via `su-exec`. As non-root (`--user`) it only sets the umask and execs. `PUID=0` runs as root with a warning. A restart with unchanged ids skips user management.
- `.github/workflows/ci.yml`: `check` job (format, lint, typecheck, test, `db:check`) and `docker` job (needs check). The docker job builds amd64 with `load: true`, smoke-tests `ffprobe`/`fpcalc`, boots with a tmp `/data` and `PUID=1234`, polls `/api/v1/health` for 30 s (logs on failure), asserts `hearer.db` is owned by 1234 and the server process runs as `hearer`, and boots again with `--user 4321:4321`. Only on a push to main does it log in to GHCR and push the multi-arch (amd64+arm64) image `ghcr.io/<lowercased owner>/hearer` tagged `edge` and `sha-<short>`. Actions used (latest majors found via `git ls-remote`, since the API was blocked): checkout v7, setup-node v7, pnpm/action-setup v6, setup-qemu v4, setup-buildx v4, metadata v6, build-push v7, login v4.
- `.dockerignore`, `docker-compose.example.yml` (image `ghcr.io/OWNER/hearer:edge`, local-build comment, PUID/PGID/UMASK/TZ, optional BASE_URL/HEARER_SECRET, three volumes).

**Verify:** Docker not available locally; docker build not run — will be verified by CI. Static checks only:

```text
actionlint v1.7.12 (with shellcheck) on ci.yml: clean
shellcheck docker/entrypoint.sh: clean
hadolint docker/Dockerfile: clean (DL3018 apk pinning ignored with comments)
prettier --check .github docker-compose.example.yml: clean; compose YAML parses
pnpm --filter server deploy --prod --legacy <tmp>, then require('better-sqlite3') in memory: ok
UMASK=99 sh docker/entrypoint.sh true -> "UMASK must be 3 or 4 octal digits", exit 1
```

The root path of the entrypoint (user mapping, chown, su-exec) was not executed locally (it would modify this container's accounts); it is covered by the CI smoke test.

**Deviations:** none; DECISIONS.md not amended. `pnpm format:check` currently fails on 4 files under `apps/server/src/jobs` (H-04's in-progress work, not touched here).

**Next:** H-06.

**Open questions:** `LABEL ...source` in the Dockerfile names the upstream repo (CI overrides labels via metadata-action). The static web path `/app/public` will need serving by the server in H-16. The compose example uses `OWNER` as a placeholder.

**CI verification (added by orchestrator):** PR #1 run on `c905437`: both jobs green. Docker smoke in CI:

```text
ffprobe version 8.1.3 Copyright (c) 2007-2026 the FFmpeg developers
fpcalc version 1.6.0 (FFmpeg Lavc62.28.100 Lavf62.12.100 SwR6.3.100)
{"status":"ok","version":"0.0.0","uptimeSeconds":1.03,"checks":{"db":{"status":"ok"}}}
server process uid(s): 1234
```

Two CI-script fixes were needed: the run-as-PUID check matched tini (root, PID 1) and Node 24 reports `comm` as `MainThread`; it now reads `/proc/*/cmdline`.

## H-04 — DB-backed job runner

**Status:** done

**Shipped:**

- `apps/server/src/jobs/registry.ts`: `defineJob({type, payload (zod), concurrency, maxAttempts?, timeoutMs?, backoff?, handler(payload, ctx)})`, `JobRegistry`, `PermanentJobError`, `computeBackoffMs` (`min(base*2^(attempt-1), max)` +/- jitter; defaults 5 s base, 15 min cap, 0.2 jitter), `JobContext` (`jobId, attempt, signal, log, db, enqueue`).
- `jobs/runner.ts`: `JobRunner` with `define`, `schedule`, `enqueue(typeOrDef, payload, {runAfter, delayMs, priority, uniqueKey, maxAttempts})` (payload validated; duplicate `uniqueKey` while queued/running returns the existing id, check+insert in a `BEGIN IMMEDIATE` transaction), `get`, `start`, `stop({graceMs})`, `tick`, `drain`, `wake`, `housekeeping`, `recoverOnStart`. Atomic claim is one `UPDATE ... WHERE id = (SELECT ... ORDER BY priority DESC, run_after, id LIMIT 1) RETURNING *`, restricted to types with free capacity. Per-type in-flight counters plus a global `maxConcurrency` (default 4). Poll loop (default 1 s) plus an immediate coalesced wake on enqueue and after each job.
- `jobs/scheduler.ts`: `every: ms` (enqueued at start, then each interval) and `dailyAtHour` (server-local hour; first run at the next occurrence, not at start). Both enqueue with `uniqueKey = schedule:<type>`, so they never pile up.
- `jobs/maintenance.ts`: `maintenance.cleanup` (hourly): expired sessions; `mb_cache` rows past `fetched_at + ttl_seconds`; succeeded/failed jobs older than 7 days; dead jobs older than 30 days; stale tus artifacts in `${STAGING_DIR}/tmp` older than 24 h (pair `<id>` + `<id>.json` is removed when its newest member is stale). Only regular files directly in `tmp` are unlinked; symlinks (and a symlinked `tmp`) are never followed or removed. Returns and logs counts.
- Wiring: `buildApp` creates the runner, registers + schedules maintenance, exposes `app.hearer.jobs`, starts on `onReady` only when `deps.startJobs` is true (default false, so tests stay idle; `index.ts` passes true and `workerId: 'main'`), and stops on close (5 s grace) before the owned DB closes.
- No schema change and no migration; the existing `jobs` table is reused.

**Terminal-state model:** `succeeded` or `dead`. `dead` covers PermanentJobError, exhausted attempts and an unparseable stored payload; `last_error` has `Name: message` + stack, truncated to 4 000 chars. `failed` stays in the shared enum but the runner never writes it (the pruner still deletes it). Retries sit in `queued` with a later `run_after`.

**Attempt accounting / recovery:** `attempts` is incremented at claim. A graceful stop or shutdown abort refunds the attempt and re-queues. Crash recovery keeps the attempt consumed (a job that kills the process cannot loop forever); if that exhausts `max_attempts` it goes `dead`. On start, rows `running` with this runner's `workerId` (stable `main` in production) or with a lock older than `staleLockMs` (5 min) are recovered; a random default `workerId` (tests, extra instances) recovers only stale locks, so a second live runner is never robbed. Housekeeping (every `staleLockMs/3`) refreshes the locks this runner holds and recovers other workers' stale locks.

**Timeouts:** the handler's signal is aborted and the attempt counts as failed (retry or dead). The handler is raced against the abort, so a handler that ignores its signal cannot hold its slot; its late result is discarded.

**Verify:** `pnpm --filter server test -- jobs` and `pnpm -r lint && pnpm -r typecheck && pnpm -r test && pnpm --filter server db:check && pnpm format:check` (full suite run 3 times, no flakes)

```text
packages/shared test:       Tests  11 passed (11)
apps/server test:  Test Files  9 passed (9)
apps/server test:       Tests  103 passed (103)
db:check ok: schema matches 1 committed migration(s)
All matched files use Prettier code style!
```

**Deviations:** none; DECISIONS.md not amended. `pnpm --filter server test -- jobs` runs the whole server suite (the `--` filter is not applied by vitest here); the job tests are `test/jobs.*.test.ts`.

**Next:** H-06 (auth), H-10 (library sync registers `library.sync` via `runner.define` + `runner.schedule`).

**Open questions:** `dailyAtHour` uses the server's local time zone (container TZ, usually UTC). Feature batches should call `app.hearer.jobs.define(...)` / `.schedule(...)` from `buildApp` before `ready`.

## H-06a — Auth core: passwords, sessions, API keys, guards, users service, auth routes

**Status:** done

**Files (H-06a):** `packages/shared/src/dto/{auth,users}.ts` (+ `index.ts` export), `apps/server/src/auth/{password,sessions,apikeys,permissions,guard,plugin}.ts`, `src/services/users.ts`, `src/routes/auth.ts`, `src/lib/{http-error,constants}.ts`, wiring in `src/app.ts` and `src/config.ts`, tests `test/auth.sessions.test.ts`, `test/auth.login.test.ts`, `test/helpers/auth.ts`, `packages/shared/test/dto.test.ts`.

**Shipped:**

- **Passwords:** `argon2` 0.45.2 (catalog-pinned, in `onlyBuiltDependencies`, `--external:argon2` in the esbuild build, production dependency, and added to the Dockerfile native-module check). argon2id with OWASP's first profile (m=19456 KiB, t=2, p=1). Unknown or non-local accounts burn a dummy verification so timing does not reveal usernames; weak stored hashes are rehashed on login.
- **Sessions:** cookie carries 32 random bytes (base64url); the DB stores only its SHA-256 as `sessions.id`. Cookie `hearer_session`: httpOnly, SameSite=Lax, Path=/, Secure when the request is https (trust proxy aware) or `BASE_URL`/`general.applicationUrl` is https. Sliding 30-day expiry, refreshed (and the cookie re-issued) at most once per day. ip and user agent recorded. Logout deletes the session; `POST /auth/logout-all`; a password change revokes all other sessions; an admin password reset and user deletion revoke the target's sessions.
- **CSRF:** synchronizer token derived per session (`HMAC-SHA256(key = raw session id, "hearer-csrf-v1")`, nothing stored). Returned by login, first-admin creation and `GET /auth/me`; required in `x-csrf-token` on POST/PUT/PATCH/DELETE for cookie-authenticated requests, compared in constant time. API-key requests are exempt. Only login and first-admin creation opt out (`config.csrfExempt`) because they mint a session. The design is documented in the header comment of `auth/sessions.ts`.
- **API keys:** `hrr_` + 32 random bytes, SHA-256 stored plus an 8-char display prefix; `X-Api-Key` or `Authorization: Bearer hrr_...`; `last_used_at` written at most every 5 min; max 25 per user. A presented but invalid key never falls back to the cookie. Key and password management require an interactive session (`session_required` 403 for keys), so a leaked key cannot mint more keys or change the password.
- **Guards:** `requireAuth()`, `requirePermission(bit | bits, {type})`, `requireSession()` as `onRequest` hooks; `request.user` / `request.auth` are typed by module augmentation. 401 and 403 use the error envelope. `app.hearer` now also exposes `users`, `sessions`, `apiKeys`, `auth` helpers.
- **Users service:** CRUD, search, atomic `createFirstAdmin`, last-admin protection (`last_admin` 409) inside write transactions, `findOrCreateExternalUser(authType, externalId, profile)` for the Jellyfin/OIDC batches (refreshes profile, de-duplicates usernames with a numeric suffix, applies `general.defaultPermissions`).
- **Auth routes:** `POST /auth/login` (respects `auth.localEnabled`), `POST /auth/logout`, `POST /auth/logout-all`, `GET /auth/me`, `POST /auth/password`, `GET/POST /auth/api-keys`, `DELETE /auth/api-keys/:id`. Login, first-admin and password change are rate limited with `@fastify/rate-limit` (10/min/IP; env `AUTH_RATE_LIMIT_MAX`, tests lower it). `@fastify/cookie` 11.1.5, `@fastify/rate-limit` 11.2.2.
- **Shared DTOs:** zod schemas for login/session/me/password/API keys/setup status and for users (never include the hash).

**Verify:** see H-06b (single combined run): `pnpm --filter server test -- auth` and the full suite.

**Deviations:** guards are `onRequest` hooks rather than `preHandler`, so authorization runs before body validation (anonymous callers always get 401, never a 400 that reveals the schema). `HttpError` responses with status >= 500 (the 503 `setup_required`) now pass through the error handler instead of being masked as 500; unexpected errors are still masked. DECISIONS.md not amended.

**Next:** H-06b (included below), then H-07.

**Open questions:** none.

## H-06b — Setup wizard API, settings API, users API, setup gating, route matrix

**Status:** done

**Files (H-06b):** `apps/server/src/routes/{setup,settings,users}.ts`, `test/auth.setup.test.ts`, `test/auth.users.test.ts`, `test/auth.matrix.test.ts`; `test/health.test.ts` adjusted (its custom routes now need the setup gate lifted).

**Shipped:**

- **Setup:** `GET /setup/status` (public: `setupComplete`, `hasAdmin`, `steps`, and library/staging directory checks `exists`/`writable`; the paths are only reported while setup is incomplete). `POST /setup/admin` creates the first local admin only when no users exist; the check and insert share one `BEGIN IMMEDIATE` transaction, so 6 parallel calls produce exactly one 201 and five 409s. It signs the admin in. `GET|PUT /setup/:section` (general, library, uploads; admin only, 409 once complete), `POST /setup/complete` (admin; 400 `directories_not_ready` unless both directories exist and are writable).
- **Gate:** until setup completes, every `/api/v1` route except health, auth, setup and openapi.json returns 503 `setup_required` (404s unaffected).
- **Settings:** `GET /settings`, `GET|PUT /settings/:key` (MANAGE_SETTINGS), validated by the shared catalog, secrets always masked, masked value re-sent keeps the secret. Safeguards: `general.setupComplete` can only change via `/setup/complete`; `auth` cannot disable every sign-in method (`would_lock_out`). PUT is a full replace (omitted fields reset to defaults).
- **Users:** `GET /users` (paginated, `q` search over username/email/display name with LIKE escaping), `GET /users/:id`, `POST /users`, `PATCH /users/:id`, `DELETE /users/:id`, `POST /users/:id/password` (MANAGE_USERS). Escalation guards: a non-admin may only grant bits they hold, and may not act on users holding privileged bits (anything beyond request/upload basics) they lack, so a delegated manager cannot touch administrators. You cannot delete yourself or reset your own password through the admin route; the last admin cannot be deleted or demoted.
- **Tests (210 server, 15 shared):** setup flow including the race, 503 gating, login success/failure/disabled/rate limit/cookie flags (including Secure via proxy and via https URL), logout, expiry, sliding refresh, CSRF required/accepted/rejected/exempt, API keys (both header forms, CSRF exempt, deleted key fails, session-only management), password change revoking other sessions, role matrix (anon, user, usersOnly, settingsOnly, manager, admin) over every users/settings route, escalation attempts, last-admin protection, masked secrets. **Route matrix (PLAN acceptance #2):** an `onRoute` hook (new `deps.onRoute`) enumerates the real route table; every non-allowlisted route must answer 401 anonymously, 403 for a no-permission session user and for a no-permission API key, 503 before setup; a self-test proves an unguarded route is caught.

**Verify:** `pnpm --filter server test -- auth && pnpm -r lint && pnpm -r typecheck && pnpm -r test && pnpm --filter server db:check && pnpm format:check` (full run repeated 3 times, no flakes)

```text
packages/shared test:       Tests  15 passed (15)
apps/server test:  Test Files  14 passed (14)
apps/server test:       Tests  210 passed (210)
db:check ok: schema matches 1 committed migration(s)
All matched files use Prettier code style!
```

Smoke (`pnpm --filter server build`, temp `DATA_DIR`, `node dist/index.js`, curl with a cookie jar): `/setup/status` showed both directories writable; `/users` gave 503 `setup_required`; `POST /setup/admin` gave 201 with an HttpOnly cookie; `POST /auth/logout` without the CSRF header gave 403; login gave 200; `GET /auth/me` showed `authMethod: session` plus the CSRF token; `POST /setup/complete` without the header gave 403 `csrf_invalid`, with `x-csrf-token` 200; `GET /users?q=adm` gave 200; `GET /settings/mediaServer` showed the masked key; an API key created through the session then authenticated `GET /auth/me` via `Authorization: Bearer`. The bundled build loads argon2 as an external module.

**Deviations:** no schema change and no new migration. `POST /auth/logout` is deliberately public (it clears whatever cookie it gets); the matrix allowlists it. DECISIONS.md not amended.

**Next:** H-07 (Jellyfin login: use `users.findOrCreateExternalUser('jellyfin', ...)`, `auth.startSession(request, reply, userId)` and `app.hearer.settings`). Later route batches add `onRequest: [requirePermission(...)]` and must extend the matrix allowlists only when a route is truly public.

**Open questions:** `PUT /settings/:key` is full-replace; the web settings UI must send the whole section (masked secrets echoed back). Also, with `auth.localEnabled=false` and no other provider enabled the API refuses the change, but an operator who disables local auth and later loses the external provider must recover through the database.

## H-07 — Jellyfin adapter + Jellyfin login + user import

**Status:** done (fixtures synthesized; nothing verified against a live Jellyfin)

**Shipped:**

- `adapters/mediaserver/types.ts`: `MediaServerAdapter` per PLAN, `ServerInfo`, `ExternalUser`, `LibraryItem`, `MediaServerError` / `MediaServerAuthError` / `MediaServerUnavailableError` / `MediaServerNotConfiguredError`.
- `adapters/mediaserver/jellyfin.ts`: native `fetch`, `AbortSignal.timeout`, base URL normalization (sub-path kept), the `Authorization: MediaBrowser ...` header only (escaped values, Token only on API-key calls), `testConnection` (`/System/Info`, `versionSupported` false below 10.10), `authenticate` (`/Users/AuthenticateByName`, then closes the session it opened), `listUsers`, `iterateLibrary` (async generator, paged, `MinDateLastSaved`, `ParentId` per `libraryIds`), `notifyPathsChanged` with `/Library/Refresh` fallback, `itemUrl`. ProviderIds mapping documented in `docs/ADAPTERS.md` and `PROVIDER_KEYS` (accepts both `MusicBrainzRecording` and `MusicBrainzTrack`).
- `adapters/mediaserver/registry.ts`: `getMediaServer(settings, deps)` and `MediaServerRegistry` (`app.hearer.mediaServer.get()/forCandidate()/isConfigured()`). `DeviceId` is derived from the secret key (`SecretBox.deriveId`), so nothing new is stored.
- `auth/jellyfin.ts` + `POST /api/v1/auth/jellyfin` (public, rate limited, CSRF-exempt, respects `auth.jellyfinEnabled`; errors for this public route do not reveal the server URL). New accounts get `general.defaultPermissions` minus UPLOAD; Jellyfin admins do not become Hearer admins (reasons in `docs/ADAPTERS.md`). `UsersService.findOrCreateExternalUser` gained an optional `{permissions}` override, plus `getByExternal`.
- Admin routes: `POST /settings/mediaServer/test` (always 200 `{ok, server | error}`, masked key = stored key), `GET|POST /users/import/jellyfin`, setup wizard section `mediaServer` (`PUT /setup/mediaServer` tests the connection first and stores the server id; 400 `media_server_test_failed` otherwise).
- Shared: `mediaServer.externalUrl` setting, `dto/mediaserver.ts`.
- Fixtures `apps/server/test/fixtures/jellyfin/*` (README marks them synthesized), a real `node:http` mock (`test/helpers/jellyfin-mock.ts`), tests `jellyfin.adapter`, `jellyfin.routes`, opt-in `jellyfin.live` (needs `JELLYFIN_TEST_URL` + `JELLYFIN_TEST_API_KEY`). The route matrix allowlist gained only `POST /api/v1/auth/jellyfin`.
- `docs/ADAPTERS.md`: both contracts, Jellyfin endpoints, header, key mapping, live test instructions.

**Verify:** `pnpm --filter server test -- jellyfin` and `pnpm -r lint && pnpm -r typecheck && pnpm -r test && pnpm --filter server db:check && pnpm format:check` (see output in the handback report).

**Deviations:** more than 8 files (adapter, registry, auth, mock, three test files, fixtures). No schema change or migration. DECISIONS.md not amended. `ProviderIds` recording key unverified (PLAN asked for a live check in H-07; none was possible).

**Next:** H-10 (library sync can use `app.hearer.mediaServer.get().iterateLibrary`).

**Open questions:** (1) Verify `MusicBrainzTrack` vs `MusicBrainzRecording` on a real 10.11 server. (2) Jellyfin item paths are returned as Jellyfin sees them; if its mount differs from Hearer's `MUSIC_DIR`, `notifyPathsChanged` and path matching need a configurable prefix mapping. (3) Jellyfin does not expose email, so Jellyfin users have none.

## H-08 — OIDC login

**Status:** done

**Files:** `apps/server/src/auth/oidc.ts`, `src/routes/oidc.ts`, `packages/shared/src/settings.ts` (`auth.oidc`), small edits to `app.ts` (one registration block), `routes/setup.ts` (gate), `services/users.ts` (`getExternal`, `findByEmail`), tests `test/oidc.{flow,policy,config}.test.ts`, `test/helpers/mock-idp.ts`, and the public allowlist in `test/auth.matrix.test.ts`. Deps: `openid-client` 6.8.9 and `jose` 6.2.15 (catalog-pinned; both production dependencies).

**Shipped:**

- Generic OIDC (Authorization Code + PKCE S256 + state + nonce) on `openid-client` v6's functional API. Discovery is cached for 1 h per (issuer, client id, secret, allowInsecureHttp) so a settings change re-discovers; a failed discovery is remembered for 30 s. The ID token algorithm is taken from discovery (RS256 default, ES256 etc. work). Client auth is `client_secret_basic` (or none when no secret is set).
- **ID token signature:** openid-client (like OIDC Core 3.1.3.7) does not verify the signature of a token received directly from the token endpoint, and a test proved a token signed by a different key was accepted. Hearer therefore also verifies it with `jose` against the IdP's JWKS (issuer, audience, pinned algorithm). `jwks_uri` must be https unless `allowInsecureHttp` is on.
- **Transaction:** state, nonce, PKCE verifier, `returnTo`, `createdAt` sealed with the app SecretBox (AES-256-GCM) into cookie `hearer_oidc_tx` (httpOnly, SameSite=Lax, Path `/api/v1/auth/oidc`, 10 min, Secure per the same rule as the session cookie). Single use: the state is remembered in process memory once redeemed (single-instance deployment), and the cookie is cleared on success and failure. Concurrent logins in two tabs share one cookie, so the last started one wins.
- Routes: `GET /auth/oidc/config`, `GET /auth/oidc/login?returnTo=`, `GET /auth/oidc/callback` (public, rate limited), `POST /settings/auth/oidc/test` and `GET /settings/auth/oidc/redirect-uri` (MANAGE_SETTINGS). Callback errors redirect to `/login?error=<code>` with a fixed code (`invalid_transaction`, `transaction_expired`, `transaction_replayed`, `state_mismatch`, `access_denied`, `not_allowed`, `signup_disabled`, `link_denied`, `oidc_disabled`, `login_failed`, `oidc_unavailable`); details go to the log only. Disabled OIDC: login answers 404 `oidc_disabled`, callback redirects with `oidc_disabled`.
- **Gate:** these routes live under the open `auth` prefix but the setup gate now special-cases `/api/v1/auth/oidc`, so they answer 503 `setup_required` until the wizard finishes (matrix test updated, three routes added to the public allowlist).
- **Settings (`auth.oidc`)** new fields: `groupsClaim`, `adminGroup`, `allowedGroups[]`, `linkExistingByEmail` (false), `linkAdminAccounts` (false), `allowInsecureHttp` (false); existing `usernameClaim`/`emailClaim` now non-empty. `adminGroup`/`allowedGroups` require `groupsClaim` (validated). Redirect URI = `general.applicationUrl`, else `BASE_URL`, else the request origin, plus `/api/v1/auth/oidc/callback`; register it at the IdP. It is normalized through `URL` (a literal `:80`/`:443` is dropped, because openid-client sends the normalized form).
- **Account policy:** `allowedGroups` gates every login (existing users too). Known `sub` signs in as that user and refreshes name/avatar; email is stored/refreshed only when `email_verified` is true. With `linkExistingByEmail` off (default) the same email yields a **separate** account (nothing is linked or denied). With it on, a verified email matching exactly one local/Jellyfin account signs in as that account (the row is not rewritten); several matches or an ADMIN account (without `linkAdminAccounts`) are denied (`link_denied`). Account-takeover risk: an IdP that lets users set an unverified or someone else's email could take over the matching local account; leave it off unless the IdP verifies emails. `autoCreateUsers=false` denies unknown users. Members of `adminGroup` get ADMIN on login (grant only, never revoked automatically). Group names are compared after stripping a leading `/` (Keycloak paths).
- Usernames are sanitized to the shared username rules (`preferred_username`, else email, else `sub`) and de-duplicated by the users service.
- Cleartext IdPs: `auth.oidc.allowInsecureHttp` (and the same flag in the test endpoint body) enables openid-client's documented `allowInsecureRequests`; the tests use it with a local mock IdP.

**Verify:** `pnpm --filter server test -- oidc` (the filter arg is ignored by vitest-run, the whole server suite runs) plus `pnpm -r lint && pnpm -r typecheck && pnpm -r test && pnpm --filter server db:check && pnpm format:check`

````text
packages/shared test:       Tests  15 passed (15)
apps/server test:  Test Files  17 passed (17)
apps/server test:       Tests  285 passed (285)
## H-09 — MusicBrainz + Cover Art Archive client, rate limiter, cache, search API

**Status:** done

**Shipped:**

- `lib/ratelimit.ts`: `RateLimiter` (FIFO serial release, at most one caller per `intervalMs`, `AbortSignal`, `penalize(ms)` for Retry-After, injectable clock), `getMusicBrainzLimiter()` process-global singleton at 1 request/second, `parseRetryAfter`.
- `adapters/metadata/types.ts`: `MetadataProvider` (searchArtists/ReleaseGroups/Recordings, getArtist, getArtistReleaseGroups, getReleaseGroup, getRelease, getRecording), `MetadataError`. DTO zod schemas live in `packages/shared/src/dto/catalog.ts` (summaries, details, pages, queries, badges, `mbidSchema`).
- `adapters/metadata/musicbrainz.ts`: WS/2 JSON client. Base URL from `metadata.musicBrainzBaseUrl` (read per request, so mirrors apply live), UA from shared `userAgent()`. Lucene escaping (`escapeLucene`; operators quoted), field-scoped queries (`releasegroup:(t) OR artist:(t)`, `artist:(t) OR alias:(t)`, `recording:(t) OR artist:(t)`). Every call: `mb_cache` lookup (key = normalised URL, sorted params), single-flight coalescing (refcounted, a flight is dropped when its last waiter aborts), global limiter, 503/429 retry (bounded, `Retry-After` or exponential backoff, capped at 60 s, penalises the shared limiter so other callers wait too), stale-while-error (stale row served and logged on 5xx/network failure; never for 404). Responses are validated with lenient zod schemas before they are cached.
- Representative release (`pickRepresentativeRelease`, documented in code): Official only, then Digital Media/CD-only releases, then most common total track count (tie goes to the earliest release's count), then earliest date (full date before a bare year, undated last), then release id. A release group costs 3 cached calls (lookup, release browse with `inc=media` limit 100, release with `inc=recordings+artist-credits+isrcs`).
- Recordings: the "home" release group is the studio album (primary Album, no secondary types) with the earliest date, not whatever MusicBrainz lists first (live bootlegs often come first).
- `adapters/metadata/coverart.ts`: deterministic `coverArtUrl()` (no network during search), `fetchFrontCover(mbid, size, opts)` for H-15 (redirects, 15 MB cap declared and streamed, JPEG/PNG only, timeout, abort, own 250 ms limiter; 404 gives null).
- `services/badges.ts`: `LibraryLookup` interface + `MbidLibraryLookup` (exact MBID, one query per kind) and `lookupRequests` (latest non-cancelled per type+mbid, one query per page); `BadgeService` combines them. `AppDeps.libraryLookup` is the H-10 seam.
- `routes/search.ts` (all `requireAuth`, `@fastify/rate-limit` 60/min keyed by user id, falling back to IP): `GET /search?q&type=artist|album|track&offset&limit`, `/artists/:mbid`, `/artists/:mbid/albums?type&offset&limit`, `/albums/:mbid`, `/tracks/:mbid`. Limit at most 50, offset at most 10000, MBIDs validated and lower-cased. MusicBrainz 404 gives 404, unavailable gives 502 `metadata_unavailable`.
- Fixtures in `test/fixtures/musicbrainz/` are trimmed real responses (Radiohead / OK Computer) fetched once at 1 request per 1.5 s; tests serve them from a local HTTP server (`test/helpers/mbServer.ts`), never the network.
- Settings: `metadata.cacheTtlDays` replaced by `metadata.cacheTtl {entityDays: 7, searchDays: 1}` (nothing else used the old field).
- `app.ts`: small block registering the metadata provider (`AppDeps.metadata`, `metadataOptions`, `libraryLookup`, `searchRateLimitMax` for tests) and the search routes. The route matrix allowlist gained the five new routes as authenticated-only.

**Verify:** `pnpm --filter server test -- metadata`, then `pnpm -r lint && pnpm -r typecheck && pnpm -r test && pnpm --filter server db:check && pnpm format:check`

```text
apps/server test:  Test Files  18 passed (18)
apps/server test:       Tests  296 passed (296)
db:check ok: schema matches 1 committed migration(s)
Checking formatting...
All matched files use Prettier code style!
````

The mock IdP (`test/helpers/mock-idp.ts`) is a real node:http server on port 0 with discovery, JWKS (jose keys), `/authorize` and `/token` (client auth, PKCE S256 check, single-use codes, signed RS256/ES256 ID tokens). `pnpm --filter server build` also bundles fine.

**Deviations:** no schema change; DECISIONS.md not amended. Claims come from the ID token only (no userinfo call), so an IdP that omits profile claims from the ID token needs them added there (Keycloak includes them with the default scopes).

**Next:** H-07 / web login UI should read `GET /auth/oidc/config`, link the button to `/api/v1/auth/oidc/login?returnTo=...`, and render `/login?error=<code>`; the settings UI should show `GET /settings/auth/oidc/redirect-uri` and call the test endpoint.

**Open questions:** none.
**Deviations:** No cover image proxy route (optional in the brief); the UI uses Cover Art Archive URLs directly. DECISIONS.md not amended.

**Next:** H-10 (implement a fuzzy `LibraryLookup` and pass it as `AppDeps.libraryLookup`).

**Open questions / notes for H-16:** the CSP `img-src` must allow `https://coverartarchive.org` and `https://*.archive.org` (the archive answers 307 to archive.org), and covers can 404, so the UI needs an `onerror` fallback. Cover URLs are the 250 px variant; swap `front-250` for `front-500`/`front-1200` for larger renders. Release groups with more than 100 releases only consider the first 100 for the representative-release choice.

## H-10 — Library index sync + availability matcher

## H-13 — Upload receive (tus) + validation

**Status:** done

**Shipped:**

- `lib/normalize.ts`: `normalizeTitle`, `normalizeArtist`, `normKey` (rules and the noise vs meaningful suffix lists in the file header and `docs/MATCHING.md`). 80+ table tests incl. CJK, Cyrillic, Hangul, dakuten, empty/symbol-only input.
- `services/library.ts` (`LibraryService`): `sync('incremental'|'full')` over `iterateLibrary`, upsert by `server_item_id` in transactions of 500, mark-and-sweep delete on `synced_at` only after a fully successful full run (also skipped when the server returned nothing while the index is not empty), sync state in the `settings` table under the internal key `library.syncState` (not in the shared catalog, so the settings API cannot touch it; no schema change). `status()`, `toLocalPath`/`toServerPath` (pure functions plus service methods).
- `jobs/librarySync.ts`: job `library.sync` `{mode}`, concurrency 1, 3 attempts; auth/not-configured errors are permanent; schedules incremental every 15 min and full daily at 03:00, registered unconditionally (the handler is a no-op with a debug log while no media server is set, because settings change at runtime); enqueues `requests.availability` after success only if that type is registered.
- `jobs/scheduler.ts` (H-04): `ScheduleSpec.key` so one job type can carry several schedules (`schedule:<type>:<key>` unique key); unchanged when `key` is omitted.
- `services/availability.ts`: `FuzzyLibraryLookup` (default `libraryLookup`; same interface, fixed queries per page), `AvailabilityMatcher.evaluateRequest(request, run?)` for track/album/artist and `AvailabilityRun` (per-run memoization of MusicBrainz calls). `services/badges.ts`: `CatalogIds.hints` (optional name hints); `routes/search.ts` passes hints from the catalog items it holds.
- `routes/library.ts`: `GET /api/v1/library/status`, `POST /api/v1/library/sync {mode}` (202, unique key per mode, 409 when no media server), both MANAGE_SETTINGS. `app.hearer.library` and `app.hearer.availability` exposed.
- Shared: `mediaServer.pathMappings: [{serverPath, localPath}]` (default `[]`).
- `docs/MATCHING.md` documents the index, path mapping, normalization and all matching rules.
- Tests: `library.normalize`, `library.sync` (fake and Jellyfin-mock servers, partial failure, batching, scheduler, job, path mapping), `library.match` (lookup incl. the 3.0/3.1 s boundary, evaluateRequest for all kinds, `/search` badge, admin routes). The H-09 test that bounded library queries per album page now allows 4 (exact + fuzzy per kind).

**Verify:** `pnpm --filter server test -- library`, then `pnpm -r lint && pnpm -r typecheck && pnpm -r test && pnpm --filter server db:check && pnpm format:check` (see the handback report for the output).

**Deviations:** no schema change; DECISIONS.md not amended. `evaluateRequest` returns an extra `possible` list. More than 8 files (three test files, docs, route).

**Next:** H-11 should define `requests.availability` (payload `{}` is enqueued with `uniqueKey: 'requests.availability'` after each sync), create one `matcher.newRun()` per pass, and call `app.hearer.availability.evaluateRequest`. H-15 uses `app.hearer.library.toServerPath` for `notifyPathsChanged`. H-13/H-14 can use `normKey` for duplicate checks.

**Open questions:** (1) Server-vs-local paths: resolved by `mediaServer.pathMappings`; there is no UI for it yet (H-16 settings). (2) Incremental sync cannot see deletions; the nightly full sweep removes them. (3) Only the first credited artist of a Jellyfin track is indexed, so tracks credited to a duo only match when the MusicBrainz credit also yields that first name (the matcher tries every credit spelling).

- `routes/uploads.ts`: `@tus/server` 2.4.7 + `@tus/file-store` at `/api/v1/uploads/tus` (datastore `${STAGING_DIR}/tmp`, created lazily on first use). Fastify parser for `application/offset+octet-stream` leaves the stream untouched; POST/HEAD/PATCH/DELETE/OPTIONS on `/uploads/tus` and `/uploads/tus/*` call `tus.handle(req.raw, reply.raw)` after `reply.hijack()`. Guard: UPLOAD permission (cookie or API key); the global CSRF hook already covers POST/PATCH/DELETE. CORS is off (`allowedOrigins: []`). Locations are relative.
- Chunk limit 50 MiB (`MAX_UPLOAD_CHUNK_BYTES` in shared): PATCH (and POST creation-with-upload) must send `Content-Length`; above 50 MiB gives 413 `chunk_too_large`, no length gives 411; the connection is closed. Clients must use `chunkSize` below 50 MiB (H-19: 50 MiB minus a margin) and must not use chunked encoding. Error bodies from tus hooks are the JSON envelope text.
- Ownership: every HEAD/PATCH/DELETE looks up the DB row; another user (even an admin) gets 404. Admins/managers cancel others' uploads through `DELETE /uploads/:id`.
- `onUploadCreate`: metadata (`filename` required, `batchId`/`targetRequestId` optional uuids, batch ids not shared across users, request must exist), extension allowlist (`aif` rides with `aiff`), size vs `uploads.maxFileSizeMb` (413), deferred/zero length 400, quota (403; user override or `general.defaultUploadQuota`, 0 = unlimited, ADMIN exempt, in-flight counted, REJECTED excluded, check+insert in one transaction), inserts a RECEIVING row. `onUploadFinish` marks RECEIVED, enqueues `upload.probe`, and returns `X-Hearer-Upload-Id`.
- `jobs/uploadProbe.ts`: `upload.probe` (ffprobe via `lib/ffprobe.ts`: execFile arg array, timeout, JSON; needs an audio stream, duration > 0, codec allowlist and container that agrees with the extension; streamed sha256; move to `${STAGING_DIR}/<uploadId>/<sanitized name>` with an EXDEV fallback; sidecar deleted; idempotent after a crash; cancelled mid-job cleans up; `upload.analyze` enqueued only when registered). Invalid media gives REJECTED + message + files deleted; ffprobe unavailable retries, then FAILED. `upload.expire` (hourly) rejects RECEIVING rows whose tus files are stale (>24 h).
- `lib/paths.ts`: `sanitizeFileName` (NFKC so look-alikes are neutralised, last segment only, control/bidi chars, reserved chars, dot runs, Windows device names, 200 UTF-8 bytes keeping the extension, `untitled`) and `assertInside` (realpath of the deepest existing ancestor, segment-safe, symlink-aware).
- API: `GET /uploads` (own; `?all=1` needs MANAGE_UPLOADS; status/batch filters; limit/offset), `GET /uploads/:id`, `DELETE /uploads/:id` (cancel in pre-import states, else 409), `GET /uploads/config`. DTOs in `packages/shared/src/dto/uploads.ts`.
- Migration `0001_uploads_probe.sql`: `uploads.probe_json` (container, codec, channels, bitsPerSample).
- CI `check` job installs `ffmpeg libchromaprint-tools`. Deps pinned in the catalog: @tus/server 2.4.7, @tus/file-store 2.1.2, tus-js-client 4.3.1 (dev).
- Tests (`test/uploads.receive.{paths,tus,api}.test.ts`, helper `test/helpers/uploads.ts`): audio generated with ffmpeg at test time (nothing committed); real listening server + tus-js-client; multi-chunk, all formats, resume after a cut PATCH, 50 MiB / 411 limits, size, quota (in-flight, window, default, admin), disallowed ext, renamed .txt and mismatched content, 401/403/404, CSRF, traversal names, cancel, REST routes, expire job. The route matrix test passes unchanged.

**Verify:** `pnpm -r lint && pnpm -r typecheck && pnpm -r test && pnpm --filter server db:check && pnpm format:check` (all green; `pnpm --filter server build` bundles tus fine)

```text
db:check ok: schema matches 2 committed migration(s)
Checking formatting...
All matched files use Prettier code style!
```

**Deviations:** Chunked transfer encoding is refused (411) instead of counting bytes mid-stream, because Node cannot be tapped without consuming the body; Content-Length is enforced by Node's parser. Disallowed extension returns 400 (not 415). DECISIONS.md not amended.
**Next:** H-14 (analyze) can register `upload.analyze`; H-15 can reuse `sanitizeFileName`/`assertInside`.
**Open questions:** A tus create that fails after the DB insert leaves a RECEIVING row until `upload.expire` clears it (24 h), counting against quota until then.

## H-14 — Analyze: fingerprint, AcoustID, candidate scoring, dedupe, review API

**Status:** done

**Shipped:**

- `lib/fpcalc.ts`: `fpcalc(path, {binary, timeoutMs, lengthSeconds})` (`-json -length 120`, arg array, absolute path only), `FpcalcUnavailableError` (missing binary) vs `FpcalcError`. Neither is fatal for the job.
- `adapters/metadata/acoustid.ts`: `AcoustIdClient.lookup(fingerprint, seconds)` posts the form to `{metadata.acoustIdBaseUrl}/lookup` (`meta=recordings releasegroups releases tracks compress`), key from `metadata.acoustIdApiKey`, UA like MB, own process-global limiter (340 ms, at most 3/s), `{status:'disabled'}` plus one log line with no key, error envelope mapped to `AcoustIdError` kinds (`auth` for codes 4/6, `unavailable` for 5, 429/503 (penalises the limiter), network and 5xx, `bad_request`, `bad_response`).
- `lib/audioTags.ts`: existing-tag reader on `music-metadata` 12.3.4 (pinned in the catalog).
- `services/matching.ts`: scoring (`similarity`, `durationScore`, `trackScore`, `combineScore`, weights and the 0.95 unfingerprinted factor, all in `docs/MATCHING.md`), `MatchingService.match` (AcoustID + tag-id + MB tag search leads, top 5 detailed through the cached `MetadataProvider`, `rankReleases` release choice), `MatchingService.group` (album grouping), `DuplicateChecker` (sha256 and library checks, reusing `FuzzyLibraryLookup`).
- `jobs/uploadAnalyze.ts`: `upload.analyze` (concurrency 2, 3 attempts). RECEIVED to ANALYZING to NEEDS_REVIEW or DUPLICATE; stores `fingerprint`, `match_json`, `chosen_json`. Transient MB/AcoustID errors retry; the last attempt tolerates AcoustID trouble and otherwise sets FAILED. The last file of a batch groups the album, then every member is finalized.
- `services/uploadReview.ts` (`app.hearer.uploadReview`): `finalize` (auto-approve when the uploader has AUTO_APPROVE_UPLOAD, score >= `uploads.autoApproveThreshold`, no duplicate; else `upload.needs_review` once), `review`, `approve`, `reject`, `keep`, `reanalyze`, `batchApprove`, `detail`. Approve enqueues `upload.import` only when that job type is registered.
- `routes/uploads.review.ts`: `PUT /uploads/:id/review`, `POST /uploads/:id/{approve,reject,keep,reanalyze}`, `POST /uploads/batch/:batchId/approve`. `GET /uploads/:id` now returns `UploadDetail` (match, chosen, canKeep). All guarded by UPLOAD or MANAGE_UPLOADS, then finer rules; other people's uploads are 404; the route matrix passes unchanged.
- Shared DTOs in `dto/uploads.ts`: `TagSet` (+ `coverSource`), `MatchCandidate`, `MatchResult`, `AlbumGroup`, `UploadDetail`, review/reject/keep bodies. Settings: `uploads.allowDuplicateOverride` (default false) and `metadata.acoustIdBaseUrl`.
- Tests (`test/uploads.analyze.{units,acoustid,job,group,review}.test.ts`, helpers `analyze.ts`, `acoustIdServer.ts`): fpcalc on ffmpeg audio, missing/hung/junk binaries, tags, scoring curves, AcoustID against a local server (success, envelope, disabled, limiter, abort), job end to end with the H-09 MB fixtures (AcoustID path, tags-only path, missing fpcalc, key rejected, auto-approve met / not met / no permission, duplicates a/b/c plus tie-break, kept override, retries and final-attempt failure), batch grouping (e2e and with a fake provider that proves re-ranking), review routes with permission, IDOR and `targetRequestId` validation, events.

**Verify:** `pnpm --filter server test -- uploads.analyze`, then `pnpm -r lint && pnpm -r typecheck && pnpm -r test && pnpm --filter server db:check && pnpm format:check`

```text
apps/server test:  Test Files  34 passed | 1 skipped (35)
apps/server test:       Tests  812 passed | 4 skipped (816)
db:check ok: schema matches 2 committed migration(s)
Checking formatting...
All matched files use Prettier code style!
```

**Deviations:**

- No schema change (the `0003_*` migration name was not needed). DECISIONS.md not amended.
- More than 8 files: source split into fpcalc, audioTags, acoustid, matching, uploadReview, uploadAnalyze, routes; tests into 5 files plus 2 helpers.
- `uploads.allowDuplicateOverride` is a boolean that defaults to **false**: MANAGE_UPLOADS can always override; the setting extends it to owners with UPLOAD.
- Existing H-13 tests (`uploads.receive.*`) no longer assume an upload rests in RECEIVED after the probe, because `upload.analyze` is now registered and advances it.
- The `upload.duplicate` event is not in the shared `NOTIFICATION_EVENTS` list (only `upload.needs_review` is); it is emitted on the bus all the same.
- The event bus is looked up at emit time as `(app.hearer as {events?: UploadEventSink}).events` (a minimal local interface with `emit(event, payload)`); orchestrator: when H-11 lands, check its `emit` signature matches or adapt the getter in `app.ts`. H-15: `upload.import` is enqueued as `{uploadId}` with `uniqueKey: import:<id>` and must check the status is APPROVED; `chosen_json` is a valid `TagSet`, `target_request_id` is already validated.
- Tag-only matches are capped at 0.95, so a tagged file with no AcoustID key can still auto-approve (documented).
- Fuzzy duplicate (c) uses `FuzzyLibraryLookup`, which treats an unknown library duration as compatible.

**Next:** H-15 (import), H-19 (review UI uses `UploadDetail`, `TagSet`, the review routes).

**Open questions:** a batch with a member stuck in RECEIVING defers grouping and auto-approval until that member finishes, fails or expires (24 h). Release choice inspects the best 3 releases of a group, so a recording that appears only on later releases falls back to the representative release with the file's own track number.
