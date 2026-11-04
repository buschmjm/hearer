import type { ArtistCredit, RequestQuota, RequestStatus, RequestType } from '@hearer/shared';

/** 215000 -> "3:35"; 3_725_000 -> "1:02:05". Null/invalid -> an em dash. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${s}` : `${String(m)}:${s}`;
}

/** "1997-05-21" / "1997-05" / "1997" -> "1997". */
export function yearOf(date: string | null | undefined): string | null {
  const match = /^(\d{4})/.exec(date ?? '');
  return match?.[1] ?? null;
}

/** Cover Art Archive URLs end in `front-250`; ask for a bigger render. */
export function coverAtSize(url: string, size: 250 | 500 | 1200): string {
  return url.replace(/front-\d+$/, `front-${String(size)}`);
}

export function creditText(credits: readonly ArtistCredit[], fallback = ''): string {
  const text = credits.map((c) => `${c.name}${c.joinPhrase}`).join('');
  return text === '' ? fallback : text;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "3 days ago", "in 2 hours", "just now". */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diff = then - now;
  if (Math.abs(diff) < 45_000) return 'just now';
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(Math.round(diff / 60_000), 'minute');
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Catalog badges say "Requested" for a pending request; the queue says "Pending". */
export function requestStatusLabel(
  status: RequestStatus,
  context: 'catalog' | 'queue' = 'queue',
): string {
  switch (status) {
    case 'PENDING':
      return context === 'catalog' ? 'Requested' : 'Pending';
    case 'APPROVED':
      return 'Approved';
    case 'PROCESSING':
      return 'Processing';
    case 'AWAITING_UPLOAD':
      return 'Awaiting upload';
    case 'PARTIALLY_AVAILABLE':
      return 'Partially available';
    case 'AVAILABLE':
      return 'Available';
    case 'DECLINED':
      return 'Declined';
    case 'FAILED':
      return 'Failed';
    case 'CANCELLED':
      return 'Cancelled';
  }
}

export const REQUEST_TYPE_LABELS: Record<RequestType, string> = {
  track: 'Track',
  album: 'Album',
  artist: 'Artist',
};

/** Statuses from which the server accepts a move to CANCELLED (mirrors its transition table). */
export const CANCELLABLE_STATUSES: readonly RequestStatus[] = [
  'PENDING',
  'APPROVED',
  'PROCESSING',
  'AWAITING_UPLOAD',
  'PARTIALLY_AVAILABLE',
  'FAILED',
];

/** A request in one of these states holds its slot; asking again is a 409. */
export const ACTIVE_REQUEST_STATUSES: readonly RequestStatus[] = [
  'PENDING',
  'APPROVED',
  'PROCESSING',
  'AWAITING_UPLOAD',
  'PARTIALLY_AVAILABLE',
];

/** "3 of 5 requests left" / "Request limit reached", or null when unlimited. */
export function quotaSummary(quota: RequestQuota | undefined): string | null {
  if (!quota || quota.unlimited) return null;
  const remaining = quota.remaining ?? Math.max(0, quota.limit - quota.used);
  if (remaining <= 0) {
    const reset = quota.resetsAt ? ` Resets ${formatDateTime(quota.resetsAt)}.` : '';
    return `Request limit reached (${String(quota.limit)} per ${String(quota.days)} days).${reset}`;
  }
  return `${String(remaining)} of ${String(quota.limit)} requests left (per ${String(quota.days)} days)`;
}
