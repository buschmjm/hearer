import type { MatchCandidate } from '@hearer/shared';
import { CoverImage } from './CoverImage.tsx';
import { cx } from '../../lib/cx.ts';
import { durationDelta } from '../../lib/uploadFiles.ts';

export interface MatchPickerProps {
  candidates: readonly MatchCandidate[];
  selectedId: string | null;
  onSelect: (candidate: MatchCandidate) => void;
  /** Length of the uploaded file, to show how far each candidate is off. */
  fileDurationMs: number | null;
  disabled?: boolean;
}

const SOURCES = { acoustid: 'AcoustID', tags: 'File tags' } as const;

export function MatchPicker({
  candidates,
  selectedId,
  onSelect,
  fileDurationMs,
  disabled = false,
}: MatchPickerProps) {
  if (candidates.length === 0) {
    return (
      <p className="rounded-lg border border-line bg-surface-2 px-3 py-3 text-sm text-muted">
        No matches were found. Fill in the tags and MusicBrainz ids yourself, or re-run the
        analysis.
      </p>
    );
  }
  return (
    <ul role="radiogroup" aria-label="Match candidates" className="space-y-2">
      {candidates.map((c, index) => {
        const selected =
          c.id === selectedId && candidates.findIndex((x) => x.id === c.id) === index;
        const pct = Math.round(c.score * 100);
        const delta = durationDelta(c.lengthMs, fileDurationMs);
        const year = c.date?.slice(0, 4);
        return (
          <li key={`${c.id}-${String(index)}`}>
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => {
                onSelect(c);
              }}
              className={cx(
                'flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors',
                selected
                  ? 'border-accent bg-accent-soft'
                  : 'border-line bg-surface hover:border-muted/60',
                disabled && 'cursor-not-allowed opacity-70',
              )}
            >
              <CoverImage src={c.coverUrl} className="size-14 rounded-md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{c.title}</span>
                <span className="block truncate text-sm text-muted">
                  {c.artist} · {c.album}
                  {year ? ` (${year})` : ''}
                </span>
                <span className="mt-0.5 block text-xs text-muted">
                  Track {c.trackNumber}/{c.trackTotal}
                  {c.discTotal > 1 ? ` · disc ${String(c.discNumber)}/${String(c.discTotal)}` : ''}
                  {delta ? ` · ${delta}` : ''}
                  {' · '}
                  {c.sources.map((s) => SOURCES[s]).join(' + ')}
                </span>
                <span className="mt-2 flex items-center gap-2">
                  <span
                    role="meter"
                    aria-label={`Match score for ${c.title}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                    className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2"
                  >
                    <span
                      className={cx(
                        'block h-full',
                        pct >= 85 ? 'bg-success' : pct >= 60 ? 'bg-warn' : 'bg-danger',
                      )}
                      style={{ width: `${String(pct)}%` }}
                    />
                  </span>
                  <span className="w-10 text-right text-xs tabular-nums text-muted">{pct}%</span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
