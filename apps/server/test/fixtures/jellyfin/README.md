# Jellyfin fixtures

**Synthesized, unverified against a live server.** These files were written by hand from the
Jellyfin 10.11 OpenAPI description and from memory of real responses. They have never been
recorded from a running Jellyfin. Fields not used by Hearer are trimmed or approximate, and
the `ProviderIds` keys on audio items (`MusicBrainzTrack` vs `MusicBrainzRecording`) are exactly
the thing that still needs checking.

To verify against a real server, run the opt-in live test (see `docs/ADAPTERS.md`,
"Live test"), then replace these files with sanitized recordings (remove tokens, real ids and
paths).

| File                        | Endpoint                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `system-info.json`          | `GET /System/Info`                                                                                      |
| `authenticate-by-name.json` | `POST /Users/AuthenticateByName` (regular user "alice")                                                 |
| `authenticate-admin.json`   | same, for a Jellyfin administrator                                                                      |
| `users.json`                | `GET /Users` (includes an admin and a disabled user)                                                    |
| `items-page-1.json`         | `GET /Items?...&StartIndex=0&Limit=3`: artist, album, track (Track key)                                 |
| `items-page-2.json`         | `GET /Items?...&StartIndex=3&Limit=3`: track (Recording key), untagged track, album with no ProviderIds |
