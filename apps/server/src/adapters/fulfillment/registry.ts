import type { SettingsService } from '../../services/settings.ts';
import { ManualProvider, MANUAL_PROVIDER_ID } from './manual.ts';
import type { FulfillmentProvider, RequestRecord } from './types.ts';

interface Entry {
  id: string;
  /** Whether the admin switched the provider on. */
  enabled: () => boolean;
  /** Builds the provider from the current settings (settings change at runtime). */
  build: () => FulfillmentProvider;
}

export interface SelectOptions {
  /** Provider ids to leave out, e.g. one that just asked to be skipped. */
  exclude?: readonly string[];
}

/**
 * Picks the provider for an approved request. Entries are tried in priority order; the first
 * enabled one that supports the request type wins. Manual is the last resort.
 */
export class FulfillmentRegistry {
  readonly #entries: Entry[];

  constructor(settings: SettingsService) {
    this.#entries = [
      {
        id: MANUAL_PROVIDER_ID,
        enabled: () => settings.get('fulfillment').manual.enabled,
        build: () => new ManualProvider(),
      },
    ];
  }

  /** Every known provider, enabled or not (for the settings UI). */
  list(): { provider: FulfillmentProvider; enabled: boolean }[] {
    return this.#entries.map((e) => ({ provider: e.build(), enabled: e.enabled() }));
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
