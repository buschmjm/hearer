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

## Upload matching (`upload.analyze`)

Code: `jobs/uploadAnalyze.ts` (orchestration), `services/matching.ts` (scoring, candidates, album
grouping, duplicate checks), `services/uploadReview.ts` (review actions, auto-approve),
`adapters/metadata/acoustid.ts`, `lib/fpcalc.ts`, `lib/audioTags.ts`.

### Steps

1. **Duplicate by bytes (a).** The same sha256 is already `IMPORTED`, or in flight (`RECEIVED`,
   `ANALYZING`, `NEEDS_REVIEW`, `APPROVED`, `IMPORTING`) as another upload that got there first
   (earlier creation time, then lower id, so two identical files never flag each other). Rejected,
   failed and duplicate rows do not count. Checked before any network work.
2. **Read the file's tags** with `music-metadata` (title, artist, album artist, album, track and
   disc numbers, date, genre, ISRC, MusicBrainz recording and release ids, whether a picture is
   embedded). An unparsable file simply has no tags.
3. **Fingerprint** with `fpcalc -json -length 120`. A missing binary or an undecodable file is not
   fatal: the job carries on with tags only (`acoustId.status = no_fingerprint`).
4. **AcoustID lookup** (`POST {metadata.acoustIdBaseUrl}/lookup`, own limiter at 340 ms between
   requests, so at most 3 per second) when `metadata.acoustIdApiKey` is set; otherwise `disabled`.
5. **Candidates.** Recordings from AcoustID, the recording id in the file's own tags, and a
   MusicBrainz recording search on `artist title` (always run when a title tag exists, so it works
   with no AcoustID key). A preliminary score (below, without album and track number) picks the best
   five (at least 0.2); each gets its details through the cached `MetadataProvider`.
6. **Release choice** per candidate: release groups ordered by the tagged release's group, a
   title match with the album tag, AcoustID's own hint, then MusicBrainz's "home album first" order.
   Inside a group the releases are ranked (`rankReleases`): a release the batch settled on (+20),
   a release id named by a tag (+10), same album title (+3), same track count as the tags (+2),
   Official (+1), the group's representative release (+0.5, the H-09 heuristic); date and id break
   ties. The tracklists of the best three are searched for the recording; its position gives the
   track and disc numbers. If it is on none of them the candidate keeps the representative
   release and the numbers from the file's tags.
7. **Duplicate by library (b), (c).** After matching, the top candidate (or, with none, the file's
   tags) is checked against `library_items`: (b) the recording id is in the index; (c)
   `FuzzyLibraryLookup`: the same `artist|title` key (every spelling of the credit is tried) with a
   duration within 3 s, or with the library duration unknown. Either gives `DUPLICATE`.
8. **Outcome.** `NEEDS_REVIEW` with `match_json` (candidates, existing tags, AcoustID status,
   duplicate info, group) and `chosen_json` (the top candidate's `TagSet`). Auto-approval and the
   `upload.needs_review` event happen in the finalize step (below).

### Score (0 to 1)

Each piece of evidence is a number in 0..1, or absent:

| Evidence | Weight | Value                                                                                                      |
| -------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| AcoustID | 0.40   | the fingerprint score of the recording                                                                     |
| Title    | 0.15   | `similarity(tag title, MusicBrainz title)`                                                                 |
| Artist   | 0.15   | best `similarity` of tag artist or album artist against the track and album artist credits                 |
| Album    | 0.10   | `similarity(tag album, release title)`                                                                     |
| Duration | 0.12   | 1 when the file and the track differ by at most 2 s, falling linearly to 0 at 15 s                         |
| Track    | 0.08   | 1 when the tag track number equals the candidate's; 0.5 for the right track on the wrong disc; 0 otherwise |

`similarity` normalizes both names with `lib/normalize` (the same rules as the library index, so
"(Remastered)", "feat." and accents do not matter), then takes the better of the Levenshtein ratio
and the Levenshtein ratio of the sorted tokens (word order does not matter).

The score is the weighted mean over the evidence that exists (an untagged file has no title,
artist, album or track evidence, and is not punished for it). **Without an AcoustID score the mean
is multiplied by 0.95**, so a match from tags alone can reach 0.95 but never 1.0. Candidates are
sorted by score, then fingerprint-backed first, then id.

### Album grouping

When every file of a `batch_id` has finished analysis (no sibling is `RECEIVING`, `RECEIVED` or
`ANALYZING`; the last file to finish does this, idempotently) and at least two files have
candidates, the files are grouped: the release group that appears among the candidates (score
at least 0.3) of the most files, at least two, wins, ties going to the higher total score. Within
it the release holding the most of the batch's files is chosen from the three best-ranked
(tagged release ids and the majority album title feed `rankReleases`). Each file that appears on
that release has its candidate rebuilt there (so track and disc numbers are consistent) and
re-scored; files that do not appear are listed in `group.unmatchedUploadIds` and keep their own
candidates. `match_json.group` holds `{releaseMbid, releaseGroupMbid, title, artist, trackTotal,
tracks: [{uploadId, recordingMbid, discNumber, trackNumber}], unmatchedUploadIds}`. Files a
reviewer already edited (`match.reviewed`) are not touched. A batch with a file stuck in
`RECEIVING` is not grouped (and not auto-approved) until that file finishes, fails or expires.

### Finalize: auto-approve and events

For a single file, or for every file of a batch after grouping: if the uploader holds
`AUTO_APPROVE_UPLOAD`, the top score is at least `uploads.autoApproveThreshold` (default 0.9),
there is a proposal, and the upload is neither a duplicate nor a kept duplicate, it becomes
`APPROVED` and `upload.import` is enqueued (when that job is registered; otherwise the upload waits
in `APPROVED`). Everything else stays `NEEDS_REVIEW` and emits `upload.needs_review` once.
`DUPLICATE` emits `upload.duplicate`. Events go to `app.hearer.events` when that bus exists.

### Failure and retries

MusicBrainz or AcoustID outages throw, and the runner retries (3 attempts, backoff). On the last
attempt AcoustID trouble is tolerated (tags still work, `acoustId.status = error`); a MusicBrainz
outage, a vanished staged file or any other error marks the upload `FAILED` with
`Analysis failed: ...`. `POST /uploads/:id/reanalyze` re-queues a `FAILED`, `DUPLICATE` or
`NEEDS_REVIEW` upload (for example after adding an AcoustID key).

### Duplicate override

`POST /uploads/:id/keep {reason?}` moves a `DUPLICATE` back to `NEEDS_REVIEW` ("keep as alternate
version"; `match_json.kept` records who and why, and a re-analysis honours it). Allowed for
`MANAGE_UPLOADS`; the owner (with `UPLOAD`) may do it only when `uploads.allowDuplicateOverride` is
on. The setting defaults to **off**, so by default only managers override. A kept duplicate is
never auto-approved.

### Review API

| Route                                  | Who                                                       | Effect                                                                  |
| -------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /uploads/:id`                     | owner or `MANAGE_UPLOADS`                                 | upload plus `match` (candidates, group, duplicate), `chosen`, `canKeep` |
| `PUT /uploads/:id/review`              | owner (`UPLOAD`) or `MANAGE_UPLOADS`; `NEEDS_REVIEW` only | validates and stores the `TagSet`, `candidateId`, `targetRequestId`     |
| `POST /uploads/:id/approve`            | `MANAGE_UPLOADS`, or the owner with `AUTO_APPROVE_UPLOAD` | `APPROVED`, enqueue `upload.import`                                     |
| `POST /uploads/batch/:batchId/approve` | same                                                      | approves every reviewable file; lists the skipped ones                  |
| `POST /uploads/:id/reject {reason}`    | owner or `MANAGE_UPLOADS`                                 | `REJECTED`, staging deleted                                             |
| `POST /uploads/:id/keep {reason?}`     | see above                                                 | `DUPLICATE` to `NEEDS_REVIEW`                                           |
| `POST /uploads/:id/reanalyze`          | owner or `MANAGE_UPLOADS`                                 | back to `RECEIVED`, re-run the analysis                                 |

A `targetRequestId` must reference a request in `AWAITING_UPLOAD`, `PROCESSING` or `APPROVED`: a
track request needs `tags.mbRecordingId` to equal its MBID, an album request needs
`tags.mbReleaseGroupId` to equal it, an artist request is refused. Anything else is
`400 invalid_target_request`. `null` clears the link. Another user's upload is always `404`.
