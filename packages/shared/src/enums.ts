/** Enumerations shared by the server schema, the API and the web UI. */

export const REQUEST_TYPES = ['track', 'album', 'artist'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const REQUEST_STATUSES = [
  'PENDING',
  'APPROVED',
  'PROCESSING',
  'AWAITING_UPLOAD',
  'PARTIALLY_AVAILABLE',
  'AVAILABLE',
  'DECLINED',
  'FAILED',
  'CANCELLED',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const UPLOAD_STATUSES = [
  'RECEIVING',
  'RECEIVED',
  'ANALYZING',
  'NEEDS_REVIEW',
  'APPROVED',
  'IMPORTING',
  'IMPORTED',
  'REJECTED',
  'DUPLICATE',
  'FAILED',
] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const AUTH_TYPES = ['local', 'jellyfin', 'oidc'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export const LIBRARY_ITEM_KINDS = ['artist', 'album', 'track'] as const;
export type LibraryItemKind = (typeof LIBRARY_ITEM_KINDS)[number];

export const NOTIFICATION_AGENTS = ['webhook', 'discord', 'slack', 'ntfy', 'smtp'] as const;
export type NotificationAgent = (typeof NOTIFICATION_AGENTS)[number];

export const NOTIFICATION_EVENTS = [
  'request.pending',
  'request.approved',
  'request.declined',
  'request.available',
  'request.failed',
  'upload.needs_review',
  'upload.imported',
  'upload.failed',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** Bit for a notification event, used in notification_targets.events. */
export function notificationEventBit(event: NotificationEvent): number {
  return 1 << NOTIFICATION_EVENTS.indexOf(event);
}

export function notificationEventsToMask(events: readonly NotificationEvent[]): number {
  return events.reduce((mask, event) => mask | notificationEventBit(event), 0);
}

export function notificationEventsFromMask(mask: number): NotificationEvent[] {
  return NOTIFICATION_EVENTS.filter((event) => (mask & notificationEventBit(event)) !== 0);
}
