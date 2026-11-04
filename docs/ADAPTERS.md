# Adapters

Hearer talks to the outside world through small adapter interfaces so that integrations can be
swapped or added without touching the core. This file holds the contracts and the notes for each
shipped adapter. Source of truth for the types: `apps/server/src/adapters/*/types.ts`.

## MediaServerAdapter

`apps/server/src/adapters/mediaserver/types.ts`

```ts
interface ServerInfo {
  id: string;
  name: string;
  version: string;
  versionSupported: boolean; // false below the minimum (Jellyfin 10.10)
  warning?: string;
}

interface ExternalUser {
  id: string;
  name: string;
  isAdmin: boolean;
  isDisabled?: boolean;
  email?: string;
}

type LibraryItemKind = 'artist' | 'album' | 'track';

interface LibraryItem {
  serverItemId: string;
  kind: LibraryItemKind;
  name: string;
  artistName: string | null; // track artist (tracks) / album artist (albums) / null (artists)
  albumName: string | null;
  durationMs: number | null;
  mbRecordingId: string | null; // tracks only
  mbReleaseGroupId: string | null;
  mbArtistId: string | null;
  mbAlbumId: string | null; // MusicBrainz release id
  path: string | null; // as the media server sees it
  dateCreated: Date | null;
}

interface MediaServerAdapter {
  id: 'jellyfin' | (string & {});
  testConnection(): Promise<ServerInfo>;
  authenticate(username: string, password: string): Promise<ExternalUser>; // login flow
  listUsers?(): Promise<ExternalUser[]>; // import users
  iterateLibrary(opts: { since?: Date; signal?: AbortSignal }): AsyncIterable<LibraryItem>;
  notifyPathsChanged(paths: string[]): Promise<void>; // targeted rescan, falls back to refreshLibrary
  refreshLibrary(): Promise<void>; // full-scan fallback
  itemUrl?(serverItemId: string): string; // "Open in Jellyfin"
}
```

Errors (all extend `MediaServerError`, which carries the HTTP `status` when there was one):

| Class                           | Meaning                                                        | API mapping                                              |
| ------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| `MediaServerAuthError`          | credentials (user password or API key) rejected (HTTP 401/403) | login: 401; admin routes: 502 `media_server_auth_failed` |
| `MediaServerUnavailableError`   | connection failed, timeout, or HTTP 5xx                        | 502 `media_server_unavailable`                           |
| `MediaServerNotConfiguredError` | URL or API key missing in settings                             | 503 `media_server_not_configured`                        |
| `MediaServerError` (base)       | any other unexpected answer                                    | 502 `media_server_error`                                 |

Use `app.hearer.mediaServer.get()` to obtain the adapter for the stored `mediaServer` settings
(`getMediaServer(settings, deps)` in `adapters/mediaserver/registry.ts` is the factory behind it).

## FulfillmentProvider

Copied from `docs/PLAN.md`; batch H-12 replaces this with the final, implemented contract.

```ts
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

## Jellyfin

`apps/server/src/adapters/mediaserver/jellyfin.ts`. Targets Jellyfin 10.10 and newer (tested
design target 10.11). Uses Node's built-in `fetch` with a 10 s timeout per request (60 s for
library pages).

> **Fixtures are synthesized and unverified.** No live Jellyfin server was available when this
> adapter was written. `apps/server/test/fixtures/jellyfin/*.json` were written by hand from the
> OpenAPI description and from memory, never recorded from a running server. Run the live test
> below against a real 10.11 server and replace them with sanitized recordings.

### Authentication header

Every request carries only:

```
Authorization: MediaBrowser Client="Hearer", Device="Hearer Server", DeviceId="<id>", Version="<hearer version>"[, Token="<token>"]
```

- `DeviceId` is `hearer-` plus 32 hex characters derived (HMAC) from the install's secret key, so it
  is stable across restarts and unique per install without being stored separately.
- `Token` is the admin API key for server calls. `AuthenticateByName` is sent without a token.
- Values are escaped: `"`, `\`, `,` and control characters are percent-encoded.
- Hearer never sends `X-Emby-*` / `X-MediaBrowser-*` headers and never puts `api_key` in a query
  string (DECISIONS rule 1). A test captures every request the adapter makes and asserts this.

### Endpoints

| Adapter method         | Request                                                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `testConnection()`     | `GET /System/Info` (needs the API key). `versionSupported` is false below 10.10                                                                                                                                                                                                            |
| `authenticate()`       | `POST /Users/AuthenticateByName` `{ "Username", "Pw" }`, no token; 401/403 → `MediaServerAuthError`. The session it opens is closed again with `POST /Sessions/Logout` (best effort)                                                                                                       |
| `listUsers()`          | `GET /Users`                                                                                                                                                                                                                                                                               |
| `iterateLibrary()`     | `GET /Items?IncludeItemTypes=Audio,MusicAlbum,MusicArtist&Recursive=true&Fields=ProviderIds,Path,DateCreated&SortBy=SortName&SortOrder=Ascending&StartIndex=N&Limit=500`, plus `MinDateLastSaved=<ISO>` when `since` is set and `ParentId=<id>` once per entry of `mediaServer.libraryIds` |
| `notifyPathsChanged()` | `POST /Library/Media/Updated` `{ "Updates": [{ "Path", "UpdateType": "Created" }] }`; on 404/405/5xx/connection error falls back to `refreshLibrary()` (not on a rejected key)                                                                                                             |
| `refreshLibrary()`     | `POST /Library/Refresh`                                                                                                                                                                                                                                                                    |
| `itemUrl(id)`          | `<externalUrl or url>/web/#/details?id=<id>`                                                                                                                                                                                                                                               |

The base URL may include a sub-path (`https://host/jellyfin`); trailing slashes, query and
fragment are dropped. `mediaServer.externalUrl` (optional) is the browser-facing address used
for links when Hearer reaches Jellyfin on an internal one.

`RunTimeTicks` (100 ns units) is converted to milliseconds (`ticks / 10000`, rounded).

### ProviderIds mapping

> **⚠ Unverified against live 10.11; verify with the live test.** The exact key Jellyfin uses
> for a track's MusicBrainz _recording_ id is uncertain: `MusicBrainzTrack` is populated from the
> MUSICBRAINZ_TRACKID tag (Picard writes the recording id there) in at least some versions, while
> newer versions may keep a release-specific track id under it. Hearer therefore accepts both,
> preferring `MusicBrainzRecording`.

Keys are matched case-insensitively. Values must be UUIDs, otherwise they are ignored.

| LibraryItem field  | Item type    | ProviderIds key (first match wins)                 |
| ------------------ | ------------ | -------------------------------------------------- |
| `mbRecordingId`    | Audio        | `MusicBrainzRecording`, then `MusicBrainzTrack`    |
| `mbReleaseGroupId` | Audio, Album | `MusicBrainzReleaseGroup`                          |
| `mbAlbumId`        | Audio, Album | `MusicBrainzAlbum`                                 |
| `mbArtistId`       | all          | `MusicBrainzArtist`, then `MusicBrainzAlbumArtist` |

Other fields: `artistName` is `Artists[0]` (then `AlbumArtist`) for tracks and `AlbumArtist`
(then `Artists[0]`) for albums; `albumName` is `Album` for tracks and `Name` for albums.
Items of other types are skipped. Paths are reported exactly as Jellyfin stores them, which can
differ from Hearer's mount point (no path translation exists yet; see the STATUS open questions).

### Login and user import

- `POST /api/v1/auth/jellyfin` `{ username, password }` (public, rate limited like local login,
  CSRF-exempt, needs `auth.jellyfinEnabled` and a configured media server). It authenticates
  against Jellyfin, finds or creates the Hearer account (`auth_type = jellyfin`,
  `external_id` = Jellyfin user id) and starts a session like local login.
- New Jellyfin accounts get `general.defaultPermissions` **minus UPLOAD**, so admins grant upload
  rights deliberately (PLAN: imported users do not get UPLOAD by default). Existing accounts keep
  whatever an admin set.
- A Jellyfin administrator does **not** become a Hearer ADMIN. Media-server admin rights say
  nothing about who may approve requests or manage Hearer, and auto-promoting from an external
  system would let a compromise of that system take over Hearer. Promote users explicitly.
- `GET /api/v1/users/import/jellyfin` lists Jellyfin users (flagging those already imported) and
  `POST /api/v1/users/import/jellyfin` `{ ids }` imports them (MANAGE_USERS). Disabled Jellyfin users
  are skipped.
- `POST /api/v1/settings/mediaServer/test` tests a candidate config without saving it (a masked
  API key means "use the stored one"); `PUT /api/v1/setup/mediaServer` tests the connection before
  saving and stores the server's id.

### Live test

`apps/server/test/jellyfin.live.test.ts` is skipped unless `JELLYFIN_TEST_URL` and
`JELLYFIN_TEST_API_KEY` (an admin API key from Dashboard > API Keys) are set. It is read-only
(a login check creates and immediately closes one Jellyfin session).

```sh
JELLYFIN_TEST_URL=http://localhost:8096 \
JELLYFIN_TEST_API_KEY=... \
JELLYFIN_TEST_USER=alice JELLYFIN_TEST_PASSWORD=... \   # optional: also checks login
pnpm --filter server test -- jellyfin.live
```

It prints the server version and how many sampled tracks carry a recording id. To settle the
ProviderIds question, also capture `GET /Items?IncludeItemTypes=Audio&Fields=ProviderIds&Limit=5`
from a library with MusicBrainz-tagged files, update the table above and the fixtures, and drop
the "unverified" notes.
