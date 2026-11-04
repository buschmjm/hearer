import type { LidarrSettings } from '@hearer/shared';
import type { SettingsService } from '../../services/settings.ts';
import type { MetadataProvider } from '../metadata/types.ts';
import { LIDARR_PROVIDER_ID, LidarrProvider } from './lidarr.ts';
import { ManualProvider, MANUAL_PROVIDER_ID } from './manual.ts';
import type { FulfillmentProvider, RequestRecord } from './types.ts';

interface Entry {
  id: string;
  /** Path of the provider's block in the settings store, e.g. `fulfillment.lidarr`. */
  settingsPath: string;
  /** Whether the admin switched the provider on. */
  enabled: () => boolean;
  /** Builds the provider from the current settings (settings change at runtime). */
  build: () => FulfillmentProvider;
}

export interface SelectOptions {
  /** Provider ids to leave out, e.g. one that just asked to be skipped. */
  exclude?: readonly string[];
}

export interface FulfillmentRegistryDeps {
  settings: SettingsService;
  metadata: Pick<MetadataProvider, 'getRecording'>;
  version?: string | undefined;
  /** Lidarr HTTP tuning (tests). */
  lidarr?: { fetch?: typeof fetch | undefined; timeoutMs?: number | undefined } | undefined;
}

/**
 * Picks the provider for an approved request. Entries are tried in priority order and the
 * first enabled one that supports the request type wins: Lidarr (when switched on and able to
 * handle the type under its track policy), then Manual. When nothing qualifies `select` returns
 * null and the submit job fails the request with a note (see jobs/requestSubmit.ts).
 */
export class FulfillmentRegistry {
  readonly #entries: Entry[];
  readonly #deps: FulfillmentRegistryDeps;

  constructor(deps: FulfillmentRegistryDeps) {
    this.#deps = deps;
    const { settings } = deps;
    this.#entries = [
      {
        id: LIDARR_PROVIDER_ID,
        settingsPath: 'fulfillment.lidarr',
        enabled: () => settings.get('fulfillment').lidarr.enabled,
        build: () => this.lidarr(settings.get('fulfillment').lidarr),
      },
      {
        id: MANUAL_PROVIDER_ID,
        settingsPath: 'fulfillment.manual',
        enabled: () => settings.get('fulfillment').manual.enabled,
        build: () => new ManualProvider(settings.get('fulfillment').manual.enabled),
      },
    ];
  }

  /** A Lidarr provider for any config (the stored one, or a candidate being tested). */
  lidarr(config: LidarrSettings): LidarrProvider {
    return new LidarrProvider(config, {
      metadata: this.#deps.metadata,
      version: this.#deps.version,
      fetch: this.#deps.lidarr?.fetch,
      timeoutMs: this.#deps.lidarr?.timeoutMs,
    });
  }

  /** Every known provider, enabled or not (for the settings UI), in priority order. */
  list(): { provider: FulfillmentProvider; enabled: boolean; settingsPath: string }[] {
    return this.#entries.map((e) => ({
      provider: e.build(),
      enabled: e.enabled(),
      settingsPath: e.settingsPath,
    }));
  }

  /** A provider by id regardless of whether it is enabled (cancel and poll must still work). */
  get(id: string): FulfillmentProvider | undefined {
    return this.#entries.find((e) => e.id === id)?.build();
  }

  /** The provider that should take this request, or null when none is enabled and capable. */
  select(
    request: Pick<RequestRecord, 'type'>,
    options: SelectOptions = {},
  ): FulfillmentProvider | null {
    for (const entry of this.#entries) {
      if (options.exclude?.includes(entry.id) || !entry.enabled()) continue;
      const provider = entry.build();
      if (provider.supports[request.type]) return provider;
    }
    return null;
  }
}
