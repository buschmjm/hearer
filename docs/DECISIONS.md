# Hearer — locked decisions

**Status:** Active — overrides conflicting text in [PLAN.md](./PLAN.md) unless amended here.
**What it is:** An open-source, self-hosted **request + upload portal for music**, in the spirit of Seerr/Jellyseerr but music-native. Users search a catalog, request songs/albums/artists, or upload files they own; Hearer tags them, files them into the library, and tells the media server to rescan.
**Code home:** standalone GitHub repo `hearer` (see plan §0). The deployment manifests for the reference homelab (batch H-23) live in the separate `homelab-infra` repo.

---

## Product

| Decision            | Value                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                | **Hearer** (not "Heater") — repo, image, package names: `hearer`                                                                                    |
| License             | **MIT** (same as Seerr; maximally forkable)                                                                                                         |
| Audience            | Any self-hoster with a music library folder; homelab (`thenetwork`) is the reference deployment, never a hard dependency                            |
| Core verbs          | **Search → Request → Approve → Fulfill → Available**, and **Upload → Identify → Review → Import → Available**                                       |
| Request granularity | **Track, album (release group), artist** — all keyed by MusicBrainz IDs                                                                             |
| Legal posture       | Uploads are "music you have the right to store". No piracy-specific adapters in core; third-party fulfillment adapters ship **disabled by default** |

## Architecture (v1)

| Decision        | Value                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language        | **TypeScript** everywhere, Node **24 LTS**                                                                                                                                 |
| Repo shape      | **pnpm workspace monorepo**: `apps/server`, `apps/web`, `packages/shared`                                                                                                  |
| API             | **Fastify 5** + `fastify-type-provider-zod`; REST under `/api/v1`; OpenAPI generated from zod schemas                                                                      |
| UI              | **React 19 + Vite**, TanStack Router + TanStack Query, Tailwind CSS 4; served as static files by the API process                                                           |
| DB              | **SQLite (WAL) via Drizzle ORM** — **SQLite-only in v1.** Postgres deferred to v1.x (Drizzle needs a separate schema per dialect; not worth doubling the schema before v1) |
| Background work | **DB-backed job table + in-process worker** (no Redis, no BullMQ). One container is the whole app                                                                          |
| Packaging       | **One multi-arch Docker image** (amd64 + arm64) on GHCR: `ghcr.io/<owner>/hearer`, bundling `ffmpeg/ffprobe` + `fpcalc` (Chromaprint)                                      |
| Config          | Env vars only for bootstrap (port, data dir, paths, base URL); everything else stored in DB and edited in the setup wizard / settings UI (Seerr model)                     |

## Integrations (v1)

| Area          | v1                                                                             | Interface for later                                                     |
| ------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Media server  | **Jellyfin** (auth, library index, rescan)                                     | `MediaServerAdapter` → Navidrome/Subsonic, Plex                         |
| Metadata      | **MusicBrainz** + **Cover Art Archive**; **AcoustID** for fingerprint ID       | `MetadataProvider` → Deezer/Last.fm search enrichment                   |
| Fulfillment   | **Manual** (filled by an upload) + **Lidarr** (album/artist)                   | `FulfillmentProvider` → community adapters (e.g. slskd), off by default |
| Auth          | **Jellyfin login**, **local accounts**, **generic OIDC** (Keycloak in homelab) | —                                                                       |
| Notifications | **Generic webhook** (n8n), **Discord**, **Slack**, **ntfy**, **SMTP**          | `NotificationAgent`                                                     |

## Rules that are easy to get wrong

1. **Jellyfin auth uses the modern header only:** `Authorization: MediaBrowser Client="Hearer", Device=…, DeviceId=…, Version=…, Token=…`. Never `X-Emby-*` or legacy query-string tokens. That way Hearer keeps working on Jellyfin 12, where legacy auth is removed. That removal is the reason homelab Seerr is pinned to 10.11.
2. **Uploads are resumable and chunked (tus protocol)** with chunks ≤ **50 MB**. Cloudflare tunnels reject request bodies > 100 MB, and FLAC albums exceed that.
3. **MusicBrainz:** ≤ 1 request/second globally, descriptive `User-Agent` (`Hearer/<ver> ( <repo-url> )`), and responses cached in DB. Mirror base URL is configurable.
4. **Never write into the library directly from an upload.** Staging dir → validate → tag → atomic move (rename if same FS, else copy + fsync + verify + unlink).
5. **Library path is the only write target outside `/data`.** Hearer runs as a configurable `PUID/PGID`, and new files get a configurable `UMASK`.
6. **Approval is permission-driven** (`AUTO_APPROVE`, `AUTO_APPROVE_UPLOAD`), never hard-coded per integration.

## Homelab reference deployment

| Decision              | Value                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| Namespace / manifests | `hearer` · `cluster/thenetwork/apps/hearer/` (kustomize, raw manifests)                               |
| Hostname              | `hearer.jbuschmann.com` via Cloudflare tunnel                                                         |
| Library               | hostPath `/music` mounted **read-write** into Hearer (Jellyfin keeps its read-only mount)             |
| Jellyfin URL          | `http://jellyfin.default.svc.cluster.local:8096` (never a WAN/LAN IP)                                 |
| SSO                   | Keycloak realm `homelab`, client `hearer`; Jellyfin login also enabled                                |
| Approvals             | Generic webhook → n8n → Slack (same pattern as access-request)                                        |
| Lidarr                | **Not deployed today.** Optional follow-up; Hearer must be fully useful with Manual fulfillment alone |

## Out of scope for v1.0

Playback/streaming, Postgres, Navidrome/Plex adapters, mobile apps, recommendations/"discover", playlist import (Spotify/YouTube), multi-library routing, i18n beyond English strings in a catalog file, built-in slskd adapter.
