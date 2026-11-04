/** Contracts for media server integrations (Jellyfin today; Navidrome/Plex later). */

export interface ServerInfo {
  /** The server's own id (Jellyfin `Id`). */
  id: string;
  name: string;
  version: string;
  /** False when the server is older than the minimum Hearer supports. */
  versionSupported: boolean;
  /** Human readable note when `versionSupported` is false. */
  warning?: string;
}

export interface ExternalUser {
  id: string;
  name: string;
  isAdmin: boolean;
  isDisabled?: boolean;
  email?: string;
}

export type LibraryItemKind = 'artist' | 'album' | 'track';

export interface LibraryItem {
  serverItemId: string;
  kind: LibraryItemKind;
  name: string;
  /** Track artist for tracks, album artist for albums, null for artists. */
  artistName: string | null;
  albumName: string | null;
  durationMs: number | null;
  /** MusicBrainz recording id (tracks only). */
  mbRecordingId: string | null;
  mbReleaseGroupId: string | null;
  mbArtistId: string | null;
  /** MusicBrainz release id (albums, and tracks that carry it). */
  mbAlbumId: string | null;
  /** Path as the media server sees it (may differ from Hearer's mount). */
  path: string | null;
  /** When the server first saw the item, if reported. */
  dateCreated: Date | null;
}

export interface IterateLibraryOptions {
  /** Only items the server saved after this instant (incremental sync). */
  since?: Date | undefined;
  /** Abort a long sync. */
  signal?: AbortSignal | undefined;
}

export interface MediaServerAdapter {
  id: 'jellyfin' | (string & {});
  testConnection(): Promise<ServerInfo>;
  /** Validate a user's credentials against the server (login flow). */
  authenticate(username: string, password: string): Promise<ExternalUser>;
  /** Users on the server (for import). */
  listUsers?(): Promise<ExternalUser[]>;
  /** Stream the library, in pages, for index sync. */
  iterateLibrary(opts: IterateLibraryOptions): AsyncIterable<LibraryItem>;
  /** Targeted rescan of these paths (falls back to a full refresh). */
  notifyPathsChanged(paths: string[]): Promise<void>;
  /** Full library scan. */
  refreshLibrary(): Promise<void>;
  /** Browser URL of an item ("Open in Jellyfin"). */
  itemUrl?(serverItemId: string): string;
}

/** Base class: anything that went wrong talking to the media server. */
export class MediaServerError extends Error {
  /** HTTP status when the server answered, otherwise undefined. */
  readonly status: number | undefined;
  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.status = status;
  }
}

/** Credentials (user password or API key) were rejected. */
export class MediaServerAuthError extends MediaServerError {}

/** The server could not be reached, timed out, or answered 5xx. */
export class MediaServerUnavailableError extends MediaServerError {}

/** Media server settings are incomplete (no URL / API key). */
export class MediaServerNotConfiguredError extends MediaServerError {}
