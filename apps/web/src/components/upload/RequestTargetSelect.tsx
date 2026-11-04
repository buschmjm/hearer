import type { RequestDto } from '@hearer/shared';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { requestTargetsQuery } from '../../api/uploads.ts';

/** "This fulfills request ..." picker over the caller's requests that are waiting for a file. */
export function RequestTargetSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const { data } = useQuery(requestTargetsQuery());
  const items: RequestDto[] = data?.items ?? [];
  // A linked request that is no longer waiting still has to show up as the current choice.
  const known = value === null || items.some((r) => r.id === value);
  if (items.length === 0 && value === null) return null;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        Fulfills request
      </label>
      <select
        id={id}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value === '' ? null : event.target.value);
        }}
        className="block min-h-11 w-full rounded-lg border border-line bg-surface-2 px-3 text-base text-fg sm:text-sm"
      >
        <option value="">None</option>
        {!known && <option value={value}>Linked request</option>}
        {items.map((r) => (
          <option key={r.id} value={r.id}>
            {r.title}
            {r.artistName ? ` - ${r.artistName}` : ''} ({r.type})
          </option>
        ))}
      </select>
    </div>
  );
}
