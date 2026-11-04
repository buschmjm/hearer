import { ApiError } from '../api/client.ts';

/** A friendly message for a failed catalog call (MusicBrainz down, rate limited, offline...). */
export function catalogErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'metadata_unavailable' || err.status === 502) {
      return 'The music catalog (MusicBrainz) is not answering right now. This is usually brief.';
    }
    if (err.status === 429) return 'You are searching very fast. Wait a few seconds and try again.';
    if (err.status === 404) return 'That item does not exist in the catalog.';
    if (err.status === 0) return err.message;
  }
  return 'Something went wrong while loading this page.';
}
