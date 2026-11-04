# Configuration

Hearer has two layers of configuration.

1. **Environment variables** set the things the process needs before it can read its database: ports, directories, logging, the secret. They are read once at start-up. This page lists all of them.
2. **Settings** live in the database and are edited in the setup wizard and under **Settings** in the web UI (or through the API, `GET/PUT /api/v1/settings/<section>`). Changes apply immediately, without a restart.

See [DEPLOY.md](DEPLOY.md) for how to run Hearer and wire it to a reverse proxy, Jellyfin and an identity provider.

## Environment variables

| Variable              | Default       | Meaning                                                                                                                                                                                                            |
| --------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                | `5055`        | TCP port the HTTP server listens on (1-65535).                                                                                                                                                                     |
| `HOST`                | `0.0.0.0`     | Address to bind. Use `127.0.0.1` when a reverse proxy on the same host is the only client.                                                                                                                         |
| `BASE_URL`            | _(unset)_     | Public URL users reach Hearer at, for example `https://hearer.example.com`. Used for links and as the fallback for the OIDC redirect URI. The **Application URL** setting takes precedence when it is set.         |
| `DATA_DIR`            | `/data`       | Database (`hearer.db`), the generated `secret.key`, caches. Needs read/write for the app user. **Back this up.**                                                                                                   |
| `MUSIC_DIR`           | `/music`      | Your music library. Hearer writes imported uploads here and nowhere else outside `DATA_DIR` and `STAGING_DIR`.                                                                                                     |
| `STAGING_DIR`         | `/staging`    | Uploads in flight (tus chunks and files awaiting review). Keep it on the same filesystem as `MUSIC_DIR` if you can: then an import is an atomic rename instead of a verified copy.                                 |
| `STATIC_DIR`          | _(auto)_      | Directory holding the built web app. The container image sets this up; you only need it when running from source (`apps/web/dist`).                                                                                |
| `LOG_LEVEL`           | `info`        | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.                                                                                                                                                    |
| `LOG_FORMAT`          | `json`        | `json` (one object per line, good for log shippers) or `pretty` (human readable).                                                                                                                                  |
| `HEARER_SECRET`       | _(generated)_ | At least 16 characters. Key material for encrypting stored credentials. When unset, Hearer generates `DATA_DIR/secret.key` on first start. See [Security notes](#security-notes).                                  |
| `TRUST_PROXY`         | `false`       | `true`, `false` or a hop count (`1`, `2`, ...). Set it when Hearer is behind a reverse proxy so client IPs, the `https` scheme and rate limiting use the forwarded headers. See [Security notes](#security-notes). |
| `AUTH_RATE_LIMIT_MAX` | `10`          | Sign-in, Jellyfin sign-in, first-admin and password-change attempts allowed per client address per minute.                                                                                                         |
| `NODE_ENV`            | `production`  | `development`, `production` or `test`. The image sets `production`.                                                                                                                                                |

Extra variables understood by the **container image** (not by the Node process itself):

| Variable | Default | Meaning                                                                                                                                    |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUID`   | `1000`  | User id the app runs as. Match the owner of your music library.                                                                            |
| `PGID`   | `1000`  | Group id the app runs as.                                                                                                                  |
| `UMASK`  | `002`   | Permission mask for files and folders Hearer creates (`002` gives `664` files and `775` folders; use `022` if the group should not write). |
| `TZ`     | `UTC`   | Time zone for log timestamps.                                                                                                              |

Examples:

```sh
# Behind one reverse proxy, public URL set, quieter logs
docker run -d --name hearer -p 5055:5055 \
  -e PUID=1000 -e PGID=1000 -e UMASK=002 \
  -e BASE_URL=https://hearer.example.com \
  -e TRUST_PROXY=1 \
  -e LOG_LEVEL=warn \
  -v ./data:/data -v /srv/music:/music -v ./staging:/staging \
  ghcr.io/buschmjm/hearer:latest
```

Invalid values stop the server at start-up with a list of every problem, so a typo never goes unnoticed.

## Settings

Settings are grouped into sections. Every field has a default, so a section you never touch behaves sensibly. Saving a section replaces it as a whole: fields you omit through the API revert to their defaults (the web UI sends the whole section for you). **Secrets** (marked below) are encrypted at rest and shown as `********`; sending the masked value back keeps the stored secret.

### `general` (Settings, General)

| Key                   | Default                                    | Meaning                                                                                                                      |
| --------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `appTitle`            | `Hearer`                                   | Name shown in the UI, the sign-in page and notifications (1-80 characters).                                                  |
| `applicationUrl`      | _(empty)_                                  | Public URL, used in notification links and the OIDC redirect URI. Overrides `BASE_URL`.                                      |
| `setupComplete`       | `false`                                    | Set by the wizard's **Finish setup**. Until then every API route except health, auth and setup answers `503 setup_required`. |
| `defaultPermissions`  | `REQUEST + REQUEST_ALBUM + UPLOAD` (`280`) | Permission bitmask given to new users. See [Permissions](#permissions). Jellyfin accounts never get `UPLOAD` automatically.  |
| `defaultRequestQuota` | `{ limit: 0, days: 7 }`                    | Requests a user may make per rolling window. `limit` 0 means unlimited.                                                      |
| `defaultUploadQuota`  | `{ mb: 0, days: 7 }`                       | Megabytes a user may upload per rolling window. `mb` 0 means unlimited.                                                      |

### `auth` (Settings, Authentication)

| Key                        | Default                | Meaning                                                                                                                                                                                               |
| -------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `localEnabled`             | `true`                 | Allow local username/password sign-in. Hearer refuses a change that would leave no sign-in method enabled.                                                                                            |
| `jellyfinEnabled`          | `false`                | Allow signing in with a Jellyfin account (needs a configured media server).                                                                                                                           |
| `oidc.enabled`             | `false`                | Allow single sign-on with an OpenID Connect provider.                                                                                                                                                 |
| `oidc.issuerUrl`           | _(empty)_              | Issuer URL, for Keycloak `https://id.example.com/realms/<realm>`. Hearer uses `/.well-known/openid-configuration` under it.                                                                           |
| `oidc.clientId`            | _(empty)_              | Client id registered at the provider.                                                                                                                                                                 |
| `oidc.clientSecret`        | _(empty)_              | **Secret.** Client secret (leave empty for a public client; PKCE is always used).                                                                                                                     |
| `oidc.scopes`              | `openid profile email` | Space separated scopes. Add `groups` if your provider needs it to release group claims.                                                                                                               |
| `oidc.buttonLabel`         | `Sign in with SSO`     | Text of the sign-in button.                                                                                                                                                                           |
| `oidc.autoCreateUsers`     | `true`                 | Create a Hearer account on first sign-in. When off, only existing accounts can sign in.                                                                                                               |
| `oidc.usernameClaim`       | `preferred_username`   | Claim used as the username on first login (falls back to the email, then `sub`).                                                                                                                      |
| `oidc.emailClaim`          | `email`                | Claim holding the email address. It is only stored when the provider says `email_verified: true`.                                                                                                     |
| `oidc.groupsClaim`         | _(empty)_              | Claim holding group names (a list or a single string), for example `groups`. Required when you use the two settings below.                                                                            |
| `oidc.adminGroup`          | _(empty)_              | Members of this group get `ADMIN` when they sign in. Grant only: leaving the group does not remove admin.                                                                                             |
| `oidc.allowedGroups`       | `[]`                   | When not empty, only members of one of these groups may sign in.                                                                                                                                      |
| `oidc.linkExistingByEmail` | `false`                | Sign an SSO login into an existing local or Jellyfin account with the same verified email. Off by default because matching on email is an account-takeover risk on a shared or lax identity provider. |
| `oidc.linkAdminAccounts`   | `false`                | Also allow that linking for administrator accounts. Leave off unless you control the provider.                                                                                                        |
| `oidc.allowInsecureHttp`   | `false`                | Permit an `http://` issuer. Only for a provider on a trusted private network.                                                                                                                         |

### `mediaServer` (Settings, Media server)

| Key            | Default    | Meaning                                                                                                                                                                                    |
| -------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`         | `jellyfin` | The only supported media server in v1.                                                                                                                                                     |
| `url`          | _(empty)_  | Address Hearer uses to reach Jellyfin. May be an internal address (`http://jellyfin:8096`).                                                                                                |
| `externalUrl`  | _(empty)_  | Address users' browsers can reach, for "Open in Jellyfin" links. Empty means use `url`.                                                                                                    |
| `apiKey`       | _(empty)_  | **Secret.** A Jellyfin API key (Dashboard, API Keys).                                                                                                                                      |
| `serverId`     | _(empty)_  | Filled in by the connection test. Not meant to be edited.                                                                                                                                  |
| `libraryIds`   | _(all)_    | Restrict indexing to these Jellyfin library ids. Omitted means every music library.                                                                                                        |
| `pathMappings` | `[]`       | List of `{ serverPath, localPath }`. Translates between how Jellyfin sees the library and how Hearer does. Longest matching `serverPath` prefix wins. See [Path mappings](#path-mappings). |

### `library` (Settings, Library)

| Key               | Default                                                             | Meaning                                                                                                                 |
| ----------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `namingTemplate`  | `{albumartist}/{album} ({year})/{disc:?}{track:02} - {title}.{ext}` | Where imported files go, relative to `MUSIC_DIR`. See [Naming templates](#naming-templates).                            |
| `singlesTemplate` | `{albumartist}/Singles/{title}.{ext}`                               | Used for a track that is a single (an upload whose album tag is empty, or whose MusicBrainz release group is a Single). |

A template is validated when you save it. Unknown variables, a missing `{title}` or `{ext}`, absolute paths, `..` and backslashes are rejected.

### `uploads` (Settings, Uploads)

| Key                      | Default                                | Meaning                                                                                                                                           |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxFileSizeMb`          | `2048`                                 | Largest single file accepted.                                                                                                                     |
| `allowedFormats`         | `flac, mp3, m4a, ogg, opus, wav, aiff` | Accepted extensions. Every file is also probed with ffprobe, so a renamed non-audio file is rejected whatever its name.                           |
| `autoApproveThreshold`   | `0.9`                                  | Match score (0 to 1) at which an upload from a user with `AUTO_APPROVE_UPLOAD` skips review. See [MATCHING.md](MATCHING.md) for how it is scored. |
| `coverMaxPx`             | `1200`                                 | Cover art is scaled down to at most this many pixels before it is embedded.                                                                       |
| `allowDuplicateOverride` | `false`                                | Whether an uploader with `UPLOAD` may keep a file flagged as a duplicate as an alternate version. People with `MANAGE_UPLOADS` always may.        |

### `metadata` (Settings, Metadata)

| Key                  | Default                            | Meaning                                                                                                                             |
| -------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `musicBrainzBaseUrl` | `https://musicbrainz.org/ws/2`     | MusicBrainz web service. Point it at a mirror if you run one. Requests are limited to one per second either way.                    |
| `coverArtBaseUrl`    | `https://coverartarchive.org`      | Cover Art Archive. Used when embedding covers into imported files.                                                                  |
| `acoustIdApiKey`     | _(empty)_                          | **Secret.** Your AcoustID application key (free at acoustid.org). Without it uploads are matched from their tags and duration only. |
| `acoustIdBaseUrl`    | `https://api.acoustid.org/v2`      | AcoustID service, for a mirror.                                                                                                     |
| `cacheTtl`           | `{ entityDays: 7, searchDays: 1 }` | How long MusicBrainz answers stay fresh in the local cache (1-365 days each).                                                       |

### `fulfillment` (Settings, Fulfillment)

| Key                        | Default   | Meaning                                                                                                                         |
| -------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `manual.enabled`           | `true`    | Manual fulfillment: an approved request waits in `AWAITING_UPLOAD` until someone uploads the music and links it to the request. |
| `lidarr.enabled`           | `false`   | Hand approved album and artist requests to Lidarr.                                                                              |
| `lidarr.url`               | _(empty)_ | Lidarr base URL.                                                                                                                |
| `lidarr.apiKey`            | _(empty)_ | **Secret.** Lidarr API key (Settings, General).                                                                                 |
| `lidarr.rootFolder`        | _(empty)_ | Lidarr root folder new artists are added to.                                                                                    |
| `lidarr.qualityProfileId`  | `0`       | Lidarr quality profile id. The settings page lists the choices from your Lidarr.                                                |
| `lidarr.metadataProfileId` | `0`       | Lidarr metadata profile id.                                                                                                     |
| `lidarr.trackPolicy`       | `album`   | A track request: `album` asks Lidarr for the track's album, `skip` hands the request to Manual fulfillment.                     |

Hearer decides a request is available by looking at the media server's library, not at Lidarr's state, so music that arrives by any route (Lidarr, an upload, a manual copy) completes the request.

### Notification targets (Settings, Notifications)

Targets are not part of the settings catalog; they are rows you add under **Settings, Notifications**. Each has a name, an agent, the agent's own configuration (secrets masked), the events it subscribes to, and an on/off switch.

| Agent     | Needed                                     | Notes                                                                                                                                                                                              |
| --------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhook` | `url`                                      | POSTs JSON `{ event, message, data }`. Optional `headers`, an `authorization` value (secret) and a `secret` (secret) that signs the body: `X-Hearer-Signature: sha256=<hmac>`. Good for n8n.       |
| `discord` | `webhookUrl`                               | A channel webhook. Optional `username` and `avatarUrl`.                                                                                                                                            |
| `slack`   | `webhookUrl`                               | An incoming webhook.                                                                                                                                                                               |
| `ntfy`    | `topic` (and `serverUrl`, default ntfy.sh) | Optional access `token`, or `username` and `password`, and a `priority` from 1 to 5. `userTopics` lets the same server carry users' personal topics. Use a hard-to-guess topic on a public server. |
| `smtp`    | `host`, `from`, `to`                       | `port` (587), `secure` (implicit TLS, usually port 465), `requireTLS`, `user` and `pass` (secret). `userEmail` lets the server also send users their personal notifications.                       |

Each agent has a **Send test** action. A failed delivery is retried with backoff (see the job list under **Admin, Jobs**).

**Events** a target can subscribe to:

| Event                         | Fires when                                                              |
| ----------------------------- | ----------------------------------------------------------------------- |
| `request.created`             | A request is waiting for approval (skipped for auto-approved requests). |
| `request.approved`            | A request was approved.                                                 |
| `request.declined`            | A request was declined (the message carries the reason).                |
| `request.available`           | A requested item appeared in the library.                               |
| `request.partially_available` | Part of a requested album or artist appeared in the library.            |
| `request.failed`              | Fulfillment failed.                                                     |
| `upload.needs_review`         | An upload was analyzed and waits for review.                            |
| `upload.imported`             | An upload was tagged and filed into the library.                        |
| `upload.failed`               | An upload could not be processed.                                       |
| `upload.duplicate`            | An upload was flagged as a duplicate.                                   |

**Personal notifications:** users can opt in, under their profile, to hear about **their own** requests and uploads by email, or on a personal ntfy topic. This needs an SMTP target with `userEmail` on (or, for ntfy, a target with `userTopics` on). People never receive events about other users.

## Permissions

A permission is one bit in a number stored for each user. `ADMIN` implies every other permission. New users receive `general.defaultPermissions`.

| Permission            | Bit value | Allows                                                                                  | In default set |
| --------------------- | --------- | --------------------------------------------------------------------------------------- | -------------- |
| `ADMIN`               | 1         | Everything, including all settings and users.                                           | no             |
| `MANAGE_USERS`        | 2         | Create, edit and delete users, reset passwords, import Jellyfin users.                  | no             |
| `MANAGE_SETTINGS`     | 4         | Change settings and notification targets.                                               | no             |
| `REQUEST`             | 8         | Request single tracks.                                                                  | yes            |
| `REQUEST_ALBUM`       | 16        | Request albums.                                                                         | yes            |
| `REQUEST_ARTIST`      | 32        | Request whole artists.                                                                  | no             |
| `AUTO_APPROVE`        | 64        | Requests are approved immediately.                                                      | no             |
| `MANAGE_REQUESTS`     | 128       | Approve, decline, retry and cancel anyone's requests. Exempt from request quotas.       | no             |
| `UPLOAD`              | 256       | Upload music and review your own uploads.                                               | yes            |
| `AUTO_APPROVE_UPLOAD` | 512       | Uploads that match with a score at or above `uploads.autoApproveThreshold` skip review. | no             |
| `MANAGE_UPLOADS`      | 1024      | Review, approve, reject and retry anyone's uploads; override duplicates.                | no             |
| `VIEW_ALL_REQUESTS`   | 2048      | See every user's requests (read only).                                                  | no             |

The default set is `REQUEST + REQUEST_ALBUM + UPLOAD` = 8 + 16 + 256 = **280**. Add bit values to combine permissions: a request moderator might be `280 + 64 + 128 = 472`. The user editor shows these as checkboxes, so you rarely need the numbers.

Two guard rails apply: someone who is not an administrator can only grant permissions they hold themselves, and cannot edit users holding privileged permissions they lack. The last administrator cannot be deleted or demoted.

Accounts that sign in with Jellyfin start with the default permissions **minus** `UPLOAD`, and a Jellyfin administrator does **not** become a Hearer administrator. An admin grants `UPLOAD` per person.

## Quotas

Quotas are counted over a rolling window.

- **Request quota:** every request a user made in the last `days` days counts, except declined and cancelled ones. `ADMIN` and `MANAGE_REQUESTS` are exempt.
- **Upload quota:** megabytes uploaded in the last `days` days, checked when an upload starts.
- Defaults come from `general.defaultRequestQuota` and `general.defaultUploadQuota`. Each user can have their own numbers on the user editor; leaving a field empty means "use the default". A limit of `0` means unlimited.

## Auto-approve

Approval is permission driven, never tied to one integration.

- A user with `AUTO_APPROVE` has their requests approved immediately and handed to the fulfillment provider. Admins get this too, since `ADMIN` implies every permission.
- A user with `AUTO_APPROVE_UPLOAD` skips the review step when the best match scores at least `uploads.autoApproveThreshold` and the file is not a duplicate. Everyone else's uploads stop in `NEEDS_REVIEW`.

## Naming templates

The template renders the path of an imported file, relative to `MUSIC_DIR`. Write `/` between folders. Values are cleaned up per path segment, so `AC/DC` becomes `AC_DC`, characters that are illegal on Windows are replaced, and a segment that ends up empty becomes `Unknown Artist`, `Unknown Album` or `Unknown`. Empty brackets, for example from a missing year, are dropped. A name that already exists is never overwritten.

| Variable                          | Value                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `{albumartist}`                   | Album artist (falls back to the track artist)                                              |
| `{artist}`                        | Track artist                                                                               |
| `{album}`                         | Album title                                                                                |
| `{title}`                         | Track title (required in every template)                                                   |
| `{ext}`                           | File extension without the dot (required in every template)                                |
| `{genre}`                         | Genre                                                                                      |
| `{date}`, `{year}`                | Release date as tagged, and its four-digit year                                            |
| `{track}`, `{track:02}`           | Track number, optionally zero padded (`02` gives `07`)                                     |
| `{disc}`, `{disc:02}`, `{disc:?}` | Disc number. `{disc:?}` is `1-`, `2-`, ... on multi-disc releases only and empty otherwise |
| `{mbrecording}`, `{mbtrack}`      | MusicBrainz recording id, release track id                                                 |
| `{mbrelease}`, `{mbreleasegroup}` | MusicBrainz release id, release group id                                                   |
| `{mbartist}`, `{mbalbumartist}`   | MusicBrainz artist id, album artist id                                                     |
| `{acoustid}`                      | AcoustID track id                                                                          |

Examples, for track 2 "Paranoid Android" of the 1997 album "OK Computer" by Radiohead:

| Template                                                                      | Result                                                    |
| ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| `{albumartist}/{album} ({year})/{disc:?}{track:02} - {title}.{ext}` (default) | `Radiohead/OK Computer (1997)/02 - Paranoid Android.flac` |
| `{albumartist}/{album}/{track:02} {title}.{ext}`                              | `Radiohead/OK Computer/02 Paranoid Android.flac`          |
| `{artist} - {title}.{ext}`                                                    | `Radiohead - Paranoid Android.flac`                       |

The setup wizard and the library settings page show a live preview. The files are tagged (MusicBrainz ids, AcoustID id, cover art) before they are moved in.

## Path mappings

Jellyfin reports where each file lives **as Jellyfin sees it**. If Jellyfin mounts your library somewhere else than Hearer does, Hearer cannot match files by path and cannot tell Jellyfin which folder changed. Add a mapping:

| Jellyfin sees the library at | Hearer sees it at | Mapping                                             |
| ---------------------------- | ----------------- | --------------------------------------------------- |
| `/data/music`                | `/music`          | `serverPath: /data/music`, `localPath: /music`      |
| `/mnt/media/Music`           | `/music`          | `serverPath: /mnt/media/Music`, `localPath: /music` |

If both containers mount the library at the same path, no mapping is needed. When several mappings match a path, the longest `serverPath` wins.

## Security notes

- **`HEARER_SECRET` and `secret.key`.** Stored credentials (the Jellyfin and Lidarr API keys, the OIDC client secret, the AcoustID key, notification secrets) are encrypted with AES-256-GCM. The key comes from `HEARER_SECRET`, or, when that is unset, from `DATA_DIR/secret.key`, generated on first start with mode `0600`. **Back it up together with the database.** If the key is lost, the stored credentials cannot be decrypted and you must enter them again in the settings (nothing else is lost). Changing `HEARER_SECRET` has the same effect. Prefer the generated file unless you manage secrets elsewhere; if you set `HEARER_SECRET`, keep it out of your compose file's version control.
- **Passwords** are hashed with argon2id. Sessions are random 32-byte tokens in an `HttpOnly`, `SameSite=Lax` cookie (marked `Secure` when you are on https), valid for 30 days of activity. Every state-changing request from a browser also needs a CSRF token.
- **API keys** (`hrr_...`, created under your account) work in the `X-Api-Key` or `Authorization: Bearer` header. They cannot create more keys or change your password.
- **Reverse proxy and `TRUST_PROXY`.** Behind a proxy, set `TRUST_PROXY=1` (the number of proxies in front of Hearer) so rate limiting sees real client addresses and cookies get the `Secure` flag from `X-Forwarded-Proto`. Never set `TRUST_PROXY=true` when Hearer is directly reachable from the internet: clients could then forge their address. Set `BASE_URL` to your https address.
- **Rate limits.** Sign-in endpoints allow `AUTH_RATE_LIMIT_MAX` attempts per minute per address. Search is rate limited too, and MusicBrainz is called at most once per second whatever the load.
- **Content Security Policy.** The web app is served with a strict policy. Cover art is only loaded from the Cover Art Archive and archive.org. If you point `coverArtBaseUrl` at a mirror, browsers will not display its images (embedding into files still works).
- **Library writes** are always checked to stay inside `MUSIC_DIR`. File names from users are sanitized and never trusted as paths.
- **Uploads** are your responsibility: only allow people to upload music they have the right to store. The `UPLOAD` permission is off by default for imported Jellyfin users.
- **OIDC.** Leave `linkExistingByEmail` off unless your identity provider verifies every email address.

### Uploads, chunking and the 100 MB limit

Uploads use the [tus](https://tus.io) resumable protocol at `/api/v1/uploads/tus`. The browser slices each file into chunks of **at most 50 MB**, and each chunk is a separate request, so a 2 GB FLAC works behind proxies that cap request bodies. This is what makes Cloudflare (including Cloudflare Tunnel) usable: it rejects request bodies over **100 MB** on free and pro plans, and 50 MB chunks stay well below that. An interrupted upload resumes from the last complete chunk.

Requirements for anything in front of Hearer: allow request bodies of at least **55 MB** (a 50 MB chunk plus overhead), do not buffer request bodies, and keep read timeouts above a minute. Chunks must arrive with a `Content-Length` header; chunked transfer encoding is refused. Abandoned partial uploads are deleted after 24 hours.
