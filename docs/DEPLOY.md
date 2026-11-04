# Deploying Hearer

Hearer is one container. It needs three folders, a way for people to reach port 5055, and, for the full experience, a Jellyfin server.

- [What you need](#what-you-need)
- [docker run](#docker-run)
- [Docker Compose](#docker-compose)
- [Users, groups and permissions on /music](#users-groups-and-permissions-on-music)
- [First start](#first-start)
- [Reverse proxies](#reverse-proxies) (Caddy, Traefik, nginx), [Cloudflare Tunnel](#cloudflare-tunnel)
- [Jellyfin](#jellyfin)
- [Single sign-on (Keycloak and other OIDC providers)](#single-sign-on-keycloak-and-other-oidc-providers)
- [Lidarr (optional)](#lidarr-optional)
- [Upgrading and backups](#upgrading-and-backups)
- [Troubleshooting](#troubleshooting)
- [Example: a Kubernetes homelab](#example-a-kubernetes-homelab)

Every environment variable and setting is explained in [CONFIGURATION.md](CONFIGURATION.md).

## What you need

| Thing            | Notes                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker           | Any recent Docker or Podman. The image runs on amd64 and arm64 (Raspberry Pi 4 and newer, Apple silicon).                                         |
| A music folder   | The library Jellyfin serves. Hearer needs **read and write** access, because imported uploads are filed into it.                                  |
| A data folder    | Small. Holds the database and the secret key. Use local disk, not a network share: SQLite in WAL mode does not work reliably over NFS or SMB.     |
| A staging folder | Where uploads wait before import. Needs room for your largest uploads. Best on the same filesystem as the music folder (imports become a rename). |
| Jellyfin 10.10+  | Optional but recommended: library index, availability detection, rescans after imports, Jellyfin sign-in. Jellyfin 12 is supported.               |
| A reverse proxy  | Recommended for https. See below.                                                                                                                 |

Hearer is **pre-1.0 (beta)**. Keep backups ([Upgrading and backups](#upgrading-and-backups)) and read the release notes before upgrading.

## docker run

```sh
mkdir -p hearer/data hearer/staging && cd hearer

docker run -d --name hearer \
  --restart unless-stopped \
  -p 5055:5055 \
  -e PUID=1000 -e PGID=1000 -e UMASK=002 \
  -e TZ=Etc/UTC \
  -v "$PWD/data:/data" \
  -v /path/to/music:/music \
  -v "$PWD/staging:/staging" \
  ghcr.io/buschmjm/hearer:latest
```

Open `http://<host>:5055` and follow the wizard. Tags: `X.Y.Z` (an exact release), `X.Y`, `X` (from 1.0 on) and `latest`. `edge` follows the main branch. Pin an exact version if you want upgrades to be deliberate.

## Docker Compose

[`docker-compose.example.yml`](../docker-compose.example.yml) in the repository is a complete starting point:

```yaml
services:
  hearer:
    image: ghcr.io/buschmjm/hearer:latest
    container_name: hearer
    restart: unless-stopped
    ports:
      - '5055:5055'
    environment:
      PUID: '1000'
      PGID: '1000'
      UMASK: '002'
      TZ: 'Etc/UTC'
      # BASE_URL: 'https://hearer.example.com'
      # TRUST_PROXY: '1'
    volumes:
      - ./data:/data
      - /path/to/music:/music
      - ./staging:/staging
```

```sh
cp docker-compose.example.yml docker-compose.yml
# edit PUID/PGID and the /path/to/music line, then:
docker compose up -d
docker compose logs -f hearer
```

If Jellyfin runs in the same compose project, put both on one network and use `http://jellyfin:8096` as the Jellyfin URL (the service name). Mount the same music folder into both. The image has a built-in health check against `/api/v1/health`.

## Users, groups and permissions on /music

The entrypoint starts as root only to create a user with the id you give, fix ownership of `/data` and `/staging`, set the umask, and then drops privileges. The app never runs as root unless you set `PUID=0`.

- Set `PUID` and `PGID` to the user and group that **own your music files**. Run `ls -ln /path/to/music` to see the numbers. Then files Hearer adds belong to the same user as everything else, and Jellyfin (running as the same or a group-mate user) can read them.
- `UMASK=002` makes new files `664` and folders `775`, which suits a shared group. Use `022` if only the owner should write.
- Hearer **never changes ownership of `/music`**; it is usually shared. It only checks that it can write there and logs a warning at start-up if it cannot (`warning: /music is not writable by uid ...`). The setup wizard will not let you finish until both the library and staging folders are writable.
- You can also run with `--user 1000:1000` (or `user:` in compose) instead of `PUID`/`PGID`. Then the container does no user management, so make `/data` and `/staging` writable for that id yourself.
- Read-only music mounts (`:ro`) work for browsing and requests, but uploads cannot be imported.

## First start

1. Open `http://<host>:5055`. A fresh install goes straight to the wizard.
2. **Admin:** create the administrator (local account).
3. **General:** the application title and public URL, and which permissions new users get.
4. **Media server:** enter your Jellyfin URL and an API key, press **Test connection**, then save. You can skip this step and add it later.
5. **Library:** check that `/music` and `/staging` show as writable, and choose the naming template.
6. **Review** and **Finish setup**.

Afterwards open **Settings** to add notifications, a fulfillment provider (Lidarr), single sign-on, and your AcoustID key (without it, uploads are matched from their existing tags and length only). Register an application key for free at [acoustid.org](https://acoustid.org/new-application).

## Reverse proxies

Terminate https at the proxy and forward to `hearer:5055`. In every case:

- Set `BASE_URL=https://hearer.example.com` (or the **Application URL** setting) and `TRUST_PROXY=1`.
- Allow request bodies of **at least 55 MB**. Upload chunks are up to 50 MB.
- **Do not buffer request bodies.** Uploads stream straight to disk; buffering wastes memory and delays progress.
- Allow the `PATCH`, `HEAD` and `OPTIONS` methods and pass the `Upload-*` and `Tus-*` headers through (every mainstream proxy does by default).
- Use generous timeouts (at least 60 s) for the `/api/v1/uploads/` path.
- Do not rewrite or compress the `/api/v1/uploads/tus` responses.

### Caddy

```caddyfile
hearer.example.com {
	encode zstd gzip
	request_body {
		max_size 60MB
	}
	reverse_proxy hearer:5055 {
		# Stream request and response bodies instead of buffering them.
		flush_interval -1
	}
}
```

### Traefik (Docker labels)

```yaml
services:
  hearer:
    image: ghcr.io/buschmjm/hearer:latest
    environment:
      BASE_URL: https://hearer.example.com
      TRUST_PROXY: '1'
    labels:
      - traefik.enable=true
      - traefik.http.routers.hearer.rule=Host(`hearer.example.com`)
      - traefik.http.routers.hearer.entrypoints=websecure
      - traefik.http.routers.hearer.tls.certresolver=letsencrypt
      - traefik.http.services.hearer.loadbalancer.server.port=5055
```

Traefik does not buffer bodies unless you attach a `buffering` middleware; do not add one to this router. If you must, set `maxRequestBodyBytes` to at least `60000000`. For slow clients, raise the entrypoint's `respondingTimeouts.readTimeout` (the default of 60 s is usually enough for 50 MB chunks on a decent link; `0` disables it).

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name hearer.example.com;
    # ssl_certificate / ssl_certificate_key ...

    # One upload chunk is up to 50 MB; leave headroom.
    client_max_body_size 55m;

    location / {
        proxy_pass http://hearer:5055;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Uploads (tus): stream the body, do not spool it to disk first.
        proxy_request_buffering off;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

`client_max_body_size` is the setting people forget: at the default of 1 MB every upload chunk fails with `413`.

### Cloudflare Tunnel

Cloudflare (including Tunnel) rejects request bodies larger than **100 MB** on the free and Pro plans. Hearer's uploader is built for this: each file is sent in chunks of at most 50 MB, so a 300 MB album track works through a tunnel, and a dropped connection resumes from the last good chunk. You do not need to change anything.

Point the tunnel's public hostname at `http://hearer:5055` (or `http://localhost:5055`), set `BASE_URL` to the public hostname and `TRUST_PROXY=1`. Cloudflare Access in front of Hearer works for people, but it will block API clients and webhooks that cannot do the Access login; exclude those paths or use Hearer's own sign-in. WebSockets are not needed.

## Jellyfin

### Create an API key

In Jellyfin: **Dashboard, API Keys, +**, name it "Hearer", copy the key. In Hearer: **Settings, Media server** (or the wizard), enter the URL Hearer can reach, the key, and press **Test connection**. It reports the Jellyfin version; 10.10 or newer is supported, and Jellyfin 12 works because Hearer authenticates only with the modern `Authorization: MediaBrowser ...` header (never the old `X-Emby-*` headers or `api_key=` query strings, which Jellyfin 12 removes).

The **URL** is how Hearer's container reaches Jellyfin (for example `http://jellyfin:8096`). The optional **External URL** is what people's browsers use for "Open in Jellyfin" links.

### What Hearer uses Jellyfin for

- **Sign-in:** enable **Settings, Authentication, Jellyfin** to let people log in with their Jellyfin username and password. New accounts get the default permissions without `UPLOAD`; grant it per person. A Jellyfin administrator does not become a Hearer administrator. You can also import users in bulk from **Users**.
- **Library index and availability:** Hearer reads your music items (artists, albums, tracks with their MusicBrainz ids) every 15 minutes (changes only) and fully every night at 03:00. When a requested album or track shows up, the request becomes available and people are notified. Matching uses MusicBrainz ids first and falls back to artist, title and duration.
- **Rescans:** after importing an upload Hearer tells Jellyfin which file appeared (`POST /Library/Media/Updated`, falling back to a library refresh) and re-syncs two minutes later, so new music shows up without a manual scan.

### Path mappings

If Jellyfin and Hearer see the music folder at different paths, add a mapping under **Settings, Media server**, for example Jellyfin `/data/music` to Hearer `/music`. Without it Hearer cannot match files by path or point Jellyfin at the right folder. When Jellyfin does not have real-time monitoring for the library, the 2-minute follow-up sync (and Jellyfin's own scheduled scans) pick the file up. See [Path mappings](CONFIGURATION.md#path-mappings).

## Single sign-on (Keycloak and other OIDC providers)

Hearer speaks standard OpenID Connect (authorization code flow with PKCE). Anything that offers discovery works: Keycloak, Authentik, Authelia, Zitadel, Google Workspace and others.

The **redirect URI** to register is your public URL plus `/api/v1/auth/oidc/callback`, for example

```
https://hearer.example.com/api/v1/auth/oidc/callback
```

Hearer shows the exact value to copy under **Settings, Authentication, OIDC**. It is built from the **Application URL** setting, else `BASE_URL`, else the address of the request, so set one of them to your public https URL first.

### Keycloak

1. In your realm: **Clients, Create client**. Client type `OpenID Connect`, client id `hearer`.
2. **Capability config:** turn **Client authentication** on (a confidential client) and leave **Standard flow** on.
3. **Valid redirect URIs:** `https://hearer.example.com/api/v1/auth/oidc/callback`. Web origins: `https://hearer.example.com`.
4. Save, open **Credentials** and copy the client secret.
5. Optional, for groups: **Client scopes, hearer-dedicated, Add mapper, By configuration, Group Membership**. Name `groups`, token claim name `groups`, turn **Full group path** off, and add it to the ID token.
6. In Hearer **Settings, Authentication, OIDC**:
   - Issuer URL `https://id.example.com/realms/<realm>` (older Keycloak versions: `https://id.example.com/auth/realms/<realm>`)
   - Client id `hearer`, client secret from step 4
   - Optional: Groups claim `groups`, Admin group `hearer-admins`, Allowed groups `hearer-users`
   - Press **Test** (it checks discovery), then enable.

### Notes for any provider

- New SSO users are created on first sign-in (turn **Auto-create users** off to restrict to existing accounts). They get the default permissions.
- A user who signs in with SSO and has the same email as a local or Jellyfin account gets a **separate** account unless you enable **Link existing accounts by email**. Only turn that on if the provider verifies emails.
- If sign-in comes back with `?error=state_mismatch` or `invalid_transaction`, the browser lost the short-lived login cookie: check that you use the same public URL everywhere, that `BASE_URL` is https, and that the proxy forwards `X-Forwarded-Proto`.

## Lidarr (optional)

Hearer works fully with **Manual** fulfillment: an approved request waits for someone to upload the music. If you also run Lidarr, enable it under **Settings, Fulfillment**: URL, API key, a root folder, a quality profile and a metadata profile (pick them from the lists Hearer loads from your Lidarr). Approved album and artist requests are then added to Lidarr as monitored and searched. Track requests follow the **track policy**: ask for the parent album, or hand the request to Manual.

Make sure Lidarr's root folder is inside the library Jellyfin indexes. Hearer notices the result through the library sync, so it does not matter how the files get there.

## Upgrading and backups

**What to back up:** the whole `/data` folder. It holds

| File                           | What it is                                                                |
| ------------------------------ | ------------------------------------------------------------------------- |
| `hearer.db` (+ `-wal`, `-shm`) | The database: users, settings, requests, uploads, jobs, library index     |
| `secret.key`                   | The key that encrypts stored credentials (unless you set `HEARER_SECRET`) |

Your music is not in `/data`; back it up the way you already do. For a consistent copy of the database, stop the container (`docker stop hearer`), copy `/data`, then start it again. Keep `secret.key` with the database: a restored database without its key loses the stored credentials (you re-enter them).

**To upgrade:**

```sh
docker compose pull
docker compose up -d
```

Database migrations run automatically at start-up, and the image tag tells you what you run (`GET /api/v1/health` reports the version). Downgrading is not supported once a newer version has migrated the database: restore the backup you took before upgrading.

`staging/` can be emptied between runs when no uploads are in progress. Files there that are older than 24 hours and unfinished are cleaned up automatically.

## Troubleshooting

Turn on detail with `LOG_LEVEL=debug` and read `docker logs hearer`.

| Symptom                                                  | Likely cause and fix                                                                                                                                                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wizard cannot finish: library or staging "not writable"  | The folder is owned by another user. Set `PUID`/`PGID` to the owner of `/music`, or fix the permissions. Check the start-up log for the `warning:` line.                                                                    |
| Jellyfin "Test connection" fails with 401                | Wrong API key, or the key was created on another Jellyfin. Create a new one under Dashboard, API Keys.                                                                                                                      |
| Jellyfin "Test connection" says it cannot be reached     | The URL must work **from inside the Hearer container**: use the service name or LAN address, not `localhost`.                                                                                                               |
| Requests never become available                          | Check **Admin, Jobs** for `library.sync` errors. Add a **path mapping** if Jellyfin sees different paths. Make sure Jellyfin has scanned the new files, and that the files carry MusicBrainz ids or good artist/title tags. |
| An imported file does not show up in Jellyfin            | Enable real-time monitoring for the library, or wait for the follow-up sync. Check the path mapping and that Jellyfin can read the file (same group, `UMASK=002`).                                                          |
| Uploads fail at once with `413 Request Entity Too Large` | The proxy's body limit. Allow at least 55 MB (`client_max_body_size 55m` for nginx).                                                                                                                                        |
| Uploads fail with `411 Length Required`                  | A proxy re-encodes chunks with chunked transfer encoding. Turn off request buffering or compression for the upload path.                                                                                                    |
| Uploads stall or restart                                 | Proxy timeouts, or request buffering. See [Reverse proxies](#reverse-proxies). Interrupted uploads resume from the last chunk.                                                                                              |
| Uploads are never identified                             | Add an AcoustID key in **Settings, Metadata**. Check that `fpcalc` works: `docker exec hearer fpcalc -version`. Without a key, only existing tags and duration are used.                                                    |
| Search is slow the first time                            | MusicBrainz allows one request per second. Results are cached (7 days for entities, 1 day for searches), so repeat searches are fast.                                                                                       |
| "Setup is not complete" (503) from the API               | Finish the wizard. Until then only health, auth and setup routes answer.                                                                                                                                                    |
| Sign-in is rate limited (429)                            | Too many attempts. Wait a minute. Behind a proxy, set `TRUST_PROXY=1`, otherwise every visitor looks like the proxy's address.                                                                                              |
| Stored credentials "cannot be decrypted"                 | `secret.key` (or `HEARER_SECRET`) changed or was lost. Enter the credentials again in the settings.                                                                                                                         |
| Database errors on a NAS                                 | `/data` is on NFS or SMB. Put it on a local disk or a Docker volume.                                                                                                                                                        |
| Container exits at start with "Invalid configuration"    | An environment variable has a bad value; the message lists each one.                                                                                                                                                        |
| Locked out after turning off local sign-in               | Hearer refuses to disable the last working sign-in method. If an external provider later fails, stop the container and re-enable local sign-in in the database (`settings` table, key `auth`), or restore a backup.         |

When asking for help, include the Hearer version (`curl http://host:5055/api/v1/health`), the relevant log lines (with secrets removed), and how you reach Hearer (direct, proxy, tunnel).

## Example: a Kubernetes homelab

This section is one author's setup, shown as an example, not a requirement. The reference deployment is a single-node Kubernetes cluster (`thenetwork`) with Jellyfin already running:

- Namespace `hearer`, one `Deployment` with the image above and `PUID`/`PGID` matching the owner of the music files, a PVC for `/data`, an `emptyDir` or PVC for `/staging`, and the music directory mounted **read-write** (Jellyfin keeps its own read-only mount of the same directory; path mappings are not needed because both use the same paths).
- Jellyfin URL `http://jellyfin.default.svc.cluster.local:8096` (the in-cluster service, never a LAN address).
- Exposed through a Cloudflare Tunnel route, which is why uploads use 50 MB chunks. `TRUST_PROXY=1`, `BASE_URL` set to the public hostname.
- Single sign-on through a Keycloak client named `hearer` with Jellyfin sign-in also enabled.
- Approvals: a generic webhook target posting to an automation tool (n8n), which relays to chat.

The manifests for that setup live in the author's separate homelab repository; nothing in Hearer depends on it.
