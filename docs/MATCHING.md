# Library matching

How Hearer decides whether something is already in the media library. The code is in
`apps/server/src/lib/normalize.ts`, `services/library.ts` (index sync, path mapping) and
`services/availability.ts` (the matchers). The rules below are the contract the tests pin down.

## The index

`library.sync` mirrors the media server into the `library_items` table (one row per artist,
album and track). Each row stores the MusicBrainz ids the server knows (`mb_recording_id`,
`mb_release_group_id`, `mb_artist_id`), the duration, the path exactly as the media server reports
it, and `norm_key`, the fuzzy key: `artist|title` for tracks and albums (album artist and album
name for albums), the normalized name for artists.

- **Incremental** (every 15 minutes): items the server saved since the last successful run, minus
  a 5 minute overlap. Upserts by `server_item_id`; never deletes.
- **Full** (nightly at 03:00 server-local time, or on demand): reads everything, then deletes rows
  that were not seen in this run (mark and sweep on `synced_at`). The sweep only runs when the
  whole iteration finished without error, and is skipped when the server returned no items at all
  while the index is not empty. A failed run never removes anything.
- Writes happen in transactions of 500 rows. Sync state (`lastIncrementalAt`, `lastFullAt`,
  `lastMode`, `lastCounts`, `lastError`) is kept in the `settings` table under the internal key
  `library.syncState`. It is not a catalog setting, so the settings API cannot read or write it;
  `GET /api/v1/library/status` shows it.
- Without a configured media server the job is a quiet no-op (debug log). After a successful run
  `requests.availability` is enqueued if that job type is registered (H-11).
- `POST /api/v1/library/sync {mode}` (MANAGE_SETTINGS) queues a run; a run of the same mode that
  is already queued or running is reused (`202 {jobId, mode}`).

## Path mapping

Jellyfin reports paths as it sees them. If its mount differs from Hearer's, set
`mediaServer.pathMappings` to a list of `{serverPath, localPath}`. `toLocalPath` and
`toServerPath` (in `services/library.ts`, also on `LibraryService`) translate by longest matching
prefix; a prefix only matches at a path separator (`/music` does not match `/musical`), trailing
separators are ignored, and `\` paths are supported. Unmapped paths pass through. The index stores
the server path unchanged; library writes (uploads) use `toServerPath` before telling the server
which paths changed.

## Normalization

Both sides (media server tags and MusicBrainz) pass through the same functions:

1. Lowercase, NFKD, strip diacritics after Latin letters only (`Beyoncé` = `beyonce`). Marks in
   other scripts are kept (Japanese dakuten, Cyrillic й, Greek accents), so CJK, Cyrillic and
   Hangul text is preserved. `ø ð đ ł ß æ œ ı þ` are folded.
2. Noise suffixes are removed, in brackets and as a trailing ` - suffix`, repeatedly.
3. `&` becomes `and`; apostrophes and periods are deleted (`R.E.M.` = `rem`); every other
   non-letter, non-digit becomes a space; whitespace is collapsed.
4. Artists only: a leading `the ` is dropped. Titles keep it.
5. If everything was stripped (`!!!`, `(Remastered)`), the lowercased input without whitespace is
   used so distinct odd names do not collapse into one key.

**Noise** (same recording, removed): `feat.`/`ft.`/`featuring`/`with X` credits, and a group made
only of: remaster(ed), deluxe, edition, expanded, anniversary, reissue, bonus, track(s), version,
mono, stereo, explicit, clean, digital, original, album, super, special, collector's, legacy, plus
years and numbers.

**Meaningful** (different recording, kept): anything containing live, acoustic, remix/mix, demo,
instrumental, cover, unplugged, session(s), karaoke, a cappella, edit, radio, single, reprise, part,
dub, rework, bootleg, medley, intro, outro, interlude, skit, and any bracket text not recognised.
One meaningful word keeps the whole group.

`normKey(artist, title)` is `null` when either half is empty.

## Badges (`LibraryLookup`)

`FuzzyLibraryLookup` is the default for `AppDeps.libraryLookup`. It answers one page of ids with a
fixed number of queries (an exact and a fuzzy query per kind). Fuzzy answers need name hints
(`CatalogIds.hints`), which the search routes pass from the catalog items they already hold.

| Kind   | `yes`                             | `possible`                                                                                                        |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Track  | `mb_recording_id` equals the MBID | `norm_key` matches (any credited-artist spelling) and the durations are within 3 s, or either duration is unknown |
| Album  | `mb_release_group_id` on any item | an album item with the same album artist and album name                                                           |
| Artist | `mb_artist_id` on any item        | an artist item with the same normalized name                                                                      |

The tolerance is inclusive: 3.0 s matches, 3.1 s does not.

## Request availability (`AvailabilityMatcher.evaluateRequest`)

Stricter than the badge, because it can complete a request. Returns
`{status, matched (server item ids), possible, confidence}`. Metadata comes from the cached,
rate-limited `MetadataProvider` and is memoized per `AvailabilityRun`; share one run across all
requests of a job pass. A MusicBrainz outage throws so the job retries.

- **Track:** `AVAILABLE` on an exact recording id (confidence 1), or on a fuzzy match where artist,
  title and duration all match, the duration being known on both sides and within 3 s (0.8). A
  name match with an unknown or distant duration is `NOT_AVAILABLE` and listed under `possible`.
- **Album:** compare the library's tracks with the representative tracklist of the release group.
  A track is present on an exact recording id, or on a fuzzy match inside the album (same release
  group id, or the same normalized album name) with a duration within 3 s or unknown. All present is
  `AVAILABLE`, some `PARTIALLY_AVAILABLE`. When no track matches (or MusicBrainz lists none), an
  album item with the exact release group id still gives `AVAILABLE` (0.6) for libraries whose
  tracks carry no ids. A name-only album item is not enough.
- **Artist:** `AVAILABLE` when every studio album of the artist (primary type Album, no secondary
  types; live albums, compilations and EPs are ignored) is in the library, by exact release group
  id on any item or a same-named album item (0.8 when any were fuzzy); `PARTIALLY_AVAILABLE` when
  there is at least one item by the artist (by `mb_artist_id` or name). An artist with no studio
  albums can be at most partial, since completeness cannot be established.
