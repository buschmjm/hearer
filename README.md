# Hearer

A self-hosted request and upload portal for music, in the spirit of Seerr and Jellyseerr but built around music.

Users sign in with their media-server account, search MusicBrainz, and request tracks, albums or artists. They can also upload files they own. Requests go through approval and are fulfilled by pluggable providers. Uploads are fingerprinted, matched, reviewed, tagged and filed into your library, and the media server is told to rescan. Hearer notices when requested music becomes available and lets people know.

> **Status: pre-alpha.** Hearer is under active development and is not usable yet. There is no release, no published image and no stable API. Follow progress in [docs/STATUS.md](docs/STATUS.md).

## Planned features (v1.0)

- Setup wizard: admin account, media server, library and staging paths, naming template, providers, notifications
- Sign in with Jellyfin, a local account or generic OIDC; sessions and API keys; fine-grained permissions and per-user quotas
- Search artists, albums and tracks (MusicBrainz, Cover Art Archive) with "in library" and "requested" badges
- Requests with approve/decline, retry, cancel and a status timeline; optional auto-approve per permission
- Fulfillment providers: Manual (filled by an upload) and Lidarr
- Library index sync from Jellyfin and availability detection
- Resumable, chunked uploads (tus), AcoustID fingerprint matching, metadata review and editing, duplicate detection, tag writing with cover embed, templated filing and targeted rescan
- Notifications: webhook, Discord, Slack, ntfy and SMTP
- Admin pages for users, requests, uploads, jobs and settings
- One multi-arch (amd64, arm64) container image

Not planned for v1.0: playback, Postgres, Navidrome/Plex adapters, mobile apps, recommendations, playlist import. See [docs/DECISIONS.md](docs/DECISIONS.md).

## Quick start

> **Not functional yet.** The snippet below only illustrates the intended shape of the deployment. The image does not exist and the service will not start.

```yaml
# docker-compose.yml (placeholder, not yet functional)
services:
  hearer:
    image: ghcr.io/buschmjm/hearer:latest
    ports:
      - '5055:5055'
    environment:
      PUID: 1000
      PGID: 1000
      TZ: Etc/UTC
    volumes:
      - ./data:/data # database, cache, logs
      - /path/to/music:/music # your library (read-write)
      - ./staging:/staging # uploads in flight
    restart: unless-stopped
```

## Documentation

- [Build plan](docs/PLAN.md): scope, architecture, data model and batch breakdown
- [Locked decisions](docs/DECISIONS.md): choices that override the plan
- [Status log](docs/STATUS.md): what has shipped and what is next
- [Contributing](CONTRIBUTING.md), [Code of Conduct](CODE_OF_CONDUCT.md), [Security policy](SECURITY.md)

## Development

Requires Node 24 and pnpm 10. See [CONTRIBUTING.md](CONTRIBUTING.md).

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

## License

[MIT](LICENSE)
