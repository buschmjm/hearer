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

Source: `apps/server/src/adapters/fulfillment/{types,manual,lidarr,registry}.ts`.

```ts
interface FulfillmentProvider {
  id: string;
  label: string;
  supports: { track: boolean; album: boolean; artist: boolean }; // may depend on settings
  configSchema: ZodType; // validates the provider's settings; drives the settings form
  submit(
    request: RequestRecord,
    options?: { signal? },
  ): Promise<{ ref: string; status: 'PROCESSING' | 'AWAITING_UPLOAD'; note?: string }>;
  poll?(ref: string, options?): Promise<{ state: 'pending' | 'done' | 'failed'; detail?: string }>;
  cancel?(ref: string, options?): Promise<void>;
  testConnection?(options?): Promise<{ ok: boolean; message?: string; version?: string }>;
  describeConfig?(): Record<string, unknown>; // current config, secrets masked
}
```

`RequestRecord` is `{ id, type, mbid, parentMbid, title, artistName }` (`parentMbid` is a
track's release group when known). `configJsonSchema(provider)` renders `configSchema` as JSON
Schema (zod's `toJSONSchema`) for the web settings form.

### Errors

| Throw                    | Meaning                                                      | What the submit job does                                          |
| ------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `ProviderSkipError`      | cannot handle this request (track policy, track on no album) | tries the next provider (Manual)                                  |
| `ProviderTemporaryError` | network error, 5xx/429, an album Lidarr has not imported yet | rethrown; the runner retries with backoff (30 s base, 6 attempts) |
| `ProviderPermanentError` | rejected key, incomplete settings, unknown artist/album      | request goes to FAILED with the message                           |
| anything else            | unexpected                                                   | treated as temporary                                              |

After the last attempt a still-failing request goes to FAILED with the error as the timeline
note. An admin can fix the cause and press Retry (`POST /requests/:id/retry`).

### Completion is never a provider's decision

A provider only gets the request started. A request becomes AVAILABLE when the library index
shows it (`requests.availability`, queued after every library sync), so music that arrives by any
route (Lidarr, an upload, a file dropped into the folder) completes the request. `poll` exists for
visibility: `requests.poll` runs every 5 minutes over PROCESSING requests and adds a timeline
note when the provider's detail text changes (a download progressing, an import blocked). A
`failed` poll result (a failed Lidarr search command) moves the request to FAILED.

### Selection (`FulfillmentRegistry.select`)

Providers are tried in order, Lidarr then Manual; the first that is **enabled** and whose
`supports[type]` is true wins. `supports.track` of Lidarr is `trackPolicy === 'album'`. A provider
can still decline at submit time with `ProviderSkipError`. When no enabled provider can take the
request type (for example Lidarr only, with `trackPolicy: 'skip'`, and a track request) the
request goes to **FAILED** with the note "No fulfillment provider is available for track
requests". It does not sit in APPROVED silently: the failure is visible and notifies, and Retry
works once the settings are fixed. Manual is enabled by default, so a stock install always has a
provider.

`GET /api/v1/fulfillment/providers` (MANAGE_SETTINGS) lists every provider with `enabled`,
`supports`, `settingsPath` (e.g. `fulfillment.lidarr`), the JSON Schema (secret properties carry
`"x-secret": true`) and the current config with secrets masked.

### Manual

`submit` returns `{ ref: 'manual:<requestId>', status: 'AWAITING_UPLOAD' }` and contacts nothing.
The request waits for an upload that names it ("fulfills request"): the import calls
`RequestsService.fulfillFromUpload(requestId, uploadId, { partial? })`, which records the upload
and moves the request to AVAILABLE (or PARTIALLY_AVAILABLE). Hearer is fully useful with Manual
alone.

### Lidarr

> **Unverified.** No live Lidarr was available. Endpoints, parameters and field names follow
> Lidarr's OpenAPI document (`src/Lidarr.Api.V1/openapi.json`, develop branch, fetched when this
> was written). The command payloads (`ArtistSearch {artistId}`, `AlbumSearch {albumIds}`) are not
> described by that document and follow the Servarr wiki. The fixtures in
> `apps/server/test/fixtures/lidarr/` are synthesized from the schema, and the mock server in
> `test/helpers/lidarr-mock.ts` is a stand-in, so a real instance may differ. When one is available,
> record real responses over the fixtures and drop this notice.

Settings key `fulfillment.lidarr` (**disabled by default**): `enabled`, `url`, `apiKey` (secret,
encrypted at rest, masked in the API), `rootFolder`, `qualityProfileId`, `metadataProfileId`,
`trackPolicy: 'album' | 'skip'`. URL may include a sub-path; every call is `<url>/api/v1/...`
with the `X-Api-Key` header (never a query parameter) and a 15 s timeout.

| Request | Calls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| artist  | `GET artist?mbId=<mbid>`. Unknown: `GET artist/lookup?term=lidarr:<mbid>`, then `POST artist` `{ foreignArtistId, artistName, qualityProfileId, metadataProfileId, rootFolderPath, monitored: true, monitorNewItems: 'all', addOptions: { monitor: 'all', searchForMissingAlbums: true } }` (Lidarr searches by itself). Known: `PUT artist/{id}` monitored, `PUT album/monitor` for all its albums, `POST command {name: 'ArtistSearch', artistId}`.                                                                       |
| album   | `GET album?foreignAlbumId=<rg>`. Missing: `GET album/lookup?term=lidarr:<rg>` (names the artist), add the artist with `monitorNewItems: 'none'` and `addOptions: { monitor: 'none', searchForMissingAlbums: false }` if needed, then `GET album` again. Still absent (Lidarr is still refreshing the artist, or its metadata profile excludes the type) is a temporary error and the job retries with backoff. Then `PUT album/monitor { albumIds, monitored: true }` and `POST command { name: 'AlbumSearch', albumIds }`. |
| track   | The parent release group (`request.parentMbid`, else `MetadataProvider.getRecording`) is requested as an album. `trackPolicy: 'skip'`, or a recording on no album, hands the request to Manual.                                                                                                                                                                                                                                                                                                                             |

`provider_ref` is JSON `{ v: 1, kind, artistId, artistMbid, artistAdded, albumId?, albumMbid?, commandId? }`
(never exposed by the API). `poll` reads `GET queue/details?albumIds=` (or `artistId=`) and
`GET command/{id}`: a running download is `pending` with its progress, a stuck import is `pending`
with Lidarr's message, a finished search with an empty queue is `done`, a `failed` command is
`failed`. `cancel` unmonitors the album (`PUT album/monitor { monitored: false }`), or the artist
when this request added it; an artist that was already in Lidarr is left alone. A cancel that cannot
reach Lidarr still cancels the request and the timeline says so. `testConnection` is
`GET system/status`.

Admin routes (MANAGE_SETTINGS), following the media server's masked-secret convention:

- `POST /api/v1/settings/fulfillment/lidarr/test`: body is the form's Lidarr settings, a masked
  `apiKey` (`********`) means the stored one. Always 200 `{ ok, version?, message? }`.
- `GET /api/v1/settings/fulfillment/lidarr/options`: quality profiles, metadata profiles and root
  folders of the **saved** Lidarr (`qualityprofile`, `metadataprofile`, `rootfolder`); save URL and key
  first. 400 `provider_rejected` for a missing or rejected key, 502 `provider_unavailable` when
  Lidarr is unreachable.

Known limits: an album excluded by the chosen metadata profile never appears in Lidarr and the
request fails after the retries with a message saying so; a Lidarr search that finds nothing leaves
the request in PROCESSING (the poll note says "finished and nothing is downloading") until an admin
cancels or retries it.

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
