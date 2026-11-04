# Hearer — build plan

Locks: [DECISIONS.md](./DECISIONS.md) (wins on conflict).
Execution model: **one batch per chat/run**. Each batch ends green on its verify command and with a Handoff note (below) committed in the batch.

## Objective

Build **Hearer**, an MIT-licensed, single-container, Seerr-style portal for music. Users sign in with their media-server (Jellyfin) account, local account or OIDC. They search MusicBrainz, request tracks/albums/artists, or upload files. Requests go through approval and are fulfilled by pluggable providers (Manual-by-upload, Lidarr). Uploads are fingerprinted, matched, reviewed, tagged, filed into the library by a naming template, and the media server is told to rescan. Hearer detects when requested items become available and notifies people. It must drop into the author's reference homelab (`thenetwork`) and also work with `docker run` on any box with a music folder.

## Scope

**In (v1.0)**

- Setup wizard: admin account, media server, library/staging paths, naming template, providers, notifications
- Auth: Jellyfin, local, OIDC; sessions + API keys; Seerr-style permission bitmask; per-user request/upload quotas
- Search (artists, release groups, recordings) with cover art, and "in library" / "requested" badges
- Requests: create, approve/decline (with reason), retry, cancel; status timeline; auto-approve permission
- Fulfillment providers: Manual, Lidarr
- Library index sync from Jellyfin + availability matching (MBID first, fuzzy fallback)
- Uploads: resumable multi-file, validation, AcoustID fingerprint match, metadata review/edit, duplicate detection, tag write + cover embed, templated move, targeted rescan, optional "fulfills request #N"
- Notifications: webhook, Discord, Slack, ntfy, SMTP; per-event toggles; per-user opt-in for their own requests
- Admin: users, requests queue, uploads queue, jobs/logs view, settings
- Docs, `docker-compose.example.yml`, multi-arch GHCR image, homelab manifests

**Out (v1.0):** see decisions § "Out of scope".

## 0. Bootstrap (done; reference for forks)

Already completed for the upstream repository. If you fork Hearer, repeat the relevant steps:

1. Create an **empty** public GitHub repo named `hearer`. Batch H-01 adds the README, license and the rest of the skeleton.
2. Use this file and [DECISIONS.md](./DECISIONS.md) as the build brief. They live in the repo as `docs/PLAN.md` and `docs/DECISIONS.md`, so the project is self-contained when forked.
3. Optional: mirror the repo to any other forge (Forgejo, Gitea, GitLab).
4. Register an **AcoustID application key** (free, acoustid.org) for local testing; it becomes a setting, never committed.

Batch H-23 (homelab deployment manifests) lives in the separate `homelab-infra` repository, not here. It is listed in the table below for completeness only.

---

## Architecture

```
            ┌──────────────── hearer container ────────────────┐
 browser ──▶│ Fastify  /api/v1  ── services ── Drizzle/SQLite  │── /data (db, cache, logs)
            │   │ static web (React)        │                  │
            │   │ tus /api/v1/uploads/tus   ▼                  │
            │   └──────────────▶ job worker (DB queue)         │── /staging (uploads in flight)
            │                    │  ffprobe · fpcalc · tagger  │── /music  (library, rw)
            └────────────────────┼─────────────────────────────┘
                                 ├─▶ Jellyfin    (auth, items, /Library/Media/Updated)
                                 ├─▶ MusicBrainz / Cover Art Archive / AcoustID
                                 ├─▶ Lidarr      (optional)
                                 └─▶ webhook / Discord / Slack / ntfy / SMTP
```

### Repo layout (target)

```
hearer/
├── apps/server/src/
│   ├── index.ts, app.ts, config.ts          # env (zod), Fastify bootstrap
│   ├── db/schema.ts, db/migrate.ts, drizzle/ # migrations committed
│   ├── auth/                                 # sessions, api keys, permissions, oidc
│   ├── adapters/mediaserver/{types,jellyfin}.ts
│   ├── adapters/metadata/{types,musicbrainz,coverart,acoustid}.ts
│   ├── adapters/fulfillment/{types,manual,lidarr}.ts
│   ├── adapters/notify/{types,webhook,discord,slack,ntfy,smtp}.ts
│   ├── jobs/{runner,registry}.ts + jobs/*.ts
│   ├── services/{requests,uploads,library,import,users,settings}.ts
│   └── routes/*.ts
├── apps/web/src/{routes,components,api,hooks}
├── packages/shared/src/                      # zod schemas, enums, permission bits, DTOs
├── docker/Dockerfile, docker-compose.example.yml
├── docs/{PLAN,DECISIONS,CONFIGURATION,ADAPTERS,DEPLOY}.md
└── .github/workflows/{ci,release}.yml, ISSUE_TEMPLATE/, CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md
```

### Data model (SQLite, Drizzle)

| Table                  | Key columns                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                | id, username, email, display_name, avatar, auth_type (`local`/`jellyfin`/`oidc`), external_id, password_hash (argon2id, local only), permissions (int bitmask), request_quota_limit/days, upload_quota_mb/days, created_at      |
| `sessions`             | id (random 32B), user_id, expires_at, ip, user_agent                                                                                                                                                                            |
| `api_keys`             | id, user_id, name, hash, last_used_at                                                                                                                                                                                           |
| `settings`             | key, value_json (typed by zod per key)                                                                                                                                                                                          |
| `mb_cache`             | url_key, body_json, fetched_at, ttl                                                                                                                                                                                             |
| `requests`             | id, type (`track`/`album`/`artist`), mbid, title, artist_name, cover_url, status, requested_by, decided_by, decline_reason, provider_id, provider_ref, fulfilled_by_upload_id, created_at, updated_at                           |
| `request_events`       | request_id, at, actor, from_status, to_status, note (timeline)                                                                                                                                                                  |
| `uploads`              | id, batch_id, uploader_id, original_name, staging_path, size, sha256, format, duration_ms, bitrate, sample_rate, fingerprint, status, match_json (candidates), chosen_json (final tags), library_path, target_request_id, error |
| `library_items`        | server_item_id, kind (`artist`/`album`/`track`), name, artist_name, album_name, duration_ms, mb_recording_id, mb_release_group_id, mb_artist_id, norm_key, path, synced_at                                                      |
| `jobs`                 | id, type, payload_json, status, attempts, max_attempts, run_after, locked_by, locked_at, last_error, created_at                                                                                                                 |
| `notification_targets` | id, agent, config_json (secrets encrypted), events (bitmask), enabled                                                                                                                                                           |

**Request statuses:** `PENDING → APPROVED → PROCESSING → AVAILABLE`, plus `DECLINED`, `FAILED`, `PARTIALLY_AVAILABLE` (album/artist), `CANCELLED`, `AWAITING_UPLOAD` (Manual provider).
**Upload statuses:** `RECEIVING → RECEIVED → ANALYZING → NEEDS_REVIEW → APPROVED → IMPORTING → IMPORTED`, plus `REJECTED`, `DUPLICATE`, `FAILED`.

### Permissions (bitmask in `packages/shared`)

`ADMIN`, `MANAGE_USERS`, `MANAGE_SETTINGS`, `REQUEST`, `REQUEST_ALBUM`, `REQUEST_ARTIST`, `AUTO_APPROVE`, `MANAGE_REQUESTS`, `UPLOAD`, `AUTO_APPROVE_UPLOAD`, `MANAGE_UPLOADS`, `VIEW_ALL_REQUESTS`. Default for new users is configurable, initially `REQUEST | REQUEST_ALBUM | UPLOAD`. `ADMIN` implies all.

### Adapter contracts (summary — full TS in `docs/ADAPTERS.md`)

```ts
interface MediaServerAdapter {
  id: 'jellyfin' | string;
  testConnection(): Promise<ServerInfo>;
  authenticate(username: string, password: string): Promise<ExternalUser>; // login flow
  listUsers?(): Promise<ExternalUser[]>; // import users
  iterateLibrary(opts: { since?: Date }): AsyncIterable<LibraryItem>; // index sync
  notifyPathsChanged(paths: string[]): Promise<void>; // targeted rescan
  refreshLibrary(): Promise<void>; // full-scan fallback
  itemUrl?(serverItemId: string): string; // "Open in Jellyfin"
}

interface FulfillmentProvider {
  id: string;
  label: string;
  supports: { track: boolean; album: boolean; artist: boolean };
  configSchema: ZodSchema; // drives the settings form
  submit(req: RequestRecord): Promise<{ ref: string; status: 'PROCESSING' | 'AWAITING_UPLOAD' }>;
  poll?(ref: string): Promise<{ state: 'pending' | 'done' | 'failed'; detail?: string }>;
  cancel?(ref: string): Promise<void>;
}
```

- **Jellyfin**: `POST /Users/AuthenticateByName`; library via `GET /Items?IncludeItemTypes=Audio,MusicAlbum,MusicArtist&Recursive=true&Fields=ProviderIds,Path&StartIndex&Limit` paged; rescan via `POST /Library/Media/Updated` with `{ Updates:[{ Path, UpdateType:"Created" }] }`, falling back to `POST /Library/Refresh`. MBIDs come from `ProviderIds` (exact key names for recording vs. track IDs **must be verified in H-07** against a live 10.11 server and recorded in `docs/ADAPTERS.md`).
- **Lidarr** (`/api/v1`, `X-Api-Key`): artist via `artist/lookup?term=lidarr:<mbid>` → `POST artist` (monitored per request type, root folder + quality/metadata profile from settings) → album monitor → `POST command {name:"AlbumSearch"}`. Track request → resolve parent release group; admin setting `lidarrTrackPolicy: 'album' | 'skip'` (`skip` hands it to Manual). Completion is detected by **library availability sync**, not Lidarr state, so imports to any path work.
- **Manual**: sets `AWAITING_UPLOAD`; any user with `UPLOAD` can pick "fulfills request" during upload review. On import → request `AVAILABLE`.

### Upload pipeline (jobs)

1. **Receive** — tus (`@tus/server` + file store in `/staging/tmp`), chunk ≤ 50 MB, per-file max size setting (default 2 GB), user quota check at `POST` creation. Accepted: `flac, mp3, m4a/alac, ogg, opus, wav, aiff`; `.zip` of an album is **v1.1**.
2. **analyze** — `ffprobe` (reject non-audio/corrupt) → sha256 → existing-tag read (`music-metadata`) → `fpcalc` → AcoustID lookup → top-N MusicBrainz candidates (recording + release) scored by tag agreement + duration delta.
3. **dedupe** — same sha256 already imported, same MB recording in `library_items`, or fuzzy `norm_key` match ±3 s → `DUPLICATE` (user may override with "keep as alternate version" if permitted; higher-quality replace is **v1.1**).
4. **review** — UI shows candidates, editable tags, cover; multi-file uploads grouped as an album when ≥2 files share a release. Auto-approve if user has `AUTO_APPROVE_UPLOAD` **and** top candidate score ≥ threshold (default 0.9).
5. **import** — write tags (`node-taglib-sharp`: title, artist, album artist, album, track/disc no., date, genre, MBIDs, AcoustID), embed CAA front cover (≤ 1200 px), render path from template (default `{albumartist}/{album} ({year})/{disc:?}{track:02} - {title}.{ext}`, sanitized, collision-safe), atomic move, chown/umask.
6. **announce** — `notifyPathsChanged`, upsert `library_items`, link/complete `target_request_id`, fire notifications, delete staging.

### Background jobs

`library.sync` (incremental every 15 min, full nightly) · `requests.availability` (after each sync) · `requests.submit` · `requests.poll` (every 5 min) · `upload.analyze` · `upload.import` · `notify.send` · `maintenance.cleanup` (expired sessions, stale tus chunks > 24 h, mb_cache TTL). The runner claims a job via an atomic `UPDATE … WHERE status='queued' AND run_after<=now RETURNING`, uses exponential backoff, has concurrency per type (MB-bound jobs = 1), and resumes after a restart.

### Security baseline

argon2id passwords · httpOnly SameSite=Lax session cookies + CSRF token on mutating routes · API keys hashed · secrets in settings encrypted with a key from `HEARER_SECRET` (generated into `/data` on first boot if unset) · `@fastify/rate-limit` on auth + search · strict path sanitization (no `..`, NUL, reserved Windows names) and every library write checked to stay under the library root · ffprobe/fpcalc run with argument arrays, never a shell · CSP headers · `SECURITY.md` disclosure policy.

---

## Deliverable batches

| ID   | Title                                                                            | Files/modules                                                                                                                                                          | Verify command                                                                                             | Depends          |
| ---- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| H-01 | Monorepo skeleton + OSS files                                                    | root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `LICENSE`, `README.md`, `CONTRIBUTING.md`, `docs/PLAN.md`+`DECISIONS.md`         | `pnpm i && pnpm -r typecheck && pnpm -r lint`                                                              | —                |
| H-02 | Server bootstrap + config + health                                               | `apps/server/{package.json,src/index.ts,src/app.ts,src/config.ts,src/routes/health.ts,test/health.test.ts}`                                                            | `pnpm --filter server test`                                                                                | H-01             |
| H-03 | DB schema, migrations, settings store                                            | `db/schema.ts`, `db/migrate.ts`, `drizzle/0000_*.sql`, `services/settings.ts`, `packages/shared/src/settings.ts`, tests                                                | `pnpm --filter server test && pnpm --filter server db:check`                                               | H-02             |
| H-04 | Job runner                                                                       | `jobs/runner.ts`, `jobs/registry.ts`, `jobs/maintenance.ts`, tests (claim, retry, backoff, restart-resume)                                                             | `pnpm --filter server test -- jobs`                                                                        | H-03             |
| H-05 | CI + Dockerfile                                                                  | `.github/workflows/ci.yml`, `docker/Dockerfile`, `.dockerignore`, `docker-compose.example.yml`                                                                         | `docker build -f docker/Dockerfile . && docker run --rm <img> sh -c 'ffprobe -version && fpcalc -version'` | H-02             |
| H-06 | Auth core: local users, sessions, API keys, permissions, setup-wizard API        | `auth/{sessions,apikeys,permissions,guard}.ts`, `routes/{auth,setup,users}.ts`, `packages/shared/src/permissions.ts`, tests                                            | `pnpm --filter server test -- auth`                                                                        | H-03             |
| H-07 | Jellyfin adapter + Jellyfin login + user import                                  | `adapters/mediaserver/{types,jellyfin}.ts`, `auth/jellyfin.ts`, fixtures, `docs/ADAPTERS.md`                                                                           | `pnpm --filter server test -- jellyfin` (recorded fixtures; live test behind `JELLYFIN_TEST_URL`)          | H-06             |
| H-08 | OIDC login                                                                       | `auth/oidc.ts` (`openid-client`), `routes/oidc.ts`, tests with mock IdP                                                                                                | `pnpm --filter server test -- oidc`                                                                        | H-06             |
| H-09 | MusicBrainz/CAA client, rate limiter, cache, search API                          | `adapters/metadata/{types,musicbrainz,coverart}.ts`, `routes/search.ts`, `lib/ratelimit.ts`, tests                                                                     | `pnpm --filter server test -- metadata`                                                                    | H-03             |
| H-10 | Library index sync + availability matcher                                        | `services/library.ts`, `jobs/librarySync.ts`, `lib/normalize.ts`, tests (MBID + fuzzy)                                                                                 | `pnpm --filter server test -- library`                                                                     | H-04, H-07       |
| H-11 | Requests service + API + quotas + timeline                                       | `services/requests.ts`, `routes/requests.ts`, `jobs/requestSubmit.ts`, `jobs/requestAvailability.ts`, tests                                                            | `pnpm --filter server test -- requests`                                                                    | H-09, H-10       |
| H-12 | Fulfillment providers: interface, Manual, Lidarr                                 | `adapters/fulfillment/{types,manual,lidarr,registry}.ts`, `jobs/requestPoll.ts`, Lidarr fixtures                                                                       | `pnpm --filter server test -- fulfillment`                                                                 | H-11             |
| H-13 | Upload receive (tus) + validation                                                | `routes/uploads.ts`, `services/uploads.ts`, `lib/ffprobe.ts`, quota checks, tests with sample audio fixtures (CC0)                                                     | `pnpm --filter server test -- uploads.receive`                                                             | H-06, H-04       |
| H-14 | Analyze: fingerprint, AcoustID, candidate scoring, dedupe                        | `adapters/metadata/acoustid.ts`, `lib/fpcalc.ts`, `jobs/uploadAnalyze.ts`, `services/matching.ts`, tests                                                               | `pnpm --filter server test -- uploads.analyze`                                                             | H-13, H-09, H-10 |
| H-15 | Import: tag write, cover embed, path template, atomic move, rescan, request link | `services/import.ts`, `lib/pathTemplate.ts`, `lib/tagger.ts`, `jobs/uploadImport.ts`, tests (tmpfs library)                                                            | `pnpm --filter server test -- uploads.import`                                                              | H-14, H-12       |
| H-16 | Web shell: routing, API client, auth pages, setup wizard                         | `apps/web/{package.json,vite.config.ts,src/main.tsx,src/api/client.ts,src/routes/{login,setup}.tsx,src/components/Layout.tsx}`                                         | `pnpm --filter web build && pnpm --filter web test`                                                        | H-06, H-07       |
| H-17 | Web: search, artist/album/track pages, request flow                              | `routes/{search,artist.$id,album.$id}.tsx`, `components/{ResultCard,RequestButton,StatusBadge}.tsx`, tests                                                             | `pnpm --filter web test`                                                                                   | H-16, H-11       |
| H-18 | Web: requests queue + my requests + timeline                                     | `routes/{requests,requests.$id}.tsx`, `components/{RequestTable,Timeline,DeclineDialog}.tsx`                                                                           | `pnpm --filter web test`                                                                                   | H-17, H-12       |
| H-19 | Web: upload dropzone (tus-js-client) + review/match editor                       | `routes/{upload,uploads,uploads.$id}.tsx`, `components/{Dropzone,MatchPicker,TagEditor}.tsx`                                                                           | `pnpm --filter web test`                                                                                   | H-16, H-15       |
| H-20 | Web: settings + users + jobs admin                                               | `routes/settings/*.tsx`, `routes/users.tsx`, `routes/jobs.tsx`, schema-driven provider forms                                                                           | `pnpm --filter web test`                                                                                   | H-18, H-19       |
| H-21 | Notifications: agents, events, per-user prefs                                    | `adapters/notify/*.ts`, `jobs/notifySend.ts`, `routes/notifications.ts`, web settings tab                                                                              | `pnpm --filter server test -- notify`                                                                      | H-11, H-15       |
| H-22 | E2E + release pipeline + docs                                                    | `e2e/*.spec.ts` (Playwright vs. compose stack with mock Jellyfin), `.github/workflows/release.yml` (multi-arch GHCR, release-please), `docs/{CONFIGURATION,DEPLOY}.md` | `pnpm e2e`                                                                                                 | H-20, H-21       |
| H-23 | **homelab-infra** deployment (separate `homelab-infra` repo, not this one)       | `cluster/thenetwork/apps/hearer/{kustomization,deployment,service,pvc,README}.yaml/md`, cloudflared route, dashy tile, Keycloak client notes                           | `kubectl apply -k cluster/thenetwork/apps/hearer --dry-run=client`                                         | H-22 release tag |

Batches are sized to ≤ 8 files where possible (tests count). If one grows past that, split it as H-xxa/H-xxb rather than overrunning.

## Phases (milestones)

- **M0 Foundation (H-01–H-05):** the empty app boots, migrates, runs jobs, builds an image in CI.
- **M1 Identity (H-06–H-08):** all three login paths work; the first user through the wizard becomes admin.
- **M2 Requests (H-09–H-12):** feature parity with Seerr's core loop for music, API-only.
- **M3 Uploads (H-13–H-15):** a file dropped via API lands correctly tagged in the library and Jellyfin sees it.
- **M4 UI (H-16–H-20):** everything usable in a browser, mobile-responsive.
- **M5 Ship (H-21–H-23):** notifications, E2E, v1.0.0 tag, homelab live.

Per-batch notes that aren't obvious from the table:

- **H-01**: Node 24, pnpm 10, `"type":"module"`, strict TS, Vitest, Prettier, conventional commits; Renovate config; issue templates (bug / feature / adapter request).
- **H-03**: settings keys are typed in `packages/shared` and validated on read _and_ write; a corrupted value falls back to the default with a logged warning.
- **H-05**: base image `node:24-alpine` with `apk add ffmpeg chromaprint tini`; run as non-root, honoring `PUID/PGID/UMASK`; `HEALTHCHECK` hits `/api/v1/health`; volumes `/data`, `/music`, `/staging`.
- **H-07**: before coding, hit a real 10.11 server once and record fixtures plus the exact `ProviderIds` keys for audio items. Also test that auth works with the modern header alone.
- **H-09**: one global token bucket (1 rps) shared by every MB call, including jobs; search debounced client-side; response cache TTL 7 days for entities, 1 day for searches.
- **H-10**: normalization strips case, diacritics, punctuation and "feat." / "(Remastered …)" suffixes; fuzzy match requires artist + title + duration within ±3 s.
- **H-15**: the import has to be idempotent. Re-running a crashed import must neither duplicate files nor lose the staging file before the destination is verified (size + sha256).
- **H-22**: E2E covers wizard → login → request album (Manual) → upload 2 CC0 tracks fulfilling it → request becomes AVAILABLE → webhook received.

## Handoff packet (end of every batch)

Append to `docs/STATUS.md` in the hearer repo: batch ID, what shipped, verify output (last lines), deviations from PLAN/DECISIONS (and whether DECISIONS was amended), next batch, open questions.

## Test criteria (v1.0 acceptance)

1. `docker compose -f docker-compose.example.yml up` on a clean machine → wizard completes in < 5 min with a Jellyfin URL and a music folder.
2. Jellyfin user logs in. An OIDC (Keycloak) user logs in. A local user logs in. Permissions are enforced on every route (route-level test matrix).
3. Searching "Radiohead OK Computer" returns the release group with cover art in < 2 s warm / < 5 s cold, with an "In library" badge when present.
4. A non-auto-approve user's request → admin gets webhook/Slack → approve → Lidarr receives monitored album (fixture), or Manual moves it to `AWAITING_UPLOAD`.
5. A 300 MB FLAC upload through a proxy with a 100 MB body cap succeeds (tus chunking) and resumes after a forced disconnect.
6. An uploaded untagged MP3 is identified by AcoustID, tagged with MBIDs and cover, filed by template, and appears in Jellyfin without a manual scan.
7. Re-uploading the same file → `DUPLICATE`. A path-traversal filename never escapes the library root (unit + E2E).
8. Restarting the container mid-import → job resumes, and there's no duplicate or lost file.
9. Image runs on amd64 and arm64. `pnpm -r test`, `pnpm e2e` and CI are green. README quick-start works copy-pasted.

## Risks & mitigations

| Risk                                                  | Mitigation                                                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| MusicBrainz rate limits make search feel slow         | Global limiter + aggressive cache + optional MB mirror URL; `MetadataProvider` lets a faster search source (Deezer) be added later |
| Jellyfin MBID coverage is inconsistent                | Fuzzy fallback; show "possible match" rather than claiming available                                                               |
| Jellyfin 12 auth changes                              | Modern header from day one; CI job against `jellyfin/jellyfin:latest` as a non-blocking canary                                     |
| Tag-writing library gaps (e.g. some ALAC/Opus fields) | `node-taglib-sharp` primary. Spike in H-15, and fall back to `ffmpeg -metadata` remux for unsupported formats                      |
| Uploads used for content people don't own             | Clear ToS text in the UI, upload permission off by default for imported users, audit log of uploader per file                      |
| Scope creep toward a full Lidarr/beets clone          | Out-of-scope list in DECISIONS; adapters over features                                                                             |

## Open questions (non-blocking; defaults in parentheses)

- Should imported Jellyfin users get `UPLOAD` by default? (No — admin grants it.)
- Separate "Singles" folder for track uploads with no album match? (Yes: `{albumartist}/Singles/{title}.{ext}`.)
- Deploy Lidarr in the homelab alongside Hearer? (Later; not needed for v1.)
