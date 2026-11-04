import type { UploadDto, UploadStatus } from '@hearer/shared';

export const STATUS_TONES: Record<UploadStatus, { label: string; tone: string }> = {
  RECEIVING: { label: 'Receiving', tone: 'bg-surface-2 text-muted' },
  RECEIVED: { label: 'Received', tone: 'bg-surface-2 text-muted' },
  ANALYZING: { label: 'Analyzing', tone: 'bg-accent-soft text-accent' },
  NEEDS_REVIEW: { label: 'Needs review', tone: 'bg-warn-soft text-warn' },
  APPROVED: { label: 'Approved', tone: 'bg-accent-soft text-accent' },
  IMPORTING: { label: 'Importing', tone: 'bg-accent-soft text-accent' },
  IMPORTED: { label: 'In library', tone: 'bg-success-soft text-success' },
  REJECTED: { label: 'Rejected', tone: 'bg-danger-soft text-danger' },
  DUPLICATE: { label: 'Duplicate', tone: 'bg-warn-soft text-warn' },
  FAILED: { label: 'Failed', tone: 'bg-danger-soft text-danger' },
};

export const statusLabel = (status: UploadStatus): string => STATUS_TONES[status].label;

export interface Group {
  key: string;
  batchId: string | null;
  items: UploadDto[];
}

/** Consecutive uploads that share a batch id are shown together (the list is newest first). */
export function groupByBatch(items: readonly UploadDto[]): Group[] {
  const groups: Group[] = [];
  const byBatch = new Map<string, Group>();
  for (const item of items) {
    if (item.batchId === null) {
      groups.push({ key: item.id, batchId: null, items: [item] });
      continue;
    }
    let group = byBatch.get(item.batchId);
    if (!group) {
      group = { key: item.batchId, batchId: item.batchId, items: [] };
      byBatch.set(item.batchId, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
