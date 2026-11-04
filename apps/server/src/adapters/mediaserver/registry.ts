import { REDACTED_SECRET, type SettingsValue } from '@hearer/shared';
import type { SecretBox } from '../../lib/secrets.ts';
import type { SettingsService } from '../../services/settings.ts';
import { JellyfinAdapter } from './jellyfin.ts';
import { MediaServerNotConfiguredError, type MediaServerAdapter } from './types.ts';

export type MediaServerSettings = SettingsValue<'mediaServer'>;

export interface MediaServerFactoryDeps {
  /** Hearer version, reported to the server. */
  version: string;
  /** Stable per-install device id. */
  deviceId: string;
  timeoutMs?: number | undefined;
}

/** Build the adapter for a media server config. Throws when the URL or API key is missing. */
export function getMediaServer(
  config: MediaServerSettings,
  deps: MediaServerFactoryDeps,
): MediaServerAdapter {
  if (!config.url || !config.apiKey) {
    throw new MediaServerNotConfiguredError('The media server URL and API key are not set');
  }
  return new JellyfinAdapter({
    url: config.url,
    apiKey: config.apiKey,
    externalUrl: config.externalUrl,
    libraryIds: config.libraryIds,
    deviceId: deps.deviceId,
    version: deps.version,
    timeoutMs: deps.timeoutMs,
  });
}

/** Builds adapters from the stored settings; exposed to routes and jobs as `app.hearer.mediaServer`. */
export class MediaServerRegistry {
  readonly #settings: SettingsService;
  readonly #deps: MediaServerFactoryDeps;

  constructor(settings: SettingsService, secrets: SecretBox, version: string, timeoutMs?: number) {
    this.#settings = settings;
    this.#deps = {
      version,
      deviceId: `hearer-${secrets.deriveId('media-server-device').slice(0, 32)}`,
      timeoutMs,
    };
  }

  /** Whether a URL and API key are stored. */
  isConfigured(): boolean {
    const { url, apiKey } = this.#settings.get('mediaServer');
    return url !== '' && apiKey !== '';
  }

  /** The adapter for the stored settings. Throws MediaServerNotConfiguredError. */
  get(): MediaServerAdapter {
    return getMediaServer(this.#settings.get('mediaServer'), this.#deps);
  }

  /** An adapter for a candidate config (not saved). A masked API key means the stored one. */
  forCandidate(candidate: MediaServerSettings): MediaServerAdapter {
    const apiKey =
      candidate.apiKey === REDACTED_SECRET
        ? this.#settings.get('mediaServer').apiKey
        : candidate.apiKey;
    return getMediaServer({ ...candidate, apiKey }, this.#deps);
  }
}
