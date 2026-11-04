/**
 * A tiny typed in-process event bus. Services emit domain events after their database work has
 * committed; other parts of the app (notifications, H-21) subscribe. Listeners run
 * synchronously in registration order. A listener that throws (or rejects) is logged and
 * skipped: it can never break the flow that emitted the event or starve the other listeners.
 */
import type { RequestStatus, RequestType } from '@hearer/shared';

/** What every `request.*` event carries. */
export interface RequestEventPayload {
  requestId: string;
  type: RequestType;
  mbid: string;
  title: string;
  artistName: string | null;
  requestedBy: string;
  from: RequestStatus | null;
  to: RequestStatus;
  /** The user behind the change; null for the system. */
  actorId: string | null;
  note: string | null;
  declineReason: string | null;
}

/** Upload events are placeholders until the upload batches define their payloads. */
export interface UploadEventPayload {
  uploadId: string;
  uploaderId: string;
  detail?: string;
  batchId?: string | null;
  originalName?: string;
  title?: string | null;
  artist?: string | null;
  /** Top candidate score (needs_review) or duplicate reason, etc. */
  [extra: string]: unknown;
}

export interface HearerEvents {
  'request.created': RequestEventPayload;
  'request.approved': RequestEventPayload;
  'request.declined': RequestEventPayload;
  'request.available': RequestEventPayload;
  'request.partially_available': RequestEventPayload;
  'request.failed': RequestEventPayload;
  'request.cancelled': RequestEventPayload;
  'upload.needs_review': UploadEventPayload;
  'upload.duplicate': UploadEventPayload;
  'upload.imported': UploadEventPayload;
  'upload.failed': UploadEventPayload;
}

export type HearerEventName = keyof HearerEvents;
export type UploadEventName = Extract<HearerEventName, `upload.${string}`>;
export type Listener<K extends HearerEventName> = (
  payload: HearerEvents[K],
) => void | Promise<void>;

export interface EventLogger {
  error: (obj: object, msg: string) => void;
}

export class EventBus {
  readonly #listeners = new Map<HearerEventName, Set<Listener<never>>>();
  readonly #log: EventLogger;

  constructor(log: EventLogger) {
    this.#log = log;
  }

  /** Subscribe; returns the unsubscribe function. */
  on<K extends HearerEventName>(event: K, listener: Listener<K>): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /** Subscribe to several events with one listener. */
  onAny(
    events: readonly HearerEventName[],
    listener: (
      event: HearerEventName,
      payload: HearerEvents[HearerEventName],
    ) => void | Promise<void>,
  ): () => void {
    const offs = events.map((event) => this.on(event, (payload) => listener(event, payload)));
    return () => {
      for (const off of offs) off();
    };
  }

  listenerCount(event: HearerEventName): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  emit<K extends HearerEventName>(event: K, payload: HearerEvents[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    // Copy: a listener may unsubscribe itself while we iterate.
    for (const listener of [...set] as Listener<K>[]) {
      try {
        const result = listener(payload);
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            this.#log.error({ err, event }, 'event listener rejected');
          });
        }
      } catch (err) {
        this.#log.error({ err, event }, 'event listener threw');
      }
    }
  }
}
